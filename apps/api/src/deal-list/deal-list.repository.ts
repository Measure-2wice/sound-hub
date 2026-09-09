// Deal-list repository contract (ticket #74).
//
// Background: ticket #74 adds a private, Workspace-scoped Deal
// discovery list. The contract is the only surface the service layer
// depends on; the Prisma adapter is the canonical implementation and
// is the only place that touches the database directly.
//
// The contract exposes a single transaction-scoped use case so
// authorization and the private read happen in ONE authoritative unit
// of work:
//
//   listDealsForWorkspaceInTransaction opens one transaction and
//   acquires `SELECT ... FOR UPDATE` row locks on the EXACT commanded
//   Workspace row and the EXACT (authenticated user, commanded
//   Workspace) WorkspaceMembership row, then hands the locked snapshot
//   to the application-owned use case. The use case evaluates
//   `evaluateDealListReadAuthority` and either accepts or rejects. The
//   adapter performs the scoped Deal read ONLY when the use case
//   accepts; a rejection returns no rows.
//
// This mirrors `DealTermsRepository.findDealViewInTransaction`. It is
// deliberately NOT a plain `listDeals(workspaceId)` read guarded by a
// separate service pre-check: a membership revocation committing
// between an independent check and an independent query would leak
// private Deal rows.

import type { DealStatusV1 } from "@soundhub/types";
import type { DealListReadAuthoritySnapshot } from "./deal-list-authorization-policy.js";

// ---------- Persistence shape ----------

/**
 * One Deal row joined with the display context and the derived-state
 * inputs the service needs. Workspace ids are retained here (the
 * service needs them to determine the acting side and to match
 * approvals) but are NOT part of the public list DTO.
 */
export interface PersistedDealListRow {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly status: DealStatusV1;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
  /**
   * Display context loaded from the referenced rows. Null when the
   * referenced row could not be loaded; the UI renders a stable
   * placeholder rather than fabricating a label.
   */
  readonly buyerWorkspaceName: string | null;
  readonly sellerWorkspaceName: string | null;
  readonly serviceOfferingTitle: string | null;
  /** Current TermsVersion = MAX(version) for the Deal. */
  readonly currentTermsVersionId: string | null;
  readonly currentTermsVersionNumber: number | null;
  /**
   * Workspace ids holding a DealApproval row against the CURRENT
   * TermsVersion only. Approvals against superseded versions are
   * excluded by the query.
   */
  readonly currentApprovalWorkspaceIds: readonly string[];
  /**
   * Provider state of the PaymentIntent pinned to the CURRENT
   * TermsVersion. Null when none exists for that version.
   */
  readonly currentPaymentIntentState: "Created" | "Confirmed" | "Failed" | null;
}

// ---------- Use case ----------

export type ListDealsFailureReason = "DEAL_LIST_FORBIDDEN";

export type ListDealsResult =
  | { readonly ok: true; readonly value: readonly PersistedDealListRow[] }
  | { readonly ok: false; readonly reason: ListDealsFailureReason };

export interface ListDealsTransactionInput {
  /** The EXACT Workspace id the caller commanded. */
  readonly actingWorkspaceId: string;
  /** The EXACT authenticated UserAccount id. Never an ownerUserId. */
  readonly actingUserAccountId: string;
}

export type ListDealsUseCaseOutcome =
  | { readonly kind: "reject"; readonly reason: ListDealsFailureReason }
  | { readonly kind: "accept" };

export interface ListDealsUseCaseTools {
  reject(reason: ListDealsFailureReason): ListDealsUseCaseOutcome;
  /**
   * The use case acknowledges that the locked snapshot authorizes the
   * private read. The repository performs the scoped read from the
   * locks it already holds; the use case is policy-only and never
   * carries persisted data.
   */
  accept(): ListDealsUseCaseOutcome;
}

export type ListDealsUseCase = (
  ctx: { readonly snapshot: DealListReadAuthoritySnapshot },
  tools: ListDealsUseCaseTools,
) => ListDealsUseCaseOutcome;

export interface DealListRepository {
  /**
   * Authorized read of one Workspace's Deals. Opens one transaction,
   * FOR UPDATE-locks the EXACT commanded Workspace row and the EXACT
   * (authenticated user, commanded Workspace) WorkspaceMembership
   * row, then hands the locked snapshot to the application-owned use
   * case.
   *
   * The adapter reads Deals only when the use case accepts, and the
   * read is scoped to Deals where the commanded Workspace is the
   * buyer or seller party. Ordering is `createdAt DESC`.
   *
   * A revoked member fails closed: the membership row is absent, so
   * `actingUserIsMember` is false and the policy rejects before any
   * Deal row is read.
   */
  listDealsForWorkspaceInTransaction(
    input: ListDealsTransactionInput,
    useCase: ListDealsUseCase,
  ): Promise<ListDealsResult>;
}
