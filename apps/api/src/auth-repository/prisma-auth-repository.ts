import { randomUUID } from "node:crypto";

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
import { buildPersonalWorkspaceSlug } from "../lib/personal-workspace-slug.js";
import type {
  AuthRepository,
  PersonalWorkspaceState,
  PublicUserView,
  SellerParticipationAcceptanceRecord,
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
   * First-auth path: INSERT the Workspace with a placeholder slug so
   * Prisma's `@default(cuid())` generates the genuine Workspace
   * primary id, derive the final slug from that id, then UPDATE the
   * row to set the canonical slug. The whole sequence runs in a
   * single `$transaction` so the atomicity invariants hold:
   *   - Prisma generates the genuine cuid (the same value the rest
   *     of the schema uses via `@default(cuid())`).
   *   - The final slug equals `personal-<workspace.id>` exactly
   *     (the plan-approved invariant).
   *   - The compare-and-set on `personalWorkspaceId` is the atomic
   *     serialization point — losing it throws
   *     `ConvergenceRaceError` and rolls back the entire
   *     transaction (the placeholder-slug INSERT is undone).
   *   - The placeholder slug is unique per request (UUID-based) so
   *     it cannot collide with a previously-committed
   *     `personal-<cuid>` slug or another request's placeholder.
   */
  async createInitialPersonalWorkspace(input: {
    readonly userAccountId: string;
  }): Promise<{ readonly workspaceId: string; readonly slug: string }> {
    return this.prisma.$transaction(async (tx) => {
      const placeholderSlug = `personal-pending-${randomUUID()}`;

      // Step 1: INSERT with a placeholder slug. Prisma's
      // `@default(cuid())` emits the genuine Workspace id.
      const workspace = await tx.workspace.create({
        data: {
          slug: placeholderSlug,
          name: "My Workspace",
          type: "Personal",
          status: "Active",
          ownerUserId: input.userAccountId,
        },
      });

      // Step 2: derive the canonical slug from the just-inserted
      // Workspace id and UPDATE. The slug `personal-<workspace.id>`
      // is unique because workspace.id is unique (cuid).
      const slug = buildPersonalWorkspaceSlug(workspace.id);
      const updatedWorkspace = await tx.workspace.update({
        where: { id: workspace.id },
        data: { slug },
      });

      const membership = await tx.workspaceMembership.create({
        data: {
          userId: input.userAccountId,
          workspaceId: updatedWorkspace.id,
          role: "Owner",
        },
      });

      // Step 3: compare-and-set on `personalWorkspaceId`. The losing
      // UPDATE matches 0 rows → throw so the caller's transaction
      // rolls back and the Workspace + Membership rows are removed.
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
        coOwnedPersonalWorkspaceIds: new Set<string>(),
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

    // Workspace-side co-ownership gate: for every Personal Workspace
    // the user is an Owner of, count distinct Owner UserAccounts on
    // that workspace. Any workspace with > 1 distinct Owner UserAccount
    // is added to `coOwnedPersonalWorkspaceIds` so the convergence
    // service can block the otherwise-safe `attachable` / `converged`
    // classifications and surface `recovery(co-owned-personal-
    // workspace)` instead. This is the runtime defense for the
    // legacy cross-user ambiguity that the M2 migration's
    // workspace-side NOT EXISTS subquery guards at the database level.
    const coOwnedPersonalWorkspaceIds = new Set<string>();
    if (ownerPersonalMemberships.length > 0) {
      const candidateWorkspaceIds = ownerPersonalMemberships.map((m) => m.workspaceId);
      const coOwnershipRows = await this.prisma.workspaceMembership.findMany({
        where: {
          role: "Owner",
          workspaceId: { in: candidateWorkspaceIds },
          workspace: { type: "Personal" },
        },
        select: {
          workspaceId: true,
          userId: true,
        },
      });
      const distinctOwnersByWorkspace = new Map<string, Set<string>>();
      for (const row of coOwnershipRows) {
        const set = distinctOwnersByWorkspace.get(row.workspaceId) ?? new Set<string>();
        set.add(row.userId);
        distinctOwnersByWorkspace.set(row.workspaceId, set);
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

  // ---------- M2 #83: Intent selection primitives ----------

  /**
   * Idempotent capability upsert. The existing
   * `WorkspaceCapability` table already enforces
   * `(workspaceId, capability)` uniqueness via the
   * `workspace_capabilities_workspace_id_capability_key` index;
   * a concurrent insert of the same tuple is rejected by the
   * database. The upsert wrapper preserves idempotency without
   * relying on a find-then-insert pre-check.
   *
   * Caller invariant: the Workspace exists. The IntentService
   * revalidates current Owner membership before calling this
   * primitive (see `WorkspaceAuthorizationService`).
   */
  async upsertCapability(input: {
    readonly workspaceId: string;
    readonly capability: MarketplaceCapabilityV1;
  }): Promise<void> {
    await this.prisma.workspaceCapability.upsert({
      where: {
        workspaceId_capability: {
          workspaceId: input.workspaceId,
          capability: input.capability,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        capability: input.capability,
      },
      update: {},
    });
  }

  /**
   * Record a Seller participation acceptance row idempotently.
   * The natural unique index
   * `seller_participation_acceptances_workspace_version_unique_idx`
   * is the concurrency authority.
   *
   * `INSERT ... ON CONFLICT (workspace_id, terms_version) DO NOTHING
   * RETURNING *` is the atomic serialization point: a concurrent
   * second submission against the same (workspaceId, termsVersion)
   * absorbs the conflict and the application reads the existing row
   * back via a follow-up `findUnique`. The service treats that as
   * success — same row, same evidence, no duplicate.
   *
   * The application never calls this with `Buyer` capability. The
   * table name itself is the DB-level restriction.
   */
  async recordSellerParticipationAcceptance(input: {
    readonly workspaceId: string;
    readonly termsVersion: string;
    readonly termsContentHash: string;
    readonly acceptedByUserId: string;
    readonly grantedByUserId: string;
  }): Promise<SellerParticipationAcceptanceRecord> {
    const inserted = await this.prisma.$queryRaw<
      Array<{
        id: string;
        workspaceId: string;
        termsVersion: string;
        termsContentHash: string;
        acceptedByUserId: string;
        grantedByUserId: string;
        acceptedAt: Date;
      }>
    >`
      INSERT INTO "seller_participation_acceptances"
        ("id", "workspace_id", "terms_version", "terms_content_hash",
         "accepted_by_user_id", "granted_by_user_id", "accepted_at")
      VALUES (
        gen_random_uuid()::text,
        ${input.workspaceId}::text,
        ${input.termsVersion}::text,
        ${input.termsContentHash}::text,
        ${input.acceptedByUserId}::text,
        ${input.grantedByUserId}::text,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("workspace_id", "terms_version") DO NOTHING
      RETURNING
        "id",
        "workspace_id"      AS "workspaceId",
        "terms_version"     AS "termsVersion",
        "terms_content_hash" AS "termsContentHash",
        "accepted_by_user_id" AS "acceptedByUserId",
        "granted_by_user_id"  AS "grantedByUserId",
        "accepted_at"       AS "acceptedAt"
    `;
    if (inserted.length === 1) {
      const row = inserted[0]!;
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        termsVersion: row.termsVersion,
        termsContentHash: row.termsContentHash,
        acceptedByUserId: row.acceptedByUserId,
        grantedByUserId: row.grantedByUserId,
        acceptedAt: row.acceptedAt,
      };
    }
    // Lost the ON CONFLICT race: another concurrent submission
    // already inserted the row. Read it back and return the same
    // evidence — the unique constraint guarantees exactly one row
    // exists for this (workspaceId, termsVersion) tuple.
    const existing = await this.prisma.sellerParticipationAcceptance.findUnique({
      where: {
        workspaceId_termsVersion: {
          workspaceId: input.workspaceId,
          termsVersion: input.termsVersion,
        },
      },
    });
    if (!existing) {
      // Should be unreachable: the unique conflict guaranteed a
      // row exists. Throw closed so a malformed DB state cannot
      // silently no-op.
      throw new Error(
        `recordSellerParticipationAcceptance: ON CONFLICT path returned no row for ` +
          `workspaceId=${input.workspaceId} termsVersion=${input.termsVersion}`,
      );
    }
    return {
      id: existing.id,
      workspaceId: existing.workspaceId,
      termsVersion: existing.termsVersion,
      termsContentHash: existing.termsContentHash,
      acceptedByUserId: existing.acceptedByUserId,
      grantedByUserId: existing.grantedByUserId,
      acceptedAt: existing.acceptedAt,
    };
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
  SellerParticipationAcceptanceRecord,
  SessionRecord,
  UserIdentityMapping,
  WorkspaceMembershipView,
  MarketplaceCapabilityV1,
  WorkspaceMembershipRoleV1,
  WorkspaceStatusV1,
  WorkspaceTypeV1,
};
