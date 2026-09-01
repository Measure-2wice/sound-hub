// ProjectRequest authorization policy (BG4).
//
// Background: ticket #62 requires that buyer authority (Workspace
// status, current WorkspaceMembership, Buyer capability), the
// complete seller/offering eligibility chain (seller Workspace
// status, Seller capability, SellerProfile publication, ServiceOffering
// Active state, ownership), the ProjectBrief recommendation
// provenance, and seller authority (Workspace status, current
// WorkspaceMembership, Seller capability) be re-validated inside the
// same transaction that runs the BG4 write. The application owns the
// policy decisions; the repository owns the transaction + the locked
// fact reads + the guarded persistence.
//
// This module is the single source of truth for the policy: every
// consequential BG4 use case runs through these pure evaluators. Both
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

export type AuthorityVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "NOT_A_MEMBER" | "MISSING_CAPABILITY" | "WORKSPACE_INELIGIBLE";
    };

export type EligibilityVerdict =
  | { readonly ok: true; readonly sellerWorkspaceId: string }
  | {
      readonly ok: false;
      readonly reason:
        | "WORKSPACE_INELIGIBLE"
        | "MISSING_CAPABILITY"
        | "OFFERING_NOT_ACTIVE"
        | "PROFILE_NOT_PUBLISHED"
        | "OFFERING_NOT_FOUND";
    };

export type BriefRecommendationVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "BRIEF_NOT_FOUND" | "BRIEF_FORBIDDEN" | "OFFERING_NOT_IN_BRIEF";
    };

/**
 * Snapshot the repository acquires FOR UPDATE on the buyer side
 * before invoking the application use case. Every field reflects a
 * row that the transaction must lock so a concurrent revoke,
 * membership deletion, capability removal, or Workspace suspension
 * cannot commit between this snapshot read and the BG4 write.
 */
export interface BuyerAuthoritySnapshot {
  readonly userAccountId: string;
  readonly buyerWorkspaceId: string;
  readonly workspaceStatus: "Active" | "Suspended";
  readonly isMember: boolean;
  readonly hasBuyerCapability: boolean;
}

/**
 * Snapshot the repository acquires FOR UPDATE on the seller side
 * during the ProjectRequest create use case. The repository reads
 * the offering's seller Profile, Workspace, WorkspaceMembership,
 * WorkspaceCapability, and ServiceOffering rows under FOR UPDATE so
 * a concurrent archive / unpublish / capability removal / Workspace
 * suspension cannot slip between the snapshot and the INSERT.
 */
export interface SellerEligibilitySnapshot {
  readonly serviceOfferingId: string;
  readonly sellerWorkspaceId: string | null;
  readonly offeringStatus: "Draft" | "Active" | "Paused" | "Archived" | null;
  readonly workspaceStatus: "Active" | "Suspended" | null;
  readonly workspaceHasSellerCapability: boolean | null;
  readonly profileStatus: "Draft" | "Published" | "Suspended" | null;
}

/**
 * Snapshot the repository acquires FOR UPDATE on the buyer brief
 * during the ProjectRequest create use case. The buyer cannot
 * submit an arbitrary eligible offering that Matchmaker never
 * surfaced for this brief; the repository hands the persisted
 * `bestOfferingId` / `additionalOfferingsJson` rows to the use case
 * so the application policy can verify provenance.
 */
export interface BriefRecommendationsSnapshot {
  readonly projectBriefId: string;
  readonly buyerWorkspaceId: string | null;
  readonly exists: boolean;
  readonly offeringIds: readonly string[];
}

/**
 * Snapshot the repository acquires FOR UPDATE on the seller side
 * during accept / decline. The repository locks the ProjectRequest
 * row, the seller Workspace, the seller WorkspaceMembership, and the
 * seller WorkspaceCapability so a concurrent revoke or Workspace
 * suspension cannot commit between the authority read and the
 * guarded transition.
 */
export interface SellerAuthoritySnapshot {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly projectRequestSellerWorkspaceId: string | null;
  readonly workspaceStatus: "Active" | "Suspended";
  readonly isMember: boolean;
  readonly hasSellerCapability: boolean;
}

// ---------- pure evaluators ----------

/**
 * Apply the buyer-authority policy to a snapshot. The repository
 * supplies the FOR UPDATE-locked row set; this function decides
 * whether those rows authorize the command.
 */
