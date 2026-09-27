// Post-publication pending-edits handoff (M2 #84).
//
// Background: after a profile is Published, Save draft is no longer
// a valid command (the server rejects `SELLER_PROFILE_NOT_DRAFT` on
// the draft endpoint). The editor therefore holds the user's
// post-publication edits in client memory only, and forwards them
// across the read-only review boundary through `sessionStorage` so
// the review page can submit them via `updatePublishedSellerProfile`.
//
// No persistent post-publication draft is created per ticket #84
// ("Persistent post-publication drafts, revision history, or
// restoration" is a non-goal). The handoff is single-shot: the
// review page consumes the entry on success; a rejection leaves
// the entry in place so the editor can resume the rejected
// values + retained field errors; explicit abandonment clears
// both entries.
//
// The handoff shape mirrors `SellerProfileDraftRequestV1` minus the
// `returnTo` (which the review page resolves independently via the
// `?return=` query string).
//
// Failure mode: `sessionStorage.setItem` throws when the browser
// refuses to allocate the entry (private mode, quota). A silent
// swallow would let the review page read the old server profile
// and submit a no-op confirmation. The writer therefore throws on
// failure and the editor surfaces the error inline (no navigation).

import type { ApiFieldErrorV1, SellerProfileDraftRequestV1 } from "@soundhub/types";

export interface PendingSellerProfileEdits {
  readonly identity: SellerProfileDraftRequestV1["identity"];
  readonly basedIn: SellerProfileDraftRequestV1["basedIn"];
  readonly disciplines: SellerProfileDraftRequestV1["disciplines"];
}

// Retained field-error payload from the last review submission.
// Persisted so a rejection can be corrected without the user
// re-typing values OR losing the per-field error annotations.
export interface SellerProfileRejectionState {
  readonly fieldErrors: readonly ApiFieldErrorV1[];
}

export const PENDING_EDITS_STORAGE_KEY_PREFIX = "seller-profile-pending-edits";
export const REJECTION_STORAGE_KEY_PREFIX = "seller-profile-rejection";

function rejectStorageKey(workspaceId: string): string {
  return `${REJECTION_STORAGE_KEY_PREFIX}-${encodeURIComponent(workspaceId)}`;
}

export function pendingEditsStorageKey(workspaceId: string): string {
  return `${PENDING_EDITS_STORAGE_KEY_PREFIX}-${encodeURIComponent(workspaceId)}`;
}

export function readPendingSellerProfileEdits(
  workspaceId: string,
): PendingSellerProfileEdits | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(pendingEditsStorageKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isPendingEditsShape(parsed)) return null;
    return parsed;
  } catch {
    // Corrupted entry — drop it so the review page falls back to the
    // server's current Published state. The user can re-edit and
    // resubmit.
    try {
      window.sessionStorage.removeItem(pendingEditsStorageKey(workspaceId));
    } catch {
      // ignore storage failures (private mode, etc.)
    }
    return null;
  }
}

/**
 * Write the post-publication edit handoff synchronously.
 *
 * THROWS when `sessionStorage` rejects the write (private-browsing
 * quota, blocked storage). The throw is intentional: a swallowed
 * failure would let the editor navigate to the review page, where
 * `readPendingSellerProfileEdits` returns `null` and the review
 * surface falls back to the server's prior Published state,
 * silently producing a no-op confirmation. Callers MUST catch and
 * surface the failure inline so the user can retry.
 */
export function writePendingSellerProfileEdits(
  workspaceId: string,
  edits: PendingSellerProfileEdits,
): void {
  if (typeof window === "undefined") {
    throw new Error("sessionStorage is not available in this environment");
  }
  window.sessionStorage.setItem(pendingEditsStorageKey(workspaceId), JSON.stringify(edits));
}

export function clearPendingSellerProfileEdits(workspaceId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(pendingEditsStorageKey(workspaceId));
  } catch {
    // ignore
  }
}

// ---------- Rejection state (retained field errors for correction) ----------

export function writeSellerProfileRejection(
  workspaceId: string,
  state: SellerProfileRejectionState,
): void {
  if (typeof window === "undefined") {
    throw new Error("sessionStorage is not available in this environment");
  }
  window.sessionStorage.setItem(rejectStorageKey(workspaceId), JSON.stringify(state));
}

export function readSellerProfileRejection(
  workspaceId: string,
): SellerProfileRejectionState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(rejectStorageKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRejectionShape(parsed)) return null;
    return parsed;
  } catch {
    try {
      window.sessionStorage.removeItem(rejectStorageKey(workspaceId));
    } catch {
      // ignore
    }
    return null;
  }
}

export function clearSellerProfileRejection(workspaceId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(rejectStorageKey(workspaceId));
  } catch {
    // ignore
  }
}

// ---------- shape guards ----------

function isPendingEditsShape(value: unknown): value is PendingSellerProfileEdits {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.identity !== "object" || v.identity === null) return false;
  if (typeof v.basedIn !== "object" || v.basedIn === null) return false;
  if (typeof v.disciplines !== "object" || v.disciplines === null) return false;
  const identity = v.identity as Record<string, unknown>;
  if (typeof identity.professionalName !== "string") return false;
  if (typeof identity.bio !== "string") return false;
  const basedIn = v.basedIn as Record<string, unknown>;
  // Drafts may omit countryCode — only check shape when present.
  if (basedIn.countryCode !== undefined && typeof basedIn.countryCode !== "string") {
    return false;
  }
  if (basedIn.region !== undefined && typeof basedIn.region !== "string") {
    return false;
  }
  if (basedIn.city !== undefined && typeof basedIn.city !== "string") {
    return false;
  }
  const disciplines = v.disciplines as Record<string, unknown>;
  if (!Array.isArray(disciplines.specialtyKeys)) return false;
  if (!Array.isArray(disciplines.caribbeanAffiliationCodes)) return false;
  if (
    !disciplines.specialtyKeys.every((k) => typeof k === "string") ||
    !disciplines.caribbeanAffiliationCodes.every((k) => typeof k === "string")
  ) {
    return false;
  }
  return true;
}

function isRejectionShape(value: unknown): value is SellerProfileRejectionState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.fieldErrors)) return false;
  return v.fieldErrors.every(isFieldErrorShape);
}

function isFieldErrorShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === "string" && typeof v.code === "string" && typeof v.message === "string";
}
