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
//   - createProjectRequest persists a Pending request.
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

export interface CreateProjectRequestInput {
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
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

export interface ProjectRequestRepository {
  /**
   * Persist a new Pending ProjectRequest. Throws when a Pending row
   * already exists for the same (buyer, seller, offering, brief)
   * tuple — the partial unique index in PostgreSQL enforces this.
   */
  createProjectRequest(input: CreateProjectRequestInput): Promise<PersistedProjectRequest>;

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
