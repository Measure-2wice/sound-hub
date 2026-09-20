// In-memory AuthRepository for unit tests.
//
// Background: the auth service and authorization service tests run
// without a database. The in-memory adapter mirrors the Prisma
// adapter's contract surface so tests can substitute it without
// changing the higher layers. It is intentionally simple — the
// Prisma adapter is the canonical implementation and the
// authorization behaviour under test lives in
// `WorkspaceAuthorizationService`, not here.
//
// M2 #82: the in-memory adapter mirrors the Personal Workspace
// convergence primitives. The compare-and-set UPDATE is simulated
// with a single-threaded lock + re-read, which is sufficient for
// unit tests.

import { randomUUID } from "node:crypto";
import type {
  Bg1IdentityProviderV1,
  MarketplaceCapabilityV1,
  WorkspaceMembershipRoleV1,
  WorkspaceStatusV1,
  WorkspaceTypeV1,
} from "@soundhub/types";
import { ConvergenceRaceError } from "../lib/personal-workspace-convergence-domain.js";
import { buildPersonalWorkspaceSlug } from "../lib/personal-workspace-slug.js";
import type {
  AuthRepository,
  PersonalWorkspaceState,
  PublicUserView,
  SessionRecord,
  UserIdentityMapping,
  WorkspaceMembershipView,
} from "./auth-repository.js";

export interface InMemoryMembershipSeed {
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly workspaceType: WorkspaceTypeV1;
  readonly workspaceStatus: WorkspaceStatusV1;
  readonly role: WorkspaceMembershipRoleV1;
  readonly capabilities: readonly MarketplaceCapabilityV1[];
}

export interface InMemoryUserSeed {
  readonly userAccountId: string;
  readonly email?: string | null;
  readonly displayName?: string | null;
  readonly identityProvider: Bg1IdentityProviderV1;
  readonly identitySubject: string;
  readonly memberships: readonly InMemoryMembershipSeed[];
}

interface InternalWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  type: WorkspaceTypeV1;
  status: WorkspaceStatusV1;
  ownerUserId: string;
  capabilities: MarketplaceCapabilityV1[];
}

interface InternalMembership {
  readonly id: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceMembershipRoleV1;
  createdAt: Date;
}

interface InternalUser {
  email: string | null;
  personalWorkspaceId: string | null;
  identityProvider: Bg1IdentityProviderV1;
  identitySubject: string;
}

export class InMemoryAuthRepository implements AuthRepository {
  private readonly usersByIdentity = new Map<string, UserIdentityMapping>();
  private readonly usersById = new Map<string, InternalUser>();
  private readonly workspacesById = new Map<string, InternalWorkspace>();
  private readonly membershipsByUserWorkspace = new Map<string, InternalMembership>();
  private readonly membershipsById = new Map<string, InternalMembership>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly nowFn: () => number;

  constructor(seeds: readonly InMemoryUserSeed[] = [], now: () => number = () => Date.now()) {
    this.nowFn = now;
    for (const seed of seeds) {
      const mapping: UserIdentityMapping = {
        provider: seed.identityProvider,
        subject: seed.identitySubject,
        providerEmail: seed.email ?? null,
        userAccountId: seed.userAccountId,
      };
      this.usersByIdentity.set(`${seed.identityProvider}|${seed.identitySubject}`, mapping);
      this.usersById.set(seed.userAccountId, {
        email: seed.email ?? null,
        personalWorkspaceId: null,
        identityProvider: seed.identityProvider,
        identitySubject: seed.identitySubject,
      });
      for (const m of seed.memberships) {
        // Preserve a workspace that is already seeded (e.g. by an
        // earlier seed for a different UserAccount) so co-ownership
        // fixtures do not have the second seed's `ownerUserId`
        // clobber the first one's metadata. The first seed's
        // metadata wins; subsequent seeds only contribute their
        // membership row.
        const existingWorkspace = this.workspacesById.get(m.workspaceId);
        const workspace: InternalWorkspace = existingWorkspace ?? {
          id: m.workspaceId,
          slug: m.slug,
          name: m.name,
          type: m.workspaceType,
          status: m.workspaceStatus,
          ownerUserId: seed.userAccountId,
          capabilities: [...m.capabilities],
        };
        this.workspacesById.set(workspace.id, workspace);
        const internalMembership: InternalMembership = {
          id: randomUUID(),
          userId: seed.userAccountId,
          workspaceId: m.workspaceId,
          role: m.role,
          createdAt: new Date(this.nowFn()),
        };
        this.membershipsByUserWorkspace.set(
          `${seed.userAccountId}|${m.workspaceId}`,
          internalMembership,
        );
        this.membershipsById.set(internalMembership.id, internalMembership);
      }
    }
  }

  async findUserByIdentity(input: {
    provider: Bg1IdentityProviderV1;
    subject: string;
  }): Promise<UserIdentityMapping | null> {
    return Promise.resolve(this.usersByIdentity.get(`${input.provider}|${input.subject}`) ?? null);
  }

