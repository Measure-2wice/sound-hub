// Deal-list copy helpers (ticket #74).
//
// Background: the /deals rows translate the server-derived closed
// enums into human-readable copy. These helpers are pure so the
// wording is unit-testable without mounting the page.
//
// The server owns the state; this module only names it. No helper here
// infers, combines, or second-guesses a state the API reported.

import type {
  DealApprovalStateV1,
  DealActingSideV1,
  DealListFundingStatusV1,
  DealListItemPublicV1,
  DealStatusV1,
} from "@soundhub/types";

/** Fallback when a referenced row could not be loaded server-side. */
const UNKNOWN_LABEL = "Unnamed";

export function describeDealStatus(status: DealStatusV1): string {
  switch (status) {
    case "Negotiating":
      return "Negotiating";
    case "Active":
      return "Active";
  }
}

export function describeApprovalState(state: DealApprovalStateV1): string {
  switch (state) {
    case "NoTerms":
      return "No terms drafted";
    case "AwaitingBothApprovals":
      return "Awaiting both approvals";
    case "AwaitingBuyerApproval":
      return "Awaiting buyer approval";
    case "AwaitingSellerApproval":
      return "Awaiting seller approval";
    case "BothApproved":
      return "Both parties approved";
  }
}

/**
 * Name the funding state. Returns null when funding is not yet
 * applicable so the row can omit the line entirely rather than render
 * a misleading "not funded".
 */
export function describeFundingStatus(status: DealListFundingStatusV1 | null): string | null {
  if (status === null) return null;
  switch (status) {
    case "AwaitingConfirmation":
      return "Awaiting funding";
    case "Confirmed":
      return "Funded";
    case "Failed":
      return "Funding failed";
  }
}

/**
 * The row's primary label. `ServiceOffering.title` is the only
 * human-readable project noun on a Deal — ProjectBrief carries no
 * title — so it leads the row, per ticket #74's requirement that rows
 * use human-readable labels rather than raw internal ids.
 */
export function describeDealTitle(deal: DealListItemPublicV1): string {
  return deal.serviceOfferingTitle ?? UNKNOWN_LABEL;
}

/**
 * The row's secondary label: who the acting Workspace is dealing with.
 */
export function describeCounterparty(deal: DealListItemPublicV1): string {
  const name = deal.counterpartyWorkspaceName ?? UNKNOWN_LABEL;
  return `with ${name}`;
}

export function describeActingSide(side: DealActingSideV1): string {
  switch (side) {
    case "Buyer":
      return "You are the buyer";
    case "Seller":
      return "You are the seller";
  }
}

/**
 * "v2", or null when no TermsVersion has been drafted yet.
 */
export function describeTermsVersion(version: number | null): string | null {
  return version === null ? null : `v${String(version)}`;
}

/**
 * Stable, locale-independent date copy. Matches the formatting used by
 * the seller inbox so the two lists read consistently.
 */
export function formatDealDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
}

/**
 * The single status line beneath the row's labels, e.g.
 * "Negotiating · v2 · Awaiting seller approval".
 *
 * Segments that do not apply are omitted rather than rendered empty.
 */
export function buildDealStatusLine(deal: DealListItemPublicV1): string {
  const segments: string[] = [describeDealStatus(deal.status)];
  const version = describeTermsVersion(deal.currentTermsVersion);
  if (version !== null) segments.push(version);
  segments.push(describeApprovalState(deal.approvalState));
  return segments.join(" · ");
}
