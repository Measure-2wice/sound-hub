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
import { IntentConflictError } from "./auth-repository.js";

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

  // ---------- M2 #83: Intent selection primitives ----------
  //
  // Per-Workspace serialization queue. The Prisma adapter uses
  // `pg_advisory_xact_lock` to serialize intent transitions per
  // Workspace; the in-memory adapter mirrors that contract with
  // a chained Promise queue keyed by `workspaceId`. Each new
  // intent transition awaits the previous transition's tail
  // before running, so two concurrent disjoint first
  // submissions serialize and the second observes the first's
  // committed state.
  private readonly intentTransitionLocks = new Map<string, Promise<unknown>>();

  /**
   * M2 #83: symmetric in-memory implementation of the Prisma
   * expected-state intent primitive.
   *
   * Mirrors the Prisma adapter's contract:
   *
   *   - The command is additive only.
   *   - A per-Workspace mutex queue serializes intent
   *     transitions, equivalent to
   *     `pg_advisory_xact_lock`.
   *   - A snapshot/restore block enforces transaction-level
   *     atomicity (a thrown step rolls capability writes back
   *     to the pre-call state), equivalent to Prisma's
   *     `$transaction` rollback.
   *
   * #83 re-revision: intent does NOT collect a generic Seller
   * participation/terms acceptance at capability-provisioning
   * time. Context-specific confirmations are owned by their
   * later boundaries.
   */
  async provisionIntentAtomically(input: {
    readonly workspaceId: string;
    readonly userAccountId: string;
    readonly capabilities: readonly MarketplaceCapabilityV1[];
    readonly expectedCapabilities: readonly MarketplaceCapabilityV1[];
  }): Promise<void> {
    // Per-Workspace serialization: chain this call onto the
    // previous transition's tail so concurrent callers observe
    // a strict FIFO order. The Prisma adapter achieves the
    // same ordering via `pg_advisory_xact_lock` inside the
    // transaction.
    const previous = this.intentTransitionLocks.get(input.workspaceId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined) // never propagate a predecessor's failure into the next caller
      .then(() => this.runProvisionIntentAtomically(input));
    // Park the tail so the NEXT caller chains onto this one.
    // Use a defensive `.catch` so a future caller that awaits
    // `this.intentTransitionLocks.get(...)` directly does not
    // see an unhandled rejection.
    this.intentTransitionLocks.set(
      input.workspaceId,
      run.catch(() => undefined),
    );
    await run;
  }

  private async runProvisionIntentAtomically(input: {
    readonly workspaceId: string;
    readonly userAccountId: string;
    readonly capabilities: readonly MarketplaceCapabilityV1[];
    readonly expectedCapabilities: readonly MarketplaceCapabilityV1[];
  }): Promise<void> {
    // Mirror the Prisma adapter's atomic shape: an `await` so
    // the linter's require-await rule sees a real awaitable
    // path. The snapshot/restore block below mirrors the
    // Prisma `$transaction` rollback on failure.
    await Promise.resolve();

    const workspace = this.workspacesById.get(input.workspaceId);
    if (!workspace) {
      throw new Error(
        `InMemoryAuthRepository.provisionIntentAtomically: unknown workspaceId=${input.workspaceId}`,
      );
    }
    const beforeCapabilities = [...workspace.capabilities];

    const existing: readonly MarketplaceCapabilityV1[] = [...workspace.capabilities];

    const transition = deriveIntentTransition({
      existing,
      chosen: input.capabilities,
      expected: input.expectedCapabilities,
    });

    if (transition.kind === "conflict") {
      throw new IntentConflictError(
        "Intent precondition mismatch: the persisted capability set does not match the state observed when this command was submitted.",
        transition.existing,
        transition.expected,
        transition.existing,
      );
    }

    if (transition.kind === "no-op") {
      // Idempotent success — zero writes.
      return;
    }

    try {
      for (const capability of transition.addition) {
        applyCapabilityUpsert(workspace, capability);
      }
    } catch (err) {
      // Roll back capability changes so a mid-write failure
      // cannot leave the Workspace with partial capability state.
      workspace.capabilities = beforeCapabilities;
      throw err;
    }
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

/**
 * Apply a single capability upsert to an in-memory workspace.
 * Module-local helper — intentionally NOT exposed on the
 * `InMemoryAuthRepository` class. Only the atomic
 * `provisionIntentAtomically` primitive calls it. There is no
 * public capability-primitive surface that could be called
 * outside the atomic transaction.
 */
function applyCapabilityUpsert(
  workspace: InternalWorkspace,
  capability: MarketplaceCapabilityV1,
): void {
  if (!workspace.capabilities.includes(capability)) {
    workspace.capabilities.push(capability);
    workspace.capabilities.sort();
  }
}

/**
 * Derive the additive transition for an intent command. Mirrors
 * the Prisma adapter's module-local helper so transition
 * semantics are identical in unit tests and the real database.
 *
 * Returns one of three shapes:
 *
 *   - `{ kind: "no-op" }` when the chosen set is already a
 *     subset of the persisted set (idempotent success).
 *   - `{ kind: "write", addition }` when persisted `existing`
 *     matches `expected` and the command writes `chosen −
 *     existing` rows.
 *   - `{ kind: "conflict", existing, expected, fresh }` when
 *     persisted `existing` differs from `expected`; the
 *     transaction rolls back.
 */
type IntentTransition =
  | { readonly kind: "no-op" }
  | {
      readonly kind: "write";
      readonly addition: readonly MarketplaceCapabilityV1[];
    }
  | {
      readonly kind: "conflict";
      readonly existing: readonly MarketplaceCapabilityV1[];
      readonly expected: readonly MarketplaceCapabilityV1[];
    };

function deriveIntentTransition(input: {
  readonly existing: readonly MarketplaceCapabilityV1[];
  readonly chosen: readonly MarketplaceCapabilityV1[];
  readonly expected: readonly MarketplaceCapabilityV1[];
}): IntentTransition {
  const existing = [...input.existing].sort();
  const chosen = [...input.chosen].sort();
  const expected = [...input.expected].sort();

  if (isSubset(chosen, existing)) {
    return { kind: "no-op" };
  }

  if (!arrayEqual(existing, expected)) {
    return { kind: "conflict", existing, expected };
  }

  const addition = chosen.filter((capability) => !existing.includes(capability));
  return { kind: "write", addition };
}

function isSubset(
  candidate: readonly MarketplaceCapabilityV1[],
  container: readonly MarketplaceCapabilityV1[],
): boolean {
  for (const value of candidate) {
    if (!container.includes(value)) return false;
  }
  return true;
}

function arrayEqual(
  a: readonly MarketplaceCapabilityV1[],
  b: readonly MarketplaceCapabilityV1[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