  async createUserForIdentity(input: {
    provider: Bg1IdentityProviderV1;
    subject: string;
    providerEmail: string | null;
  }): Promise<UserIdentityMapping> {
    const existing = await this.findUserByIdentity(input);
    if (existing) return existing;
    let userAccountId: string | null = null;
    if (input.providerEmail) {
      for (const candidate of this.usersById.values()) {
        if (candidate.email === input.providerEmail) {
          for (const [id, u] of this.usersById.entries()) {
            if (u === candidate) {
              userAccountId = id;
              break;
            }
          }
          break;
        }
      }
    }
    if (!userAccountId) {
      userAccountId = randomUUID();
      this.usersById.set(userAccountId, {
        email: input.providerEmail,
        personalWorkspaceId: null,
        identityProvider: input.provider,
        identitySubject: input.subject,
      });
    }
    const mapping: UserIdentityMapping = {
      provider: input.provider,
      subject: input.subject,
      providerEmail: input.providerEmail,
      userAccountId,
    };
    this.usersByIdentity.set(`${input.provider}|${input.subject}`, mapping);
    return mapping;
  }

  async getPublicUser(userAccountId: string): Promise<PublicUserView | null> {
    const user = this.usersById.get(userAccountId);
    if (!user) return null;
    const workspaces: WorkspaceMembershipView[] = [];
    for (const membership of this.membershipsById.values()) {
      if (membership.userId !== userAccountId) continue;
      const workspace = this.workspacesById.get(membership.workspaceId);
      if (!workspace) continue;
      workspaces.push(this.toMembershipView(membership, workspace));
    }
    return Promise.resolve({
      userAccountId,
      email: user.email,
      displayName: null,
      identityProvider: user.identityProvider,
      identitySubject: user.identitySubject,
      workspaces,
    });
  }

