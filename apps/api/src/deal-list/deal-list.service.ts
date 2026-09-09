// DealList service (ticket #74).
//
// Background: ticket #74 makes Deals discoverable from signed-in
// navigation. This service is the single application boundary for the
// private, Workspace-scoped Deal list.
//
// Authorization ownership: the service supplies a pure use-case
// closure that consumes the FOR UPDATE-locked snapshot the repository
// reads inside its transaction and returns an accept/reject verdict
// from `evaluateDealListReadAuthority`. The repository never decides
// policy; the service never touches Prisma.
//
// The authorization proof and the private read share ONE transaction
// on purpose. A pre-check followed by an independent query would let a
// membership revocation commit in between and leak private Deal rows
// to a former member.
//
// Derived state: approval completeness and the slim funding status are
// computed server-side by the pure helpers in
// `./deal-list-derivation.ts` from durable BG5 approval rows and the
// BG6 PaymentIntent pinned to the current TermsVersion. The client
// never reconstructs them.

import type { DealListItemPublicV1 } from "@soundhub/types";
import { evaluateDealListReadAuthority } from "./deal-list-authorization-policy.js";
import { deriveApprovalState, deriveListFundingStatus } from "./deal-list-derivation.js";
import type {
  DealListRepository,
  ListDealsUseCaseOutcome,
  ListDealsUseCaseTools,
  PersistedDealListRow,
} from "./deal-list.repository.js";
import type { DealListReadAuthoritySnapshot } from "./deal-list-authorization-policy.js";

export type DealListErrorCode = "DEAL_LIST_FORBIDDEN";

export class DealListError extends Error {
  constructor(
    message: string,
    readonly code: DealListErrorCode,
  ) {
    super(message);
    this.name = "DealListError";
  }
}

export interface ListDealsInput {
  /** The authenticated human, from the session cookie. Never trusted from the body. */
  readonly userAccountId: string;
  /** The EXACT acting Workspace the caller commanded. */
  readonly actingWorkspaceId: string;
}

export interface DealListServiceDeps {
  readonly repository: DealListRepository;
}

/**
 * Application-owned use case. Evaluates the locked snapshot through
 * the pure policy and translates the verdict into the repository's
 * accept/reject tools.
 */
function evaluateListUseCase(
  ctx: { readonly snapshot: DealListReadAuthoritySnapshot },
  tools: ListDealsUseCaseTools,
): ListDealsUseCaseOutcome {
  const verdict = evaluateDealListReadAuthority(ctx.snapshot);
  if (!verdict.ok) {
    return tools.reject(verdict.reason);
  }
  return tools.accept();
}

/**
 * Map one persisted row onto the allow-listed public list item.
 *
 * Field-by-field by design: no spread of the persisted row, so a
 * future column added to `PersistedDealListRow` cannot leak into the
 * public DTO. Workspace ids are consumed here (to determine the acting
 * side and match approvals) and deliberately not emitted.
 */
function toPublicListItem(
  row: PersistedDealListRow,
  actingWorkspaceId: string,
): DealListItemPublicV1 {
  const isBuyerSide = row.buyerWorkspaceId === actingWorkspaceId;

  const approvalState = deriveApprovalState({
    currentTermsVersionId: row.currentTermsVersionId,
    approvingWorkspaceIds: row.currentApprovalWorkspaceIds,
    buyerWorkspaceId: row.buyerWorkspaceId,
    sellerWorkspaceId: row.sellerWorkspaceId,
  });

  const fundingStatus = deriveListFundingStatus({
    approvalState,
    currentPaymentIntentState: row.currentPaymentIntentState,
  });

  return {
    dealId: row.id,
    status: row.status,
    actingSide: isBuyerSide ? "Buyer" : "Seller",
    // The counterparty is the OTHER side from the acting Workspace.
    counterpartyWorkspaceName: isBuyerSide ? row.sellerWorkspaceName : row.buyerWorkspaceName,
    serviceOfferingTitle: row.serviceOfferingTitle,
    currentTermsVersion: row.currentTermsVersionNumber,
    approvalState,
    fundingStatus,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DealListService {
  constructor(private readonly deps: DealListServiceDeps) {}

  /**
   * List the Deals discoverable through the acting Workspace.
   *
   * Fails closed with `DEAL_LIST_FORBIDDEN` when the Workspace does
   * not exist, is not Active, or the authenticated human is not a
   * current member of that EXACT Workspace. The single opaque code
   * means the caller cannot distinguish those cases.
   *
   * A member of an unrelated Workspace is authorized for their OWN
   * Workspace and simply receives an empty list — the scoped read
   * matches no Deals.
   */
  async listDeals(input: ListDealsInput): Promise<{
    readonly deals: readonly DealListItemPublicV1[];
  }> {
    const result = await this.deps.repository.listDealsForWorkspaceInTransaction(
      {
        actingWorkspaceId: input.actingWorkspaceId,
        actingUserAccountId: input.userAccountId,
      },
      (ctx, tools) => evaluateListUseCase(ctx, tools),
    );

    if (!result.ok) {
      throw new DealListError("You cannot view Deals for this Workspace.", "DEAL_LIST_FORBIDDEN");
    }

    return {
      deals: result.value.map((row) => toPublicListItem(row, input.actingWorkspaceId)),
    };
  }
}
