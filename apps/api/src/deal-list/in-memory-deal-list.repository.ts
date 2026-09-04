// In-memory adapter for DealListRepository (ticket #74).
//
// Background: the service tests need a repository seam that is fast
// and deterministic but NOT permissive. This adapter therefore runs
// the SAME authorization boundary as the Prisma adapter: it assembles
// the identical snapshot and hands it to the same application-owned
// use case, and it reads Deal rows only when the use case accepts.
//
// A fake that returned rows without evaluating the policy would make
// the service tests prove nothing about authorization, which is
// exactly what ticket #74 asks them to prove. The in-memory store
// stands in for PostgreSQL rows, not for the authorization decision.
//
// The lock semantics of the Prisma adapter have no in-memory analogue
// (there is no concurrency here); the disposable-PostgreSQL repository
// test is the evidence for the locked behavior.

import type { DealStatusV1 } from "@soundhub/types";
import type { DealListReadAuthoritySnapshot } from "./deal-list-authorization-policy.js";
import type {
  DealListRepository,
  ListDealsResult,
  ListDealsTransactionInput,
  ListDealsUseCase,
  ListDealsUseCaseTools,
  PersistedDealListRow,
} from "./deal-list.repository.js";

export interface InMemoryWorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly status: "Active" | "Suspended";
}

export interface InMemoryMembershipRow {
  readonly userId: string;
  readonly workspaceId: string;
}

export interface InMemoryDealRow {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly status: DealStatusV1;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
  readonly serviceOfferingTitle: string | null;
  readonly currentTermsVersionId: string | null;
  readonly currentTermsVersionNumber: number | null;
  readonly currentApprovalWorkspaceIds?: readonly string[];
  readonly currentPaymentIntentState?: "Created" | "Confirmed" | "Failed" | null;
}

export interface InMemoryDealListState {
  readonly workspaces: readonly InMemoryWorkspaceRow[];
  readonly memberships: readonly InMemoryMembershipRow[];
  readonly deals: readonly InMemoryDealRow[];
}

export class InMemoryDealListRepository implements DealListRepository {
  private state: InMemoryDealListState;

  constructor(state: InMemoryDealListState) {
    this.state = state;
  }

  /** Test helper: replace the store, e.g. to revoke a membership. */
  setState(state: InMemoryDealListState): void {
    this.state = state;
  }

  // Not `async`: the store is synchronous, so the method builds the
  // result directly and wraps it once at each return. The contract
  // still returns a Promise so callers cannot tell the adapters apart.
  listDealsForWorkspaceInTransaction(
    input: ListDealsTransactionInput,
    useCase: ListDealsUseCase,
  ): Promise<ListDealsResult> {
    const workspace =
      this.state.workspaces.find((row) => row.id === input.actingWorkspaceId) ?? null;
    const actingUserIsMember = this.state.memberships.some(
      (row) =>
        row.userId === input.actingUserAccountId && row.workspaceId === input.actingWorkspaceId,
    );

    const snapshot: DealListReadAuthoritySnapshot = {
      actingWorkspaceId: input.actingWorkspaceId,
      actingWorkspaceStatus: workspace?.status ?? null,
      actingUserIsMember,
    };

    const tools: ListDealsUseCaseTools = {
      reject: (reason) => ({ kind: "reject" as const, reason }),
      accept: () => ({ kind: "accept" as const }),
    };
    const outcome = useCase({ snapshot }, tools);
    if (outcome.kind === "reject") {
      return Promise.resolve({ ok: false as const, reason: outcome.reason });
    }

    const nameOf = (workspaceId: string): string | null =>
      this.state.workspaces.find((row) => row.id === workspaceId)?.name ?? null;

    const rows: PersistedDealListRow[] = this.state.deals
      .filter(
        (deal) =>
          deal.buyerWorkspaceId === input.actingWorkspaceId ||
          deal.sellerWorkspaceId === input.actingWorkspaceId,
      )
      .slice()
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((deal) => ({
        id: deal.id,
        buyerWorkspaceId: deal.buyerWorkspaceId,
        sellerWorkspaceId: deal.sellerWorkspaceId,
        status: deal.status,
        activatedAt: deal.activatedAt,
        createdAt: deal.createdAt,
        buyerWorkspaceName: nameOf(deal.buyerWorkspaceId),
        sellerWorkspaceName: nameOf(deal.sellerWorkspaceId),
        serviceOfferingTitle: deal.serviceOfferingTitle,
        currentTermsVersionId: deal.currentTermsVersionId,
        currentTermsVersionNumber: deal.currentTermsVersionNumber,
        currentApprovalWorkspaceIds: deal.currentApprovalWorkspaceIds ?? [],
        currentPaymentIntentState: deal.currentPaymentIntentState ?? null,
      }));

    return Promise.resolve({ ok: true as const, value: rows });
  }
}
