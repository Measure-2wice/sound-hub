// ProjectRequest + Deal repository contract.
//
// Background: ticket #62 (BG4 of the Buildathon Golden Slice)
// requires a persistence boundary for ProjectRequest and the Deal
// that follows an accepted request. The contract is the only surface
// the service layer depends on; the Prisma adapter is the canonical
// implementation and is the only place that touches the database
// directly. Higher layers (service, route) consume the contract
// exclusively.
//
// The contract deliberately exposes the operations the application
// service needs without leaking Prisma types:
//
//   - createProjectRequestWithRevalidation persists a Pending
//     request. The brief lookup, brief-ownership check, brief-
//     recommendation check (P1-001), offering eligibility check,
//     and the INSERT all run inside a single PostgreSQL
//     transaction (P1-002). The repository owns every direct
//     SQL/Prisma read and write — the service does NOT touch
//     Prisma (P1-003).
//   - findProjectRequestById loads one (used by view + decide).
//   - listProjectRequests lists Pending requests for the seller
//     inbox (and accepted/declined views for audit, though BG4 ships
//     only the Pending view as the required UI surface).
//   - acceptProjectRequest atomically transitions Pending→Accepted
//     AND creates the Negotiating Deal in a single transaction. The
//     guarded updateMany on the Pending status fails closed if the
//     request was already responded to (a retry cannot create a
//     second Deal). The unique constraint on `projectRequestId`
//     catches any race that bypasses the guarded update.
//   - declineProjectRequest atomically transitions Pending→Declined
//     and records the seller decision. No Deal is created.

import type { ProjectRequestStatusV1, DealStatusV1 } from "@soundhub/types";

export interface PersistedProjectRequest {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly createdByUserId: string;
  readonly status: ProjectRequestStatusV1;
  readonly sellerDecisionAt: Date | null;
  readonly sellerDecisionByUserId: string | null;
  readonly sellerConsentAt: Date | null;
  readonly createdAt: Date;
}

export interface PersistedDeal {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly projectRequestId: string;
  readonly status: DealStatusV1;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateProjectRequestRevalidatedInput {
  readonly buyerWorkspaceId: string;
  readonly projectBriefId: string;
  readonly serviceOfferingId: string;
  readonly createdByUserId: string;
}

export interface AcceptProjectRequestInput {
  readonly projectRequestId: string;
  readonly sellerDecisionByUserId: string;
  readonly now: Date;
}

export interface DeclineProjectRequestInput {
  readonly projectRequestId: string;
  readonly sellerDecisionByUserId: string;
  readonly now: Date;
}

export interface AcceptProjectRequestResult {
  readonly projectRequest: PersistedProjectRequest;
  readonly deal: PersistedDeal;
}

export type DecideFailureReason = "NOT_FOUND" | "ALREADY_RESPONDED";

export type DecideResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DecideFailureReason };

/**
 * Failure reasons for {@link ProjectRequestRepository.createProjectRequestWithRevalidation}.
 * The repository runs every revalidation step + the INSERT inside one
 * transaction; a stale or ineligible state at any step fails closed
 * without leaving a partial ProjectRequest row.
 */
export type CreateProjectRequestFailureReason =
  | "BRIEF_NOT_FOUND"
  | "BRIEF_FORBIDDEN"
  | "OFFERING_NOT_IN_BRIEF"
  | "OFFERING_INELIGIBLE"
  | "ALREADY_PENDING";

export type CreateProjectRequestResult =
  | { readonly ok: true; readonly value: PersistedProjectRequest }
  | { readonly ok: false; readonly reason: CreateProjectRequestFailureReason };

export interface ProjectRequestRepository {
  /**
   * Atomically revalidate the brief-ownership / brief-recommendation
   * boundary and the offering-eligibility chain, then persist a
   * Pending ProjectRequest. The entire operation runs inside a
   * single Prisma `$transaction` so a concurrent mutation between
   * the read of the BriefSearchResult, the eligibility lookup,
   * and the INSERT cannot produce an ineligible Pending request
   * (P1-002). Returns `{ok:false,...}` for any revalidation
   * failure without leaving a partial ProjectRequest row.
   *
   * Failure reasons:
   *   - `BRIEF_NOT_FOUND` — the ProjectBrief id does not exist.
   *   - `BRIEF_FORBIDDEN` — the ProjectBrief is owned by a
   *      different buyer Workspace than the one the caller is
   *      acting through.
   *   - `OFFERING_NOT_IN_BRIEF` — the selected ServiceOffering
   *      was not returned by the brief's persisted Matchmaker
   *      recommendations (P1-001). A buyer cannot submit an
   *      arbitrary eligible offering that the buyer never saw.
   *   - `OFFERING_INELIGIBLE` — the selected offering (or its
   *      owning Workspace / SellerProfile) is no longer in the
   *      eligibility chain (Active workspace + Seller capability
   *      + Published profile + Active offering).
   *   - `ALREADY_PENDING` — a Pending ProjectRequest already
   *      exists for the same tuple. The partial unique index
   *      enforces this; retries return this reason instead of
   *      creating a duplicate.
   */
  createProjectRequestWithRevalidation(
    input: CreateProjectRequestRevalidatedInput,
  ): Promise<CreateProjectRequestResult>;

  findProjectRequestById(projectRequestId: string): Promise<PersistedProjectRequest | null>;

  /**
   * List ProjectRequests whose buyerWorkspaceId OR sellerWorkspaceId
   * matches `workspaceId`, ordered by createdAt desc. Optional
   * `statusFilter` narrows to one status (used by the seller inbox
   * to show only Pending requests). Membership authorization is the
   * caller's responsibility; this method only filters by workspace.
   */
  listProjectRequests(input: {
    readonly workspaceId: string;
    readonly statusFilter?: ProjectRequestStatusV1;
  }): Promise<readonly PersistedProjectRequest[]>;

  /**
   * Atomically transition the named ProjectRequest from Pending to
   * Accepted and create the Negotiating Deal. Returns
   * `{ok:false,reason:"NOT_FOUND"}` when the row is missing,
   * `{ok:false,reason:"ALREADY_RESPONDED"}` when the row is not in
   * Pending status (already Accepted or Declined). The guarded
   * updateMany prevents two concurrent accepts from both succeeding;
   * the unique index on `deals.projectRequestId` is the second
   * defense.
   */
  acceptProjectRequest(
    input: AcceptProjectRequestInput,
  ): Promise<DecideResult<AcceptProjectRequestResult>>;

  /**
   * Atomically transition the named ProjectRequest from Pending to
   * Declined and record the seller decision. Same failure reasons as
   * {@link acceptProjectRequest}. No Deal is created.
   */
  declineProjectRequest(
    input: DeclineProjectRequestInput,
  ): Promise<DecideResult<PersistedProjectRequest>>;
}
