// Prisma adapter for the AuthRepository contract.
//
// Background: this module is the only place the auth boundary touches
// Prisma. Higher layers depend on `AuthRepository`; tests can swap in
// the in-memory adapter without changing the route or service code.
//
// ADR 0004: the (provider, subject) → UserAccount mapping is canonical
// here. The legacy `Workspace.ownerUserId` column is intentionally not
// read by the authorization path (see `WorkspaceAuthorizationService`)
// — it remains in the schema for M1.1 backward compatibility but
// grants no authority in any Golden Slice command.
//
// M2 #82: Personal Workspace convergence primitives. The repository
// owns the compare-and-set CREATE and ATTACH transactions. The slug
// helper lives in a server-only pure module (`personal-workspace-
// slug.ts`) so the persistence layer is the single owner of slug
// generation.

import type { PrismaClient } from "@soundhub/db";
import type {
  Bg1IdentityProviderV1,
  MarketplaceCapabilityV1,
  WorkspaceMembershipRoleV1,
  WorkspaceStatusV1,
  WorkspaceTypeV1,
} from "@soundhub/types";
import { ConvergenceRaceError } from "../lib/personal-workspace-convergence-domain.js";
import {
  buildPersonalWorkspaceSlug,
  generatePersonalWorkspaceCuid,
} from "../lib/personal-workspace-slug.js";
import type {
  AuthRepository,
  PersonalWorkspaceState,
  PublicUserView,
  SessionRecord,
  UserIdentityMapping,
  WorkspaceMembershipView,
} from "./auth-repository.js";

