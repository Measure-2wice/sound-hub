// Deal-list read authorization policy (ticket #74).
//
// Background: ticket #74 makes Deals discoverable from signed-in
// navigation. The list is a PRIVATE read: it returns the Deals of one
// acting Workspace to one current member of that exact Workspace.
//
// This module mirrors the accepted BG5 shape in
// `../deal-terms/deal-terms-authorization-policy.ts`: the repository
// FOR UPDATE-locks the fact rows inside its transaction and hands the
// locked snapshot to this pure evaluator; the adapter MUST NOT make
// the authorization decision itself.
//
// Why the decision must live at the same boundary as the read:
// a service pre-check followed by an independent query leaves a
// window in which a membership revocation can commit between the two,
// letting a former member read private Deal rows. The snapshot this
// evaluator consumes is read under row locks in the SAME transaction
// that then performs the scoped Deal read, closing that window.
//
// `ownerUserId` is deliberately absent from the snapshot. Per BG1 and
// ADR-0001, humans act through audited WorkspaceMemberships; Workspace
// ownership is never an authorization signal.

/**
 * Facts the repository acquires under FOR UPDATE before invoking the
 * list use case. Every field reflects a locked row, so a concurrent
 * membership deletion or Workspace suspension cannot commit between
 * this snapshot read and the scoped Deal read.
 */
export interface DealListReadAuthoritySnapshot {
  /** The EXACT Workspace id the caller commanded. */
  readonly actingWorkspaceId: string;
  /**
   * Status of the locked Workspace row; null when no such Workspace
   * exists.
   */
  readonly actingWorkspaceStatus: "Active" | "Suspended" | null;
  /**
   * True only when a WorkspaceMembership row exists for the EXACT
   * (authenticated userAccountId, commanded actingWorkspaceId) tuple.
   * A revoked membership is represented by row absence, so `false`
   * covers revocation.
   */
  readonly actingUserIsMember: boolean;
}

export type DealListReadAuthorityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "DEAL_LIST_FORBIDDEN" };

/**
 * Apply the list-read policy to a FOR UPDATE-locked snapshot.
 *
 * Rule (per ticket #74):
 *   1. The acting Workspace must exist.
 *   2. It must be Active (a Suspended Workspace may not act).
 *   3. The authenticated user must be a CURRENT member of that EXACT
 *      Workspace. Membership in some other Workspace grants nothing.
 *
 * Every rejection collapses to a single opaque reason so the response
 * never distinguishes "no such Workspace" from "you are not a member
 * of it" — the caller learns nothing about Workspaces they cannot act
 * for. The scoped read that follows an `ok` verdict is additionally
 * filtered to Deals where this exact Workspace is the buyer or seller
 * party, so an authorized member of an unrelated Workspace sees an
 * empty list rather than another Workspace's Deals.
 */
export function evaluateDealListReadAuthority(
  snapshot: DealListReadAuthoritySnapshot,
): DealListReadAuthorityVerdict {
  if (snapshot.actingWorkspaceStatus === null) {
    return { ok: false, reason: "DEAL_LIST_FORBIDDEN" };
  }
  if (snapshot.actingWorkspaceStatus !== "Active") {
    return { ok: false, reason: "DEAL_LIST_FORBIDDEN" };
  }
  if (!snapshot.actingUserIsMember) {
    return { ok: false, reason: "DEAL_LIST_FORBIDDEN" };
  }
  return { ok: true };
}
