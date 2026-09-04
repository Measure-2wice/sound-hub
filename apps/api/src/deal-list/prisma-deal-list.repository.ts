// Prisma adapter for DealListRepository (ticket #74).
//
// Background: this module is the only place the Deal-discovery list
// touches Prisma. Higher layers depend on `DealListRepository`; tests
// can swap in the in-memory adapter without changing the service or
// route code.
//
// Architectural split (mirroring the accepted BG5 adapter):
//
//   - The application owns the authorization policy (see
//     `./deal-list-authorization-policy.ts`). The repository never
//     decides whether the locked facts authorize the read.
//
//   - The repository owns the transaction boundary and the
//     locked-fact reads. Inside ONE `$transaction` it acquires
//     `SELECT ... FOR UPDATE` row locks on the EXACT commanded
//     Workspace row and the EXACT (authenticated user, commanded
//     Workspace) WorkspaceMembership row, hands the snapshot to the
//     application-supplied use case, and performs the private Deal
//     read only when the use case accepts.
//
// Why the locks matter: this is a private read, and membership can be
// revoked concurrently. Taking the membership row lock before reading
// Deals means a concurrent revocation either commits BEFORE the lock
// (the row is absent, the policy rejects, no Deal rows are read) or
// blocks until this transaction completes. There is no interleaving in
// which a revoked former member receives Deal rows.
//
// `ownerUserId` is never consulted. Membership is the only
// authorization signal (ADR-0001, ADR-0004).

import type { PrismaClient } from "@soundhub/db";
import type { DealListReadAuthoritySnapshot } from "./deal-list-authorization-policy.js";
import type {
  DealListRepository,
  ListDealsResult,
  ListDealsTransactionInput,
  ListDealsUseCase,
  ListDealsUseCaseTools,
  PersistedDealListRow,
} from "./deal-list.repository.js";

// Bounded discovery surface. Ticket #74 excludes pagination
// frameworks; the cap matches `listDealsResponseV1Schema`'s `.max(200)`
// so the adapter can never produce a payload the shared contract
// would reject.
const MAX_DEAL_LIST_ROWS = 200;

export class PrismaDealListRepository implements DealListRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listDealsForWorkspaceInTransaction(
    input: ListDealsTransactionInput,
    useCase: ListDealsUseCase,
  ): Promise<ListDealsResult> {
    return await this.prisma.$transaction(async (tx) => {
      // ---- Locked authorization facts -------------------------------
      //
      // Both locks are taken BEFORE any Deal row is read.
      const workspaceRows = await tx.$queryRaw<
        { readonly status: "Active" | "Suspended" }[]
      >`SELECT status FROM workspaces WHERE id = ${input.actingWorkspaceId} FOR UPDATE`;
      const actingWorkspaceStatus: "Active" | "Suspended" | null = workspaceRows[0]?.status ?? null;

      // The EXACT (userAccountId, workspaceId) tuple. A revoked
      // membership is represented by row absence, so an empty result
      // is the fail-closed signal.
      const membershipRows = await tx.$queryRaw<{ readonly id: string }[]>`
        SELECT id FROM workspace_memberships
        WHERE "userId" = ${input.actingUserAccountId}
          AND "workspaceId" = ${input.actingWorkspaceId}
        FOR UPDATE
      `;
      const actingUserIsMember = membershipRows.length > 0;

      const snapshot: DealListReadAuthoritySnapshot = {
        actingWorkspaceId: input.actingWorkspaceId,
        actingWorkspaceStatus,
        actingUserIsMember,
      };

      const tools: ListDealsUseCaseTools = {
        reject: (reason) => ({ kind: "reject" as const, reason }),
        accept: () => ({ kind: "accept" as const }),
      };
      const outcome = useCase({ snapshot }, tools);
      if (outcome.kind === "reject") {
        // No Deal row is read on the rejection path.
        return { ok: false as const, reason: outcome.reason };
      }

      // ---- Authorized private read ----------------------------------
      //
      // Scoped to Deals where the EXACT commanded Workspace is a
      // party. A member of an unrelated Workspace passes the policy
      // for their own Workspace but matches no Deals here.
      const deals = await tx.deal.findMany({
        where: {
          OR: [
            { buyerWorkspaceId: input.actingWorkspaceId },
            { sellerWorkspaceId: input.actingWorkspaceId },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: MAX_DEAL_LIST_ROWS,
        select: {
          id: true,
          buyerWorkspaceId: true,
          sellerWorkspaceId: true,
          status: true,
          activatedAt: true,
          createdAt: true,
          buyerWorkspace: { select: { name: true } },
          sellerWorkspace: { select: { name: true } },
          serviceOffering: { select: { title: true } },
          // Current TermsVersion only = MAX(version). Its approval
          // rows are the durable evidence the approval state is
          // derived from; approvals against superseded versions are
          // never loaded.
          termsVersions: {
            orderBy: { version: "desc" },
            take: 1,
            select: {
              id: true,
              version: true,
              approvals: { select: { workspaceId: true } },
            },
          },
          // Every intent for the Deal; the mapper keeps only the one
          // pinned to the current version. A stale intent against a
          // superseded version is durable but activation-insufficient
          // (BG6) and must not drive the displayed funding state.
          paymentIntents: {
            select: { termsVersionId: true, providerState: true },
          },
        },
      });

      const rows: PersistedDealListRow[] = deals.map((deal) => {
        const currentVersion = deal.termsVersions[0] ?? null;
        const currentIntent = currentVersion
          ? (deal.paymentIntents.find((intent) => intent.termsVersionId === currentVersion.id) ??
            null)
          : null;

        return {
          id: deal.id,
          buyerWorkspaceId: deal.buyerWorkspaceId,
          sellerWorkspaceId: deal.sellerWorkspaceId,
          status: deal.status,
          activatedAt: deal.activatedAt,
          createdAt: deal.createdAt,
          buyerWorkspaceName: deal.buyerWorkspace?.name ?? null,
          sellerWorkspaceName: deal.sellerWorkspace?.name ?? null,
          serviceOfferingTitle: deal.serviceOffering?.title ?? null,
          currentTermsVersionId: currentVersion?.id ?? null,
          currentTermsVersionNumber: currentVersion?.version ?? null,
          currentApprovalWorkspaceIds:
            currentVersion?.approvals.map((approval) => approval.workspaceId) ?? [],
          currentPaymentIntentState: currentIntent?.providerState ?? null,
        };
      });

      return { ok: true as const, value: rows };
    });
  }
}