const BG1_PROVIDER_KEYS: ReadonlySet<Bg1IdentityProviderV1> = new Set([
  "managed-magic-link",
  "deterministic",
]);

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findUserByIdentity(input: {
    readonly provider: Bg1IdentityProviderV1;
    readonly subject: string;
  }): Promise<UserIdentityMapping | null> {
    assertBg1Provider(input.provider);
    const row = await this.prisma.identityProvider.findUnique({
      where: { provider_subject: { provider: input.provider, subject: input.subject } },
    });
    if (!row) return null;
    return {
      provider: input.provider,
      subject: input.subject,
      providerEmail: row.providerEmail,
      userAccountId: row.userAccountId,
    };
  }

  async createUserForIdentity(input: {
    readonly provider: Bg1IdentityProviderV1;
    readonly subject: string;
    readonly providerEmail: string | null;
  }): Promise<UserIdentityMapping> {
    assertBg1Provider(input.provider);
    // The (provider, subject) tuple is unique; if a concurrent request
    // already created the mapping, we surface the existing row rather
    // than racing a duplicate insert.
    const existing = await this.findUserByIdentity(input);
    if (existing) return existing;

    return this.prisma.$transaction(async (tx) => {
      // Application-owned verified linking rule (ticket #59 P1-001):
      // when a newly verified provider identity arrives for an email
      // that already exists in SoundHub, the new mapping attaches to
      // THAT UserAccount regardless of how many other IdentityProvider
      // mappings it already carry. A returning human changing
      // providers therefore keeps the same marketplace identity.
      let userId: string | null = null;
      if (input.providerEmail) {
        const matchingUser = await tx.userAccount.findUnique({
          where: { email: input.providerEmail },
        });
        if (matchingUser) {
          userId = matchingUser.id;
        }
      }

      let user: { readonly id: string };
      if (userId !== null) {
        user = await tx.userAccount.findUniqueOrThrow({ where: { id: userId } });
      } else {
        user = await tx.userAccount.create({
          data: { email: input.providerEmail },
        });
      }
      await tx.identityProvider.create({
        data: {
          provider: input.provider,
          subject: input.subject,
          providerEmail: input.providerEmail,
          userAccountId: user.id,
        },
      });
      return {
        provider: input.provider,
        subject: input.subject,
        providerEmail: input.providerEmail,
        userAccountId: user.id,
      };
    });
  }

  async getPublicUser(userAccountId: string): Promise<PublicUserView | null> {
    const user = await this.prisma.userAccount.findUnique({
      where: { id: userAccountId },
      include: {
        identityProviders: { orderBy: { createdAt: "asc" } },
        memberships: {
          include: {
            workspace: {
              include: { capabilities: { orderBy: { capability: "asc" } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!user) return null;
    const identity = user.identityProviders[0];
    if (!identity) {
      // A UserAccount without an identity provider mapping cannot
      // exist via the supported flows; surface the user as null so
      // the route produces the same 404 envelope rather than
      // leaking the inconsistency.
      return null;
    }
    if (!isBg1Provider(identity.provider)) {
      // Migrations or hand-edited rows could leave a non-BG1
      // provider key behind; reject rather than leak it.
      return null;
    }
    return {
      userAccountId: user.id,
      email: user.email,
      displayName: null,
      identityProvider: identity.provider,
      identitySubject: identity.subject,
      // The Personal Workspace surface carries `setupState` derived
      // server-side from the convergence service classification. The
      // mapper in `apps/api/src/dto/public-mappers.ts` reads this
      // value when shaping the public DTO.
      workspaces: user.memberships.map((membership) => ({
        workspaceId: membership.workspace.id,
        slug: membership.workspace.slug,
        name: membership.workspace.name,
        workspaceType: membership.workspace.type,
        workspaceStatus: membership.workspace.status,
        capabilities: membership.workspace.capabilities.map((c) => c.capability),
        role: membership.role,
        joinedAt: membership.createdAt,
      })),
    };
  }

  async getActiveSession(sessionId: string): Promise<SessionRecord | null> {
    const row = await this.prisma.authSession.findUnique({ where: { id: sessionId } });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return {
      sessionId: row.id,
      userAccountId: row.userAccountId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async createSession(input: { userAccountId: string; expiresAt: Date }): Promise<SessionRecord> {
    const row = await this.prisma.authSession.create({
      data: {
        userAccountId: input.userAccountId,
        expiresAt: input.expiresAt,
      },
    });
    return {
      sessionId: row.id,
      userAccountId: row.userAccountId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const result = await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }

  async findCurrentMembership(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
  }): Promise<WorkspaceMembershipView | null> {
    const row = await this.prisma.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId: input.userAccountId,
          workspaceId: input.workspaceId,
        },
      },
      include: {
        workspace: {
          include: { capabilities: { orderBy: { capability: "asc" } } },
        },
      },
    });
    if (!row) return null;
    return {
      workspaceId: row.workspace.id,
      slug: row.workspace.slug,
      name: row.workspace.name,
      workspaceType: row.workspace.type,
      workspaceStatus: row.workspace.status,
      capabilities: row.workspace.capabilities.map((c) => c.capability),
      role: row.role,
      joinedAt: row.createdAt,
    };
  }

  // ---------- M2 #82: Personal Workspace convergence primitives ----------

  /**
   * First-auth path: mint a cuid-shaped Workspace id via the
   * server-only helper, derive the slug from the SAME id (so
   * `slug === "personal-" + workspace.id`), create the Workspace +
   * Owner Membership atomically, and compare-and-set
   * `personalWorkspaceId`. The compare-and-set is the atomic
   * serialization point — losing it throws `ConvergenceRaceError`
   * so the caller can retry.
   *
   * The slug and the Workspace primary identifier are intrinsically
   * linked by design: the same value serves both. The repository
   * mints the id (so it can build the slug in the same
   * transaction) and persists it as the Workspace id.
   */
  async createInitialPersonalWorkspace(input: {
    readonly userAccountId: string;
  }): Promise<{ readonly workspaceId: string; readonly slug: string }> {
    return this.prisma.$transaction(async (tx) => {
      const workspaceId = generatePersonalWorkspaceCuid();
      const slug = buildPersonalWorkspaceSlug(workspaceId);

      const workspace = await tx.workspace.create({
        data: {
          id: workspaceId,
          slug,
          name: "My Workspace",
          type: "Personal",
          status: "Active",
          ownerUserId: input.userAccountId,
        },
      });
      const membership = await tx.workspaceMembership.create({
        data: {
          userId: input.userAccountId,
          workspaceId: workspace.id,
          role: "Owner",
        },
      });

      // Compare-and-set: only set personalWorkspaceId if it is
      // currently NULL. PostgreSQL serializes this UPDATE at the
      // row level. A losing UPDATE matches 0 rows → throw so the
      // caller's transaction rolls back (and the Workspace +
      // Membership rows are removed too).
      const updated = await tx.userAccount.updateMany({
        where: { id: input.userAccountId, personalWorkspaceId: null },
        data: { personalWorkspaceId: workspace.id },
      });
      if (updated.count === 0) {
        throw new ConvergenceRaceError(
          `createInitialPersonalWorkspace: CAS lost for userAccountId=${input.userAccountId}`,
        );
      }

      return { workspaceId: workspace.id, slug };
      // `membership` is consumed implicitly by the CAS; the
      // membershipId is returned from findPersonalWorkspaceState
      // when the caller re-reads.
      void membership;
    });
  }

  /**
   * Backfill-gap path: link an existing Personal Workspace to the
   * UserAccount via compare-and-set. The CAS is the atomic
   * serialization point.
   */
  async attachExistingPersonalWorkspace(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.userAccount.updateMany({
        where: { id: input.userAccountId, personalWorkspaceId: null },
        data: { personalWorkspaceId: input.workspaceId },
      });
      if (updated.count === 0) {
        throw new ConvergenceRaceError(
          `attachExistingPersonalWorkspace: CAS lost for userAccountId=${input.userAccountId}`,
        );
      }
    });
  }

  /**
   * Read the raw Personal Workspace state. Pure read; does not write.
   * The repository returns the data; the convergence service
   * classifies it. This keeps classification and persistence on
   * different layers per the approved M2 #82 architecture.
   */
  async findPersonalWorkspaceState(input: {
    readonly userAccountId: string;
  }): Promise<PersonalWorkspaceState> {
    const user = await this.prisma.userAccount.findUnique({
      where: { id: input.userAccountId },
      include: {
        memberships: {
          where: { role: "Owner" },
          include: { workspace: true },
        },
      },
    });
    if (!user) {
      // Caller invariant: the UserAccount exists by the time this
      // method is called. A missing row is a programmer error the
      // service surfaces as `none` (the auth service must have
      // called createUserForIdentity first). Defensive: do not throw.
      return {
        userExists: false,
        personalWorkspaceId: null,
        ownerPersonalMemberships: [],
        pointedWorkspace: null,
        membershipOnPointedWorkspace: null,
      };
    }

    const ownerPersonalMemberships = user.memberships
      .filter((m) => m.workspace.type === "Personal")
      .map((m) => ({ membershipId: m.id, workspaceId: m.workspaceId }));

    const pointerId = user.personalWorkspaceId;

    let pointedWorkspace: PersonalWorkspaceState["pointedWorkspace"] = null;
    let membershipOnPointedWorkspace: PersonalWorkspaceState["membershipOnPointedWorkspace"] = null;

    if (pointerId !== null) {
      const pointed = await this.prisma.workspace.findUnique({
        where: { id: pointerId },
      });
      if (pointed) {
        pointedWorkspace = { id: pointed.id, type: pointed.type };
        const anyMembership = await this.prisma.workspaceMembership.findUnique({
          where: {
            userId_workspaceId: {
              userId: user.id,
              workspaceId: pointerId,
            },
          },
        });
        if (anyMembership) {
          membershipOnPointedWorkspace = {
            id: anyMembership.id,
            role: anyMembership.role,
          };
        }
      }
    }

    return {
      userExists: true,
      personalWorkspaceId: pointerId,
      ownerPersonalMemberships,
      pointedWorkspace,
      membershipOnPointedWorkspace,
    };
  }

  /**
   * Read a single Workspace slug by id. Used by the convergence
   * service's CAS-loss retry path to surface the winner's slug.
   */
  async findWorkspaceSlugById(workspaceId: string): Promise<string | null> {
    const row = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    });
    return row?.slug ?? null;
  }
}

function assertBg1Provider(provider: string): asserts provider is Bg1IdentityProviderV1 {
  if (!isBg1Provider(provider)) {
    throw new Error(
      `Identity provider "${provider}" is not declared in the BG1 contract; refusing to persist`,
    );
  }
}

function isBg1Provider(provider: string): provider is Bg1IdentityProviderV1 {
  return BG1_PROVIDER_KEYS.has(provider as Bg1IdentityProviderV1);
}

// Type-only re-exports for higher layers that want to consume the
// specific view types without re-importing them. Keeps the file
// self-contained without forcing callers to know the path layout.
export type {
  PublicUserView,
  SessionRecord,
  UserIdentityMapping,
  WorkspaceMembershipView,
  MarketplaceCapabilityV1,
  WorkspaceMembershipRoleV1,
  WorkspaceStatusV1,
  WorkspaceTypeV1,
};
