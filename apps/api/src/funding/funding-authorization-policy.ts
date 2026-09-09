// PaymentIntent + activation authorization policy (BG6).
//
// Background: ticket #64 requires a clear separation between
// (a) funding preauthorization and (b) the deterministic activation
// transition. Both phases share the same GS-25 condition set; the
// repository snapshots the relevant rows and the application calls
// these pure evaluators.
//
// The policy decision is intentionally pure:
//   - it operates on snapshot rows the caller already holds
//   - it does not consult any external state
//   - it returns a discriminated verdict the repository maps onto
//     its own typed failure reasons.
//
// Phase 1 (preauthorization, non-transactional read) AND Phase 3
// (transactional revalidation under FOR UPDATE-lock) call
// `evaluatePreauthAuthority` with the same snapshot shape. A revoke,
// role change, approval invalidation, or membership loss between
// Phase 1 and Phase 3 fails the Phase-3 re-validation; the
// transaction rolls back and the route writes the appropriate
// BG6_* failure.
//
// The activation invariant (the four GS-25 conditions + exact-match
// guarantees) is `evaluateActivationAuthority`. It is called inside
// the Phase-3 transaction after the preauth re-check passes. A
// non-Active result rejects the transition; the transaction rolls
// back; the Deal stays Negotiating and the PaymentIntent remains
// durable on the SAME (dealId, termsVersionId) row.

import type { DealStatusV1 } from "@soundhub/types";

// --------------------------------------------------------------------------
// Preauthorization (Phase 1 + Phase 3 revalidation)
// --------------------------------------------------------------------------

export type PreauthAuthorityVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "DEAL_NOT_FOUND"
        | "DEAL_NOT_NEGOTIATING"
        | "TERMS_VERSION_NOT_FOUND"
        | "TERMS_VERSION_NOT_CURRENT"
        | "NOT_BUYER_SIDE"
        | "NOT_A_MEMBER"
        | "WORKSPACE_INELIGIBLE"
        | "SELLER_NOT_CONSENTED"
        | "APPROVALS_INCOMPLETE"
        | "MISSING_BUYER_CAPABILITY";
    };

/**
 * Snapshot the repository acquires FOR UPDATE before invoking the
 * preauthorization evaluator. Every field reflects a row the
 * transaction must lock so a concurrent revoke, membership deletion,
 * capability removal, or Deal state transition cannot commit between
 * the snapshot read and the BG6 write.
 *
 * `hasBuyerCapability` is the independently granted
 * `WorkspaceCapability(Buyer)` row — NOT derived from membership,
 * ownership, or Deal party identity. See ticket #64 P0-001.
 */
export interface PreauthAuthoritySnapshot {
  readonly dealId: string;
  readonly dealStatus: DealStatusV1 | null;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  /** The acting Workspace's id (the buyer side, after NOT_BUYER_SIDE check). */
  readonly actingWorkspaceId: string;
  readonly actingWorkspaceStatus: "Active" | "Suspended";
  readonly actingUserIsMember: boolean;
  /** True iff the buyer Workspace holds the Buyer capability. */
  readonly hasBuyerCapability: boolean;

  // Current TermsVersion (MAX(version) per Deal at preauth time).
  readonly currentTermsVersionId: string | null;
  readonly currentTermsVersionDealId: string | null;

  // Originating ProjectRequest — GS 25 condition 1.
  readonly projectRequestStatus: "Pending" | "Accepted" | "Declined" | null;
  readonly projectRequestSellerConsentAt: Date | null;

  // GS 25 conditions 2 + 3 — both approvals for the CURRENT version.
  readonly buyerApprovalExists: boolean;
  readonly sellerApprovalExists: boolean;
}

/**
 * Apply the preauthorization policy to a FOR UPDATE-locked snapshot.
 *
 * Rule (per ticket #64 / Golden Slice GS 22-25):
 *   1. The Deal must exist (dealStatus non-null).
 *   2. The Deal must be in `Negotiating`.
 *   3. The Deal must have a current TermsVersion (MAX(version) row).
 *   4. The acting Workspace must be the buyer side.
 *   5. The acting Workspace must be Active.
 *   6. The acting user must be a current member of that Workspace.
 *   7. The buyer Workspace must independently hold the
 *      `WorkspaceCapability(Buyer)` row (NOT inferred from
 *      membership, ownership, or Deal party identity).
 *   8. The originating ProjectRequest must be Accepted with
 *      sellerConsentAt set (GS 25 condition 1).
 *   9. Both buyer and seller approvals must exist for the current
 *      TermsVersion (GS 25 conditions 2 + 3). The exact-match
 *      re-verification lives in evaluateActivationAuthority.
 */
export function evaluatePreauthAuthority(
  snapshot: PreauthAuthoritySnapshot,
): PreauthAuthorityVerdict {
  return evaluateAuthorityForStatus(snapshot, "Negotiating");
}

/** Authorize an idempotent read of an already-confirmed funding result. */
export function evaluateConfirmedRetryAuthority(
  snapshot: PreauthAuthoritySnapshot,
): PreauthAuthorityVerdict {
  return evaluateAuthorityForStatus(snapshot, "Active");
}