  async getActiveSession(sessionId: string): Promise<SessionRecord | null> {
    const row = this.sessions.get(sessionId);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= this.nowFn()) return null;
    return Promise.resolve(row);
  }

  async createSession(input: { userAccountId: string; expiresAt: Date }): Promise<SessionRecord> {
    const id = randomUUID();
    const row: SessionRecord = {
      sessionId: id,
      userAccountId: input.userAccountId,
      createdAt: new Date(this.nowFn()),
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.set(id, row);
    return Promise.resolve(row);
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const row = this.sessions.get(sessionId);
    if (!row) return false;
    if (row.revokedAt) return false;
    this.sessions.set(sessionId, { ...row, revokedAt: new Date(this.nowFn()) });
    return Promise.resolve(true);
  }

  async findCurrentMembership(input: {
    userAccountId: string;
    workspaceId: string;
  }): Promise<WorkspaceMembershipView | null> {
    const membership = this.membershipsByUserWorkspace.get(
      `${input.userAccountId}|${input.workspaceId}`,
    );
    if (!membership) return Promise.resolve(null);
    const workspace = this.workspacesById.get(membership.workspaceId);
    if (!workspace) return Promise.resolve(null);
    return Promise.resolve(this.toMembershipView(membership, workspace));
  }

  // ---------- M2 #82: Personal Workspace convergence primitives ----------

  /**
   * Simulates the Prisma compare-and-set transaction. In a single-
   * threaded test environment the CAS always succeeds for the first
   * caller; the unit tests can stage a collision manually by
   * pre-populating `personalWorkspaceId` to force the loser path.
   */
  async createInitialPersonalWorkspace(input: {
    userAccountId: string;
  }): Promise<{ workspaceId: string; slug: string }> {
    const user = this.usersById.get(input.userAccountId);
    if (!user) {
      throw new Error(`InMemoryAuthRepository: unknown userAccountId=${input.userAccountId}`);
    }
    if (user.personalWorkspaceId !== null) {
      // Simulate the CAS losing. The caller (convergence service)
      // catches and retries via `findPersonalWorkspaceState`.
      throw new ConvergenceRaceError(
        `createInitialPersonalWorkspace: CAS lost for userAccountId=${input.userAccountId}`,
      );
    }
    // The in-memory adapter mirrors the real Prisma adapter: the
    // Workspace id is a cuid-shaped identifier matching the same
    // `^c[a-z0-9]+$` shape Prisma's @default(cuid()) emits, so the
    // `slug === "personal-" + workspace.id` invariant and the slug
    // regex shape hold in the test double. We strip hyphens from a
    // UUID and prepend `c` so the result mirrors Prisma's cuid
    // shape (no real cuid library is used; this is a test double).
    // The placeholder is unique per request (UUID-based) so it
    // cannot collide with previously-committed slugs.
    const workspaceId = `c${randomUUID().replace(/-/g, "")}`;
    const placeholderSlug = `personal-pending-${randomUUID()}`;
    const slug = buildPersonalWorkspaceSlug(workspaceId);
    const workspace: InternalWorkspace = {
      id: workspaceId,
      slug,
      name: "My Workspace",
      type: "Personal",
      status: "Active",
      ownerUserId: input.userAccountId,
      capabilities: [],
    };
    this.workspacesById.set(workspace.id, workspace);
    void placeholderSlug; // placeholder is unused after the in-memory "update"
    const membership: InternalMembership = {
      id: randomUUID(),
      userId: input.userAccountId,
      workspaceId: workspace.id,
      role: "Owner",
      createdAt: new Date(this.nowFn()),
    };
    this.membershipsByUserWorkspace.set(`${input.userAccountId}|${workspace.id}`, membership);
    this.membershipsById.set(membership.id, membership);
    user.personalWorkspaceId = workspace.id;
    return Promise.resolve({ workspaceId: workspace.id, slug });
  }

  async attachExistingPersonalWorkspace(input: {
    userAccountId: string;
    workspaceId: string;
  }): Promise<void> {
    const user = this.usersById.get(input.userAccountId);
    if (!user) {
      throw new Error(`InMemoryAuthRepository: unknown userAccountId=${input.userAccountId}`);
    }
    if (user.personalWorkspaceId !== null) {
      throw new ConvergenceRaceError(
        `attachExistingPersonalWorkspace: CAS lost for userAccountId=${input.userAccountId}`,
      );
    }
    user.personalWorkspaceId = input.workspaceId;
    return Promise.resolve();
  }

  async findPersonalWorkspaceState(input: {
    userAccountId: string;
  }): Promise<PersonalWorkspaceState> {
    await Promise.resolve();
    const user = this.usersById.get(input.userAccountId);
    if (!user) {
      return {
        userExists: false,
        personalWorkspaceId: null,
        ownerPersonalMemberships: [],
        pointedWorkspace: null,
        membershipOnPointedWorkspace: null,
        coOwnedPersonalWorkspaceIds: new Set<string>(),
      };
    }
    const ownerPersonalMemberships: { membershipId: string; workspaceId: string }[] = [];
    for (const membership of this.membershipsById.values()) {
      if (membership.userId !== input.userAccountId) continue;
      if (membership.role !== "Owner") continue;
      const workspace = this.workspacesById.get(membership.workspaceId);
      if (!workspace) continue;
      if (workspace.type !== "Personal") continue;
      ownerPersonalMemberships.push({
        membershipId: membership.id,
        workspaceId: membership.workspaceId,
      });
    }

    const pointerId = user.personalWorkspaceId;
    let pointedWorkspace: PersonalWorkspaceState["pointedWorkspace"] = null;
    let membershipOnPointedWorkspace: PersonalWorkspaceState["membershipOnPointedWorkspace"] = null;

    if (pointerId !== null) {
      const pointed = this.workspacesById.get(pointerId);
      if (pointed) {
        pointedWorkspace = { id: pointed.id, type: pointed.type };
        const anyMembership = this.membershipsByUserWorkspace.get(
          `${input.userAccountId}|${pointerId}`,
        );
        if (anyMembership) {
          membershipOnPointedWorkspace = {
            id: anyMembership.id,
            role: anyMembership.role,
          };
        }
      }
    }

    // Workspace-side co-ownership gate: for every Personal Workspace
    // the user is an Owner of, count distinct Owner UserAccounts on
    // that workspace across all in-memory membership rows. Mirrors
    // the Prisma adapter's workspace-side check.
    const coOwnedPersonalWorkspaceIds = new Set<string>();
    if (ownerPersonalMemberships.length > 0) {
      const distinctOwnersByWorkspace = new Map<string, Set<string>>();
      for (const membership of this.membershipsById.values()) {
        if (membership.role !== "Owner") continue;
        const workspace = this.workspacesById.get(membership.workspaceId);
        if (!workspace || workspace.type !== "Personal") continue;
        const set = distinctOwnersByWorkspace.get(membership.workspaceId) ?? new Set<string>();
        set.add(membership.userId);
        distinctOwnersByWorkspace.set(membership.workspaceId, set);
      }
      for (const [workspaceId, owners] of distinctOwnersByWorkspace) {
        if (owners.size > 1) {
          coOwnedPersonalWorkspaceIds.add(workspaceId);
        }
      }
    }

    return {
      userExists: true,
      personalWorkspaceId: pointerId,
      ownerPersonalMemberships,
      pointedWorkspace,
      membershipOnPointedWorkspace,
      coOwnedPersonalWorkspaceIds,
    };
  }

  async findWorkspaceSlugById(workspaceId: string): Promise<string | null> {
    return Promise.resolve(this.workspacesById.get(workspaceId)?.slug ?? null);
  }

  private toMembershipView(
    membership: InternalMembership,
    workspace: InternalWorkspace,
  ): WorkspaceMembershipView {
    return {
      workspaceId: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      workspaceType: workspace.type,
      workspaceStatus: workspace.status,
      capabilities: [...workspace.capabilities],
      role: membership.role,
      joinedAt: membership.createdAt,
    };
  }
}