export function evaluateBuyerAuthority(snapshot: BuyerAuthoritySnapshot): AuthorityVerdict {
  if (snapshot.workspaceStatus !== "Active") return { ok: false, reason: "WORKSPACE_INELIGIBLE" };
  if (!snapshot.isMember) return { ok: false, reason: "NOT_A_MEMBER" };
  if (!snapshot.hasBuyerCapability) return { ok: false, reason: "MISSING_CAPABILITY" };
  return { ok: true };
}

/**
 * Apply the complete seller / offering eligibility policy to the
 * FOR UPDATE-locked snapshot. Returns the seller Workspace id on
 * success so the use case knows which Workspace to record as the
 * ProjectRequest's seller side without re-reading.
 */
export function evaluateSellerEligibility(snapshot: SellerEligibilitySnapshot): EligibilityVerdict {
  if (snapshot.sellerWorkspaceId === null) return { ok: false, reason: "OFFERING_NOT_FOUND" };
  if (snapshot.workspaceStatus === null) return { ok: false, reason: "OFFERING_NOT_FOUND" };
  if (snapshot.offeringStatus === null) return { ok: false, reason: "OFFERING_NOT_FOUND" };
  if (snapshot.profileStatus === null) return { ok: false, reason: "OFFERING_NOT_FOUND" };
  if (snapshot.workspaceHasSellerCapability === null) {
    return { ok: false, reason: "OFFERING_NOT_FOUND" };
  }
  if (snapshot.workspaceStatus !== "Active") return { ok: false, reason: "WORKSPACE_INELIGIBLE" };
  if (!snapshot.workspaceHasSellerCapability) return { ok: false, reason: "MISSING_CAPABILITY" };
  if (snapshot.profileStatus !== "Published") return { ok: false, reason: "PROFILE_NOT_PUBLISHED" };
  if (snapshot.offeringStatus !== "Active") return { ok: false, reason: "OFFERING_NOT_ACTIVE" };
  return { ok: true, sellerWorkspaceId: snapshot.sellerWorkspaceId };
}

/**
 * Apply the brief recommendation boundary policy to the locked
 * snapshot. The buyer can only submit a selection that Matchmaker
 * already surfaced for this brief, AND the brief must be owned
 * by the buyer's acting Workspace (so a buyer cannot submit a
 * request against another Workspace's brief).
 */
export function evaluateBriefRecommendationBoundary(
  snapshot: BriefRecommendationsSnapshot,
  requestedOfferingId: string,
  actingWorkspaceId: string,
): BriefRecommendationVerdict {
  if (!snapshot.exists) return { ok: false, reason: "BRIEF_NOT_FOUND" };
  if (snapshot.buyerWorkspaceId === null) return { ok: false, reason: "BRIEF_NOT_FOUND" };
  if (snapshot.buyerWorkspaceId !== actingWorkspaceId) {
    return { ok: false, reason: "BRIEF_FORBIDDEN" };
  }
  if (!snapshot.offeringIds.includes(requestedOfferingId)) {
    return { ok: false, reason: "OFFERING_NOT_IN_BRIEF" };
  }
  return { ok: true };
}

/**
 * Apply the seller-authority policy to a locked accept/decline
 * snapshot. The ProjectRequest's persisted sellerWorkspaceId MUST
 * match the acting Workspace; if it does not, fail closed with
 * `NOT_A_MEMBER` so the safe envelope does not leak the mismatch.
 */
export function evaluateSellerAuthority(snapshot: SellerAuthoritySnapshot): AuthorityVerdict {
  if (snapshot.projectRequestSellerWorkspaceId === null) {
    return { ok: false, reason: "NOT_A_MEMBER" };
  }
  if (snapshot.projectRequestSellerWorkspaceId !== snapshot.actingWorkspaceId) {
    return { ok: false, reason: "NOT_A_MEMBER" };
  }
  if (snapshot.workspaceStatus !== "Active") return { ok: false, reason: "WORKSPACE_INELIGIBLE" };
  if (!snapshot.isMember) return { ok: false, reason: "NOT_A_MEMBER" };
  if (!snapshot.hasSellerCapability) return { ok: false, reason: "MISSING_CAPABILITY" };
  return { ok: true };
}
