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
  SessionRecord,
  UserIdentityMapping,
  WorkspaceMembershipView,
} from "./auth-repository.js";
import { IntentConflictError } from "./auth-repository.js";

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
   * M2 #83: atomic, expected-state intent provisioning.
   *
   * Sequence inside one `$transaction`:
   *
   *   1. `pg_advisory_xact_lock(hashtext('intent:' ||
   *      workspaceId))` — Workspace-scoped lock held for the
   *      lifetime of the transaction. Concurrent disjoint first
   *      submissions (e.g., simultaneous Hire and Offer on the
   *      same empty Personal Workspace) serialize on this lock;
   *      the loser's transaction then observes the winner's
   *      committed row and conflicts — never silently unions.
   *   2. Read the persisted capability rows for the Workspace.
   *   3. Compute the additive transition via
   *      `deriveIntentTransition`. If the chosen set is already
   *      a subset of the persisted set, the transaction commits
   *      with zero writes (idempotent success). Otherwise, the
   *      persisted `existing` MUST equal the request's
   *      `expectedCapabilities` (sorted); a mismatch throws
   *      `IntentConflictError` and the transaction rolls back.
   *   4. Insert the additive `addition` rows via
   *      `INSERT ... ON CONFLICT DO NOTHING` — the natural
   *      `(workspaceId, capability)` unique index absorbs
   *      duplicate rows when an idempotent retry races a
   *      concurrent commit.
   *
   * The natural unique index is the single source of row-level
   * idempotency inside the lock. The lock is the single source of
   * decision-level serialization.
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
    await this.prisma.$transaction(async (tx) => {
      // Step 1: Workspace-scoped advisory lock. Released
      // automatically on COMMIT / ROLLBACK by PostgreSQL. The
      // hash key is namespaced ('intent:') so the lock space
      // does not collide with other features that may adopt
      // advisory locks in later milestones.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${"intent:" + input.workspaceId}::text))
      `;

      // Step 2: read persisted capabilities inside the same
      // transaction (consistent with subsequent writes).
      const existingRows = await tx.workspaceCapability.findMany({
        where: { workspaceId: input.workspaceId },
        select: { capability: true },
      });
      const existing: readonly MarketplaceCapabilityV1[] = existingRows
        .map((r) => r.capability)
        .sort();

      // Step 3: derive the additive transition. Returns either
      // a no-op, a write plan, or a conflict signal.
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
        // Idempotent success — zero writes. The command is a
        // no-op when the chosen set is already fully covered
        // by the persisted set.
        return;
      }

      // Step 4: write the additive rows. The natural unique
      // index absorbs duplicates when an idempotent retry
      // races a concurrent commit; the in-transaction advisory
      // lock guarantees the read-then-write decision is
      // consistent, but row-level idempotency is the database's
      // responsibility.
      for (const capability of transition.addition) {
        await tx.$executeRaw`
          INSERT INTO "workspace_capabilities" ("id", "workspaceId", "capability")
          VALUES (gen_random_uuid()::text, ${input.workspaceId}, ${capability}::"MarketplaceCapability")
          ON CONFLICT ("workspaceId", "capability") DO NOTHING
        `;
      }
    });
  }
}

/**
 * Derive the additive transition for an intent command under
 * the Workspace-scoped lock.
 *
 * The command is additive only: it adds the chosen capability
 * set to whatever is already present. A later-add
 * (`[Buyer] + Offer → Both`) is the same primitive as initial
 * selection (`[] + Both → Both`).
 *
 * Returns one of three shapes:
 *
 *   - `{ kind: "no-op" }` when the chosen set is already a
 *     subset of the persisted set. Idempotent success —
 *     zero writes, the transaction commits cleanly.
 *
 *   - `{ kind: "write", addition }` when the persisted
 *     `existing` exactly matches the request's
 *     `expectedCapabilities` (sorted). `addition` is the
 *     set-difference `chosen − existing`, the rows the
 *     command will insert.
 *
 *   - `{ kind: "conflict", existing, expected, fresh }` when
 *     the persisted `existing` differs from
 *     `expectedCapabilities`. The transaction MUST roll back;
 *     `fresh` is the post-write state the command WOULD have
 *     produced (i.e., `existing ∪ chosen`) so the UI can
 *     surface both the persisted reality and the requested
 *     addition.
 *
 * Idempotency invariant: a stale `expectedCapabilities`
 * produces idempotent success (not a conflict) when the chosen
 * set is already fully covered. The conflict signal ONLY fires
 * when the customer would otherwise silently miss a write.
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

  // Set membership: every chosen element must already be in
  // existing for a no-op. Sorted-array equality is sufficient
  // because MarketplaceCapabilityV1 is a closed enum with two
  // members; we walk both arrays in lockstep.
  if (isSubset(chosen, existing)) {
    return { kind: "no-op" };
  }

  // Precondition: the customer observed `expected` when they
  // submitted. If the persisted set no longer matches, the
  // transition is unsafe — surface the conflict so the
  // customer can re-submit with the up-to-date precondition.
  if (!arrayEqual(existing, expected)) {
    return { kind: "conflict", existing, expected };
  }

  // Write plan: insert the additive delta (chosen − existing).
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
