// Seller participation terms registration seam (M2 #83).
//
// Background: the M2 #83 slice requires a versioned, customer-readable
// Seller participation / terms document the human accepts when
// choosing `Offer services` or `Both`. The exact legal text is gated
// on product/legal review and is NOT shipped as a placeholder — this
// module is the registration seam and is intentionally empty until
// product/legal supplies and registers the approved text.
//
// TODO(legal-blocker): Offer/Both acceptance requires the registered
// Seller participation terms. This module is the registration seam.
//
//   Owner: Product + Legal.
//   Unblocking step: call
//     `registerSellerParticipationTerms({ version, content })`
//     from an approved admin bootstrap (out of scope for #83).
//   Post-condition: until that call lands, every `Offer services`
//     and `Both` submission returns `INTENT_LEGAL_BLOCKED` with the
//     neutral retryable copy. #83 cannot mark Offer/Both
//     production-complete against production text.
//
// State machine:
//
//   - unregistered (default): `getCurrentSellerParticipationTerms()`
//     returns `null`. `Offer services` and `Both` paths MUST refuse
//     with `INTENT_LEGAL_BLOCKED`. `Hire talent` is unaffected — Buyer
//     capability requires no attestation.
//
//   - registered: `registerSellerParticipationTerms(...)` (intended
//     for product/legal tooling, not exposed over HTTP) records the
//     approved version + content hash + immutable content. Subsequent
//     `getCurrentSellerParticipationTerms()` calls return the
//     registered document. `Offer services` and `Both` succeed; the
//     acceptance row is keyed by `(workspaceId, termsVersion)` and
//     carries the immutable content hash for audit.
//
// Concurrency authority lives in the database
// (`seller_participation_acceptances_workspace_version_unique_idx`)
// and is enforced via `INSERT ... ON CONFLICT DO NOTHING RETURNING *`
// in the auth repository's `recordSellerParticipationAcceptance`
// primitive. Idempotency is the database's job, not this module's.
//
// The neutral retryable message surfaced to the customer is owned by
// `apps/web/src/app/workspace/intent/page.tsx`; the route carries
// the safe-envelope `INTENT_LEGAL_BLOCKED` code so the same code
// works for any future HTTP caller (test harness, smoke probe, etc.).

import { createHash } from "node:crypto";

/**
 * The registered, versioned Seller participation / terms document.
 * The shape is intentionally minimal — the application treats the
 * registered text as opaque and only references the version
 * identifier + content hash. The full document content is kept here
 * for traceability but is never serialized to a public DTO.
 */
export interface SellerParticipationTerms {
  /**
   * Versioned identifier. The same value the
   * `sellerParticipationAcceptance.termsVersion` column carries.
   * Conventional format: `MAJOR.MINOR.PATCH` (semver-ish); the
   * application treats it as an opaque string and never parses it.
   */
  readonly version: string;
  /**
   * SHA-256 of the immutable document content. The same value the
   * `sellerParticipationAcceptance.termsContentHash` column carries.
   * Acceptance rows link to this hash for audit so the text cannot
   * change retroactively without invalidating the link.
   */
  readonly contentHash: string;
  /**
   * The full immutable document content. Held in-process only; never
   * serialized over HTTP. The hash is the durable cross-process
   * identifier.
   */
  readonly content: string;
}

let registered: SellerParticipationTerms | null = null;

/**
 * Read the currently registered Seller participation terms.
 * Returns `null` until `registerSellerParticipationTerms(...)` is
 * called. `Offer services` and `Both` paths must refuse with
 * `INTENT_LEGAL_BLOCKED` when this returns `null`.
 */
export function getCurrentSellerParticipationTerms(): SellerParticipationTerms | null {
  return registered;
}

/**
 * Register the approved Seller participation terms. Intended for
 * product/legal tooling, not for runtime HTTP callers. The
 * application accepts the registration as the source of truth for
 * subsequent acceptance requests.
 *
 * The hash is computed server-side from the content so the caller
 * cannot accidentally supply a mismatched hash. A registration
 * with the same version as an existing one REPLACES the in-memory
 * record — production registration tooling should treat that as a
 * versioning mistake and reject it; the in-memory seam is
 * deliberately simple so a future server-side registration
 * workflow can layer policy on top.
 */
export function registerSellerParticipationTerms(input: {
  readonly version: string;
  readonly content: string;
}): SellerParticipationTerms {
  if (typeof input.version !== "string" || input.version.length === 0) {
    throw new Error("registerSellerParticipationTerms: version is required");
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new Error("registerSellerParticipationTerms: content is required");
  }
  const contentHash = createHash("sha256").update(input.content, "utf8").digest("hex");
  registered = {
    version: input.version,
    contentHash,
    content: input.content,
  };
  return registered;
}

/**
 * Test-only reset of the registration seam. Production callers
 * must not import this — it is exported so unit tests can reset
 * state between cases without re-instantiating the module.
 *
 * The `package/db/__boundaries__/db-import-boundaries.test.ts`
 * pattern does not apply here: this module is internal to
 * `apps/api/src/lib/`. The reset is guarded by a parameter so
 * accidental production calls are loud.
 */
export function __resetSellerParticipationTermsForTests(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "__resetSellerParticipationTermsForTests called in production; refusing to mutate",
    );
  }
  registered = null;
}
