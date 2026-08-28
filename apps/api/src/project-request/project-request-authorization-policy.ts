// ProjectRequest authorization policy (BG4).
//
// Background: ticket #62 requires that buyer authority (Workspace
// status, current WorkspaceMembership, Buyer capability) and seller
// authority (Workspace status, current WorkspaceMembership, Seller
// capability) be re-validated immediately before creation / accept /
// decline. The application service owns the policy decisions; the
// repository owns atomic guarded persistence. The two adapters (Prisma
// and in-memory) MUST interpret authority identically, so the policy
// is defined here once and consumed by both.
//
// The Prisma adapter also runs the same policy inside its
// `$transaction` so a concurrent revoke / status flip cannot slip
// through. The in-memory adapter runs the same policy against the
// snapshot store the test fixtures seed. A new persistence adapter
// (e.g. an in-memory mock, an event-sourced store) cannot redefine
// the policy because every adapter goes through these helpers.

export type AuthorityVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "NOT_A_MEMBER" | "MISSING_CAPABILITY" | "WORKSPACE_INELIGIBLE";
    };

export interface BuyerAuthoritySnapshot {
  readonly userAccountId: string;
  readonly buyerWorkspaceId: string;
  readonly workspaceStatus: "Active" | "Suspended";
  readonly isMember: boolean;
  readonly hasBuyerCapability: boolean;
}

export interface SellerAuthoritySnapshot {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly workspaceStatus: "Active" | "Suspended";
  readonly isMember: boolean;
  readonly hasSellerCapability: boolean;
}

/**
 * Apply the buyer-authority policy to a snapshot. Both adapters
 * build the snapshot (Prisma reads Workspace / WorkspaceMembership /
 * WorkspaceCapability; in-memory reads the seeded maps) and call this
 * helper. The verdict is mapped to `BUYER_NOT_AUTHORIZED` at the
 * repository boundary.
 */
export function evaluateBuyerAuthority(snapshot: BuyerAuthoritySnapshot): AuthorityVerdict {
  if (snapshot.workspaceStatus !== "Active") return { ok: false, reason: "WORKSPACE_INELIGIBLE" };
  if (!snapshot.isMember) return { ok: false, reason: "NOT_A_MEMBER" };
  if (!snapshot.hasBuyerCapability) return { ok: false, reason: "MISSING_CAPABILITY" };
  return { ok: true };
}

/**
 * Apply the seller-authority policy to a snapshot. Mirrors
 * {@link evaluateBuyerAuthority} for the seller side.
 */
export function evaluateSellerAuthority(snapshot: SellerAuthoritySnapshot): AuthorityVerdict {
  if (snapshot.workspaceStatus !== "Active") return { ok: false, reason: "WORKSPACE_INELIGIBLE" };
  if (!snapshot.isMember) return { ok: false, reason: "NOT_A_MEMBER" };
  if (!snapshot.hasSellerCapability) return { ok: false, reason: "MISSING_CAPABILITY" };
  return { ok: true };
}
