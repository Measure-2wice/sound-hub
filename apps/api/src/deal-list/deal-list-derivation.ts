// Deal-list state derivation (ticket #74).
//
// Background: neither approval state nor a list-level funding state is
// persisted as a column. BG5 represents approval as DealApproval row
// existence per (termsVersionId, workspaceId); BG6 represents funding
// as a PaymentIntent pinned to a (Deal, TermsVersion) pair. The
// discovery list needs one closed enum for each, derived server-side
// so the client never reconstructs authorization-adjacent state.
//
// Both functions are pure: they operate only on rows the caller
// already holds and consult no external state.

import type { DealApprovalStateV1, DealListFundingStatusV1 } from "@soundhub/types";

/**
 * Provider state of the PaymentIntent pinned to the CURRENT
 * TermsVersion, mirroring the Prisma `PaymentIntentProviderState`
 * enum. Null when no intent exists for that version yet.
 */
export type CurrentPaymentIntentState = "Created" | "Confirmed" | "Failed" | null;

export interface ApprovalStateInput {
  /** Null when the Deal has no TermsVersion yet. */
  readonly currentTermsVersionId: string | null;
  /**
   * Workspace ids that have a DealApproval row against the CURRENT
   * TermsVersion. Approvals against superseded versions are excluded
   * by the caller's query — a material edit creates a new version and
   * invalidates prior approvals.
   */
  readonly approvingWorkspaceIds: readonly string[];
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
}

/**
 * Derive the closed approval-state enum from durable approval rows.
 *
 * Per the BG spec: "The application derives approval completeness from
 * durable approval records. AI output, UI state, provider metadata,
 * and one party's approval cannot synthesize the other party's
 * approval." Each side is evaluated independently.
 */
export function deriveApprovalState(input: ApprovalStateInput): DealApprovalStateV1 {
  if (input.currentTermsVersionId === null) {
    return "NoTerms";
  }
  const approvals = new Set(input.approvingWorkspaceIds);
  const buyerApproved = approvals.has(input.buyerWorkspaceId);
  const sellerApproved = approvals.has(input.sellerWorkspaceId);

  if (buyerApproved && sellerApproved) {
    return "BothApproved";
  }
  if (buyerApproved) {
    return "AwaitingSellerApproval";
  }
  if (sellerApproved) {
    return "AwaitingBuyerApproval";
  }
  return "AwaitingBothApprovals";
}

export interface ListFundingStatusInput {
  readonly approvalState: DealApprovalStateV1;
  /**
   * Provider state of the PaymentIntent pinned to the CURRENT
   * TermsVersion only. A stale intent against a superseded version is
   * durable but activation-insufficient (BG6), so the caller must not
   * pass it here.
   */
  readonly currentPaymentIntentState: CurrentPaymentIntentState;
}

/**
 * Derive the slim, discovery-sufficient funding status.
 *
 * Funding is not applicable until BOTH parties have approved the same
 * current TermsVersion — BG6 forbids initiating funding for an
 * unapproved, superseded, or non-current version — so every incomplete
 * approval state yields `null` and the row simply omits the funding
 * line.
 *
 * This intentionally returns only the closed enum. Amounts, provider
 * metadata, confirmation timestamps, and failure diagnostics are
 * detail-page concerns and must not reach the list DTO.
 */
export function deriveListFundingStatus(
  input: ListFundingStatusInput,
): DealListFundingStatusV1 | null {
  if (input.approvalState !== "BothApproved") {
    return null;
  }
  switch (input.currentPaymentIntentState) {
    // Both parties approved but no intent exists for this version
    // yet: the Deal is ready for the buyer to fund.
    case null:
      return "AwaitingConfirmation";
    case "Created":
      return "AwaitingConfirmation";
    case "Confirmed":
      return "Confirmed";
    case "Failed":
      return "Failed";
  }
}