function evaluateAuthorityForStatus(
  snapshot: PreauthAuthoritySnapshot,
  requiredStatus: "Negotiating" | "Active",
): PreauthAuthorityVerdict {
  if (snapshot.dealStatus === null) {
    return { ok: false, reason: "DEAL_NOT_FOUND" };
  }
  if (snapshot.dealStatus !== requiredStatus) {
    return { ok: false, reason: "DEAL_NOT_NEGOTIATING" };
  }
  if (snapshot.currentTermsVersionId === null) {
    return { ok: false, reason: "TERMS_VERSION_NOT_FOUND" };
  }
  if (snapshot.currentTermsVersionDealId !== snapshot.dealId) {
    // Cross-Deal existence — collapse to a safe envelope that does
    // not reveal which Deal owns the version.
    return { ok: false, reason: "TERMS_VERSION_NOT_FOUND" };
  }
  if (snapshot.actingWorkspaceId !== snapshot.buyerWorkspaceId) {
    // The acting Workspace is not the buyer side. Collapse to
    // NOT_BUYER_SIDE so the safe envelope does not echo whether the
    // Workspace is a party at all.
    return { ok: false, reason: "NOT_BUYER_SIDE" };
  }
  if (snapshot.actingWorkspaceStatus !== "Active") {
    return { ok: false, reason: "WORKSPACE_INELIGIBLE" };
  }
  if (!snapshot.actingUserIsMember) {
    return { ok: false, reason: "NOT_A_MEMBER" };
  }
  // The Buyer capability is an independently granted
  // WorkspaceCapability row — NOT inferred from membership,
  // ownership, or Deal party identity. A current member without
  // the Buyer capability is rejected here.
  if (!snapshot.hasBuyerCapability) {
    return { ok: false, reason: "MISSING_BUYER_CAPABILITY" };
  }
  if (
    snapshot.projectRequestStatus !== "Accepted" ||
    snapshot.projectRequestSellerConsentAt === null
  ) {
    return { ok: false, reason: "SELLER_NOT_CONSENTED" };
  }
  if (!snapshot.buyerApprovalExists || !snapshot.sellerApprovalExists) {
    return { ok: false, reason: "APPROVALS_INCOMPLETE" };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// Activation invariant (Phase 3 — the four GS-25 conditions + exact match)
// --------------------------------------------------------------------------

export type ActivationAuthorityVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "SELLER_NOT_CONSENTED"
        | "APPROVALS_INCOMPLETE"
        | "NO_FUNDING"
        | "AMOUNT_MISMATCH"
        | "CURRENCY_MISMATCH"
        | "TERMS_VERSION_MISMATCH";
    };

/**
 * Snapshot the repository assembles inside the Phase-3 transaction
 * for the activation invariant. All fields are read from rows that
 * have been FOR UPDATE-locked by the same transaction.
 */
export interface ActivationAuthoritySnapshot {
  // GS 25 condition 1.
  readonly projectRequestSellerConsentAt: Date | null;
  // GS 25 conditions 2 + 3 — both approvals for the current version.
  readonly buyerApprovalExists: boolean;
  readonly sellerApprovalExists: boolean;
  // GS 25 condition 4 — confirmed funding.
  readonly fundingConfirmedAmountMinor: number | null;
  readonly fundingConfirmedCurrency: string | null;
  readonly fundingTermsVersionId: string | null;
  // The locked current TermsVersion row (provides the expected
  // amount/currency/termsVersionId for exact-match).
  readonly currentTermsVersionId: string;
  readonly currentTermsVersionAmountMinor: number;
  readonly currentTermsVersionCurrency: string;
}

/**
 * Apply the deterministic activation invariant. GS 25 verbatim:
 *
 *   1. The originating ProjectRequest contains explicit seller
 *      acceptance (i.e. sellerConsentAt is non-null).
 *   2. The buyer Workspace has a valid independent approval.
 *   3. The seller Workspace has a valid independent approval.
 *   4. Mock funding is confirmed for the EXACT approved amount and
 *      version.
 *
 * The "exact" requirement is the "mismatch is not success" rule.
 */
export function evaluateActivationAuthority(
  snapshot: ActivationAuthoritySnapshot,
): ActivationAuthorityVerdict {
  if (snapshot.projectRequestSellerConsentAt === null) {
    return { ok: false, reason: "SELLER_NOT_CONSENTED" };
  }
  if (!snapshot.buyerApprovalExists || !snapshot.sellerApprovalExists) {
    return { ok: false, reason: "APPROVALS_INCOMPLETE" };
  }
  if (
    snapshot.fundingConfirmedAmountMinor === null ||
    snapshot.fundingConfirmedCurrency === null ||
    snapshot.fundingTermsVersionId === null
  ) {
    return { ok: false, reason: "NO_FUNDING" };
  }
  if (snapshot.fundingTermsVersionId !== snapshot.currentTermsVersionId) {
    return { ok: false, reason: "TERMS_VERSION_MISMATCH" };
  }
  if (snapshot.fundingConfirmedAmountMinor !== snapshot.currentTermsVersionAmountMinor) {
    return { ok: false, reason: "AMOUNT_MISMATCH" };
  }
  if (snapshot.fundingConfirmedCurrency !== snapshot.currentTermsVersionCurrency) {
    return { ok: false, reason: "CURRENCY_MISMATCH" };
  }
  return { ok: true };
}
