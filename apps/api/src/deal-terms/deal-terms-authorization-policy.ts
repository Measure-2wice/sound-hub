// Deal / TermsVersion / DealApprover authorization policy (BG5).
//
// Background: ticket #63 requires a clear separation between
// (a) terms drafting and (b) terms approval authorization:
//
//   - Drafting requires the acting user to be a current member of
//     one of the Deal's buyer or seller Workspaces AND the Deal to
//     be in `Negotiating`. AI may draft; being an Owner, possessing
//     Buyer/Seller capability, or holding a DealApprover authorization
//     is NOT sufficient or required for drafting.
//
//   - Approval requires (1) current membership in the Workspace whose
//     side is approving AND (2) an explicit DealApprover authorization
//     row binding that (Workspace, user) tuple AND (3) the
//     termsVersionId to match the Deal's CURRENT version (MAX(version)
//     per Deal at approval time).
//
//     AI output, UI state, provider metadata, the other party's
//     approval, role, or Buyer/Seller capability do NOT synthesize
// approval.
//
// This module is the single source of truth for the policy: every
// consequential BG5 use case runs through these pure evaluators. Both
// persistence adapters (Prisma + in-memory) load the snapshot rows
// inside their transaction and call these helpers to obtain the
// application-owned verdict; the adapters MUST NOT make the
// authorization decision themselves.
//
// The policy decision is intentionally pure:
//   - it operates on snapshot rows the caller already holds
//   - it does not consult any external state
//   - it returns a discriminated verdict the repository maps onto
//     its own typed failure reasons.
//
// New evaluators added here must remain pure and additive.

import type { DealStatusV1 } from "@soundhub/types";
import type { DealReadAuthoritySnapshot } from "./deal-terms.repository.js";

// --------------------------------------------------------------------------
// Drafting authorization
// --------------------------------------------------------------------------

export type DraftingAuthorityVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "DEAL_NOT_FOUND"
        | "DEAL_NOT_NEGOTIATING"
        | "NOT_A_MEMBER"
        | "WORKSPACE_INELIGIBLE";
    };

/**
 * Snapshot the repository acquires FOR UPDATE on the buyer + seller
 * sides before invoking the drafting use case. Every field reflects
 * a row the transaction must lock so a concurrent revoke, membership
 * deletion, capability removal, or Deal state transition cannot commit
 * between this snapshot read and the BG5 write.
 */
export interface DraftingAuthoritySnapshot {
  readonly dealId: string;
  readonly dealStatus: DealStatusV1 | null;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly actingWorkspaceId: string;
  readonly actingWorkspaceStatus: "Active" | "Suspended";
  readonly actingUserIsMember: boolean;
}

/**
 * Apply the drafting policy to a FOR UPDATE-locked snapshot.
 *
 * The repository supplies the snapshots; this function decides whether
 * those facts authorize the command.
 *
 * Rule (per ticket #63):
 *   1. The Deal must exist (dealStatus non-null).
 *   2. The Deal must be in `Negotiating`.
 *   3. The acting user must be a current member of one of the Deal's
 *      buyer or seller Workspaces.
 *   4. That Workspace must be Active.
 */
export function evaluateDraftingAuthority(
  snapshot: DraftingAuthoritySnapshot,
): DraftingAuthorityVerdict {
  if (snapshot.dealStatus === null) {
    return { ok: false, reason: "DEAL_NOT_FOUND" };
  }
  if (snapshot.dealStatus !== "Negotiating") {
    return { ok: false, reason: "DEAL_NOT_NEGOTIATING" };
  }
  if (
    snapshot.actingWorkspaceId !== snapshot.buyerWorkspaceId &&
    snapshot.actingWorkspaceId !== snapshot.sellerWorkspaceId
  ) {
    // The acting Workspace is not even a party to the Deal. The
    // safe envelope collapses this to NOT_A_MEMBER so the response
    // contract never reveals whether the Workspace is associated
    // with the Deal.
    return { ok: false, reason: "NOT_A_MEMBER" };
  }
  if (snapshot.actingWorkspaceStatus !== "Active") {
    return { ok: false, reason: "WORKSPACE_INELIGIBLE" };
  }
  if (!snapshot.actingUserIsMember) {
    return { ok: false, reason: "NOT_A_MEMBER" };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// Deal-read authorization (P0-001)
// --------------------------------------------------------------------------

export type DealReadAuthorityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "DEAL_NOT_FOUND" };

/**
 * Pure evaluator for the BG5 Deal read path. The repository opens
 * one transaction, FOR UPDATE-locks the Deal + buyer/seller
 * Workspaces + the acting user's WorkspaceMembership for the EXACT
 * commanded Workspace, then hands the locked snapshot to this
 * function. The verdict decides whether the locked facts authorize
 * returning the Deal view.
 *
 * Rule (per ticket #63 P0-001):
 *   1. The Deal must exist.
 *   2. The acting Workspace must be Active.
 *   3. The acting user must be a current member of that EXACT
 *      Workspace (no other-Workspace membership grants read).
 *   4. The acting Workspace must be the Deal's buyer or seller side.
 *
 * All rejections collapse to `DEAL_NOT_FOUND` so an unauthorized
 * caller cannot distinguish "no such Deal" from "Deal exists but
 * you are not a party".
 */
export function evaluateDealReadAuthority(
  snapshot: DealReadAuthoritySnapshot,
): DealReadAuthorityVerdict {
  if (!snapshot.dealExists || snapshot.dealStatus === null) {
    return { ok: false, reason: "DEAL_NOT_FOUND" };
  }
  if (
    snapshot.buyerWorkspaceId !== snapshot.actingWorkspaceId &&
    snapshot.sellerWorkspaceId !== snapshot.actingWorkspaceId
  ) {
    return { ok: false, reason: "DEAL_NOT_FOUND" };
  }
  if (snapshot.actingWorkspaceStatus !== "Active") {
    return { ok: false, reason: "DEAL_NOT_FOUND" };
  }
  if (!snapshot.actingUserIsMember) {
    return { ok: false, reason: "DEAL_NOT_FOUND" };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// Approval authorization
// --------------------------------------------------------------------------

export type ApprovalAuthorityVerdict =
  | { readonly ok: true; readonly currentVersionId: string }
  | {
      readonly ok: false;
      readonly reason:
        | "DEAL_NOT_FOUND"
        | "DEAL_NOT_NEGOTIATING"
        | "TERMS_VERSION_NOT_FOUND"
        | "TERMS_VERSION_NOT_CURRENT"
        | "WORKSPACE_NOT_PARTY"
        | "WORKSPACE_INELIGIBLE"
        | "NOT_A_MEMBER"
        | "DEAL_APPROVER_NOT_FOUND";
    };

/**
 * Snapshot the repository acquires FOR UPDATE on the TermsVersion +
 * the acting Workspace + the DealApprover authorization row before
 * invoking the approval use case. Every field reflects a row the
 * transaction must lock so a concurrent revoke, Deal state
 * transition, TermsVersion replacement (which makes prior approvals
 * ineffective via the current-version check), or DealApprover removal
 * cannot commit between this snapshot read and the BG5 write.
 */
export interface ApprovalAuthoritySnapshot {
  readonly dealId: string;
  readonly dealStatus: DealStatusV1 | null;
  readonly termsVersionId: string;
  readonly termsVersionDealId: string | null;
  readonly currentTermsVersionId: string | null;
  readonly buyerWorkspaceId: string | null;
  readonly sellerWorkspaceId: string | null;
  readonly actingWorkspaceId: string;
  readonly actingWorkspaceStatus: "Active" | "Suspended";
  readonly actingUserIsMember: boolean;
  /**
   * The acting human's UserAccount id (the buyer or seller member
   * who clicked "approve"). Recorded for audit; the
   * `dealApproverExists` + `dealApproverId` rows are the
   * authorization source, NOT the user id alone. Surfaced in the
   * snapshot so the use case can plumb it into the persistApproval
   * input.
   */
  readonly userAccountId: string;
  readonly dealApproverExists: boolean;
  /**
   * The DealApprover row id the repository loaded under
   * FOR UPDATE-lock. Null when `dealApproverExists` is false (the
   * policy evaluator never reads this; the snapshot is the only
   * place it is exposed so the use-case closure can plumb it into
   * the persistApproval input).
   */
  readonly dealApproverId: string | null;
}

/**
 * Apply the approval policy to a FOR UPDATE-locked snapshot.
 *
 * Rule (per ticket #63):
 *   1. The Deal must exist and be in `Negotiating`.
 *   2. The TermsVersion must exist and belong to that Deal.
 *   3. The TermsVersion must be the CURRENT version (MAX(version)
 *      per Deal at approval time). Prior approvals remain in the
 *      table (immutable audit) but a stale termsVersionId is
 *      rejected with TERMS_VERSION_NOT_CURRENT.
 *   4. The acting Workspace must be a party to the Deal (buyer or
 *      seller side).
 *   5. The acting Workspace must be Active.
 *   6. The acting user must be a current member of that Workspace.
 *   7. A DealApprover authorization must exist binding the
 *      (Workspace, user) tuple. The repository loads the row under
 *      FOR UPDATE so a concurrent revocation fails the approval.
 */
export function evaluateApprovalAuthority(
  snapshot: ApprovalAuthoritySnapshot,
): ApprovalAuthorityVerdict {
  if (snapshot.dealStatus === null) {
    return { ok: false, reason: "DEAL_NOT_FOUND" };
  }
  if (snapshot.dealStatus !== "Negotiating") {
    return { ok: false, reason: "DEAL_NOT_NEGOTIATING" };
  }
  if (snapshot.termsVersionDealId === null) {
    return { ok: false, reason: "TERMS_VERSION_NOT_FOUND" };
  }
  if (snapshot.termsVersionDealId !== snapshot.dealId) {
    // The TermsVersion exists but belongs to a different Deal. The
    // safe envelope collapses this to TERMS_VERSION_NOT_FOUND so the
    // response contract never reveals cross-Deal existence.
    return { ok: false, reason: "TERMS_VERSION_NOT_FOUND" };
  }
  if (
    snapshot.currentTermsVersionId === null ||
    snapshot.currentTermsVersionId !== snapshot.termsVersionId
  ) {
    return { ok: false, reason: "TERMS_VERSION_NOT_CURRENT" };
  }
  if (
    snapshot.actingWorkspaceId !== snapshot.buyerWorkspaceId &&
    snapshot.actingWorkspaceId !== snapshot.sellerWorkspaceId
  ) {
    return { ok: false, reason: "WORKSPACE_NOT_PARTY" };
  }
  if (snapshot.actingWorkspaceStatus !== "Active") {
    return { ok: false, reason: "WORKSPACE_INELIGIBLE" };
  }
  if (!snapshot.actingUserIsMember) {
    return { ok: false, reason: "NOT_A_MEMBER" };
  }
  if (!snapshot.dealApproverExists) {
    return { ok: false, reason: "DEAL_APPROVER_NOT_FOUND" };
  }
  return { ok: true, currentVersionId: snapshot.termsVersionId };
}
