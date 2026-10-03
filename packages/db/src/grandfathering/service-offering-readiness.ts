// M2 (#86, slice 86E): pure readiness predicate for
// ServiceOfferings, plus the effective-confirmation helper the
// inventory uses to merge activation and update evidence.
//
// Location: `packages/db/src/grandfathering/`.
//
// Why this lives in `@soundhub/db` and NOT in `apps/api/`:
// the slice plan's "Dependency boundary" section requires a
// legal shared location that can be reused by both the runtime
// ServiceOffering composition (apps/api, future 86F) AND the
// operator inventory script (`packages/db/prisma/`). Placing the
// predicate in `apps/api/` would force `packages/db` to import
// upward across the monorepo dependency direction, which the
// per-package boundary guard
// (`packages/db/src/__boundaries__/db-import-boundaries.test.ts`)
// rejects. `@soundhub/db` is already declared as a runtime
// dependency of `apps/api` (`apps/api/package.json:17`), so the
// 86F wiring can consume it without a new dependency edge.
//
// The pre-rollout grandfathering slice derives, for any offering
// row the runtime / the operator script can observe, whether the
// offering is "Available + conformant", "Available + nonconforming"
// (grandfathered; flagged for Update needed), or "not Available"
// (any non-Active lifecycle state). The slice plan locks the
// closed set of reason categories:
//
//   - title-required
//   - description-required
//   - category-required
//   - service-area-required
//   - pricing-required
//   - audio-sample-required
//   - activation-confirmation-stale
//   - seller-profile-not-published
//
// This module is the single source of truth for those derivations.
// Both the runtime `ServiceOfferingService` composition (which
// must surface Available + Update needed in the editor's lifecycle
// view per the M2 reconciled UX spec) and the operator inventory
// script (which lists currently-Active nonconforming offerings)
// consume this function.
//
// Per the slice plan's dependency boundary: the predicate is
// pure, takes plain-data inputs, and returns plain-data outputs.
// The Prisma adapter and the in-memory adapter feed it rows they
// already loaded; the inventory script feeds it rows it queries
// directly via Prisma. No adapter, Prisma, or runtime dependency
// is imported here, so the predicate is reusable across every
// caller that has the offering's persisted state.
//
// IMPORTANT: the slice plan requires that this function NEVER
// fabricate missing data. Every reason category is a direct,
// observable property of the persisted state.

/**
 * The closed set of reason categories an offering can carry on its
 * grandfathering readiness view. Per the slice plan's "Reason
 * categories" section, these are the only legal categories — no
 * silently-invented alternative buckets are allowed.
 */
export type ServiceOfferingReadinessReasonCategory =
  | "title-required"
  | "description-required"
  | "category-required"
  | "service-area-required"
  | "pricing-required"
  | "audio-sample-required"
  | "activation-confirmation-stale"
  | "seller-profile-not-published";

/**
 * The grandfathering readiness view for an offering. Derived
 * shape; not persisted.
 */
export interface ServiceOfferingReadiness {
  /**
   * The offering is `Available` to buyers:
   *   - lifecycle status is `Active`.
   *
   * Per the slice plan's Lifecycle section, customer-facing
   * "Available" is an alias for durable `Active`; it is NOT
   * contingent on conformance. A grandfathered nonconforming
   * Active offering therefore reports `isAvailable=true` (the
   * marketplace eligibility is preserved) AND, simultaneously,
   * `updateNeeded=true` (the operator and the seller must surface
   * the actionable remediation reasons).
   *
   * `isAvailable` and `updateNeeded` are INDEPENDENT flags; the
   * prior definition (`isAvailable = Active AND reasons.length===0`)
   * combined with `updateNeeded = isAvailable && reasons.length>0`
   * produced a logically impossible conjunction that locked out
   * the grandfathered state. See the slice plan's Grandfathering
   * section: the grandfathering predicate is `Active AND
   * (reasons.length > 0)` — `updateNeeded` tracks that directly.
   */
  readonly isAvailable: boolean;

  /**
   * The seller should re-run the Update command to bring the
   * offering into conformity. `true` iff the offering is `Active`
   * AND at least one reason category is present. Equivalent to
   * the slice plan's grandfathering predicate.
   */
  readonly updateNeeded: boolean;

  /**
   * The closed set of reason categories the offering fails on.
   * Empty iff the offering is fully conformant (`updateNeeded=false`).
   */
  readonly reasonCategories: readonly ServiceOfferingReadinessReasonCategory[];

  /**
   * `true` iff the offering is grandfathered nonconforming.
   * Equivalent to `updateNeeded`; kept as a derived field for
   * inventory consumers that do not want to evaluate the
   * conjunction themselves.
   */
  readonly isGrandfatheredNonconforming: boolean;
}

/**
 * Plain-data input for the readiness predicate. Callers (the
 * Prisma service-offering repository, the in-memory adapter, the
 * operator inventory script) feed it the offering's persisted state
 * as plain data so the function remains pure and adapter-agnostic.
 *
 * `confirmationVersion` is the version currently effective for
 * this offering — derived by the caller from BOTH
 * `ServiceOfferingActivation` AND `ServiceOfferingUpdate` evidence
 * (see `deriveEffectiveConfirmationVersion` below). The
 * `currentConfirmationVersion` is the closed-set closed-version
 * the runtime requires.
 *
 * An offering whose effective `confirmationVersion` is `null`
 * (Draft-only, never activated) OR not equal to
 * `currentConfirmationVersion` (stale activation or stale update)
 * contributes the `activation-confirmation-stale` reason category
 * ONLY when the offering is Active (the slice plan's
 * grandfathering invariant does NOT block Active rows with stale
 * confirmations from remaining Available until the seller
 * republishes).
 *
 * The function is also called for non-Active offerings (Draft,
 * Paused, Archived) for the inventory script's broader scan;
 * for those rows `isAvailable` is always `false` regardless of
 * the reason categories present.
 */
export interface ServiceOfferingReadinessInput {
  readonly status: "Draft" | "Active" | "Paused" | "Archived";
  readonly title: string;
  readonly description: string;
  readonly hasPrimaryCategory: boolean;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid";
  readonly serviceAreaCount: number;
  readonly hasPricing: boolean;
  readonly confirmedLiveSampleCount: number;
  readonly sellerProfileStatus: "Draft" | "Published" | "Suspended";
  readonly confirmationVersion: string | null;
  readonly currentConfirmationVersion: string;
}

/**
 * The closed lower bound on the CONFIRMED Live sample count that
 * the activation contract enforces. The repository's
 * `buildActivationCompletenessFieldErrors` uses the same value
 * for the in-tx recheck; the readiness predicate uses it for the
 * grandfathering derivation.
 *
 * Exported separately so the inventory script can document the
 * bound in its emitted JSON without duplicating the constant.
 */
export const SERVICE_OFFERING_MIN_CONFIRMED_LIVE_SAMPLES = 1;
export const SERVICE_OFFERING_MAX_CONFIRMED_LIVE_SAMPLES = 3;

/**
 * Plain-data evidence for `deriveEffectiveConfirmationVersion`. The
 * caller (the inventory script, or any future runtime consumer)
 * fetches the latest activation row and the latest update row for
 * the offering and feeds the relevant fields here as plain data.
 *
 * Each evidence entry carries the `confirmationVersion` it wrote
 * AND the timestamp at which the event occurred. The helper uses
 * the timestamps to pick the chronologically newest evidence (see
 * `deriveEffectiveConfirmationVersion`'s docstring).
 */
export interface EffectiveConfirmationEvidence {
  readonly confirmationVersion: string;
  /**
   * When the evidence event happened. For activation rows this
   * is `activatedAt`; for update rows this is `updatedAt`. The
   * caller normalizes the field name to `occurredAt` so the
   * helper does not need to know which evidence row type it
   * inspects.
   */
  readonly occurredAt: Date;
}

/**
 * Plain-data input for `deriveEffectiveConfirmationVersion`. The
 * caller supplies the latest activation row and the latest update
 * row (or null when no such row exists). Each entry carries its
 * timestamp so the helper can select the chronologically newest
 * evidence event.
 */
export interface EffectiveConfirmationVersionInput {
  readonly latestActivation: EffectiveConfirmationEvidence | null;
  readonly latestUpdate: EffectiveConfirmationEvidence | null;
}

/**
 * Pure derivation of the effective `confirmationVersion` for a
 * ServiceOffering, merging activation and update evidence.
 *
 * Background — the slice plan permits the lifecycle:
 *
 *   Activate → Update → Pause → Reactivate
 *
 * Per the slice plan's ServiceOfferingUpdate schema comment
 * (schema.prisma:738-754) and the 86C "Owner-facing lifecycle
 * history" section: a successful `updateActive` writes the
 * current `confirmationVersion` into `ServiceOfferingUpdate`
 * WITHOUT rewriting the historical activation row, AND it does
 * not create a new `ServiceOfferingActivation` row. The original
 * activation timestamp is preserved verbatim.
 *
 * Consequence for the inventory: the offering may have BOTH a
 * `ServiceOfferingActivation` row AND a `ServiceOfferingUpdate`
 * row that disagree on `confirmationVersion`. The naive rule
 * "always prefer update when present" fails after a
 * confirmation-version rotation: a Reactivate issued AFTER the
 * version rotation writes a NEW activation row at the current
 * version, while the older update row from before the rotation
 * still carries the previous version. The newer activation is
 * authoritative because it reflects the seller's most recent
 * command that satisfied the activation contract.
 *
 * Rule:
 *   1. If BOTH an activation and an update exist, the helper
 *      selects whichever event occurred most recently (the more
 *      recent `occurredAt` wins). The helper does NOT assume an
 *      update is always newer than an activation.
 *   2. If only one of the two exists, that one's
 *      `confirmationVersion` is authoritative.
 *   3. If neither exists, the offering has never been activated
 *      (`null`).
 */
export function deriveEffectiveConfirmationVersion(
  input: EffectiveConfirmationVersionInput,
): string | null {
  // Handle the four combinations explicitly so TypeScript's
  // narrowing applies at every read site without requiring
  // non-null assertions.
  if (input.latestActivation !== null && input.latestUpdate !== null) {
    // Both evidence rows exist: pick the chronologically newest
    // event. The strict-greater-than comparison returns the
    // activation value when both timestamps are equal (a
    // same-instant Reactivate and update is impossible in
    // practice because Reactivate creates an activation row
    // without an accompanying update, and update is forbidden on
    // Paused rows; the tie-break picks the activation for
    // symmetry with the marketplace eligibility alias).
    return input.latestActivation.occurredAt > input.latestUpdate.occurredAt
      ? input.latestActivation.confirmationVersion
      : input.latestUpdate.confirmationVersion;
  }
  if (input.latestActivation !== null) {
    return input.latestActivation.confirmationVersion;
  }
  if (input.latestUpdate !== null) {
    return input.latestUpdate.confirmationVersion;
  }
  return null;
}

/**
 * Pure derivation. Returns the closed-shape readiness view.
 *
 * The function is deterministic: identical inputs produce
 * identical outputs. No side effects, no IO, no Prisma access.
 *
 * Reason category surface (purchase order matches the slice plan's
 * listing so operator-inventory consumers can render in a
 * predictable order):
 *
 *   1. title-required           — empty / whitespace title
 *   2. description-required     — empty / whitespace description
 *   3. category-required        — no primary ServiceCategory
 *   4. service-area-required    — InPerson / Hybrid with zero service areas
 *   5. pricing-required         — no explicit pricing.kind
 *   6. audio-sample-required    — fewer than 1 (or more than MAX) CONFIRMED Live samples
 *   7. activation-confirmation-stale — Active + null/mismatched confirmationVersion
 *   8. seller-profile-not-published — Active + SellerProfile not Published
 *
 * Categories 1–6 are derived from the offering's own persisted
 * fields. Categories 7–8 require the offering to be Active; for
 * non-Active offerings these are never emitted (the marketplace
 * does not require Visibility on Draft / Paused / Archived rows,
 * and the slice plan's readiness view is scoped to Active rows
 * being Available vs Update-needed).
 *
 * `isAvailable` and `updateNeeded` are independent:
 *   - `isAvailable = status === "Active"` (the marketplace
 *     eligibility alias for the durable Active state; preserved
 *     for grandfathered rows).
 *   - `updateNeeded = status === "Active" && reasonCategories.length > 0`
 *     (the actionable Update-needed signal; tracks the slice
 *     plan's grandfathering predicate directly).
 *
 * A nonconforming Active offering therefore returns BOTH
 * `isAvailable=true` AND `updateNeeded=true`. This is the
 * grandfathered state the 86E contract requires.
 */
export function deriveServiceOfferingReadiness(
  input: ServiceOfferingReadinessInput,
): ServiceOfferingReadiness {
  const reasonCategories: ServiceOfferingReadinessReasonCategory[] = [];

  if (!input.title.trim()) {
    reasonCategories.push("title-required");
  }
  if (!input.description.trim()) {
    reasonCategories.push("description-required");
  }
  if (!input.hasPrimaryCategory) {
    reasonCategories.push("category-required");
  }
  if (
    (input.serviceMode === "InPerson" || input.serviceMode === "Hybrid") &&
    input.serviceAreaCount === 0
  ) {
    reasonCategories.push("service-area-required");
  }
  if (!input.hasPricing) {
    reasonCategories.push("pricing-required");
  }
  if (
    input.confirmedLiveSampleCount < SERVICE_OFFERING_MIN_CONFIRMED_LIVE_SAMPLES ||
    input.confirmedLiveSampleCount > SERVICE_OFFERING_MAX_CONFIRMED_LIVE_SAMPLES
  ) {
    reasonCategories.push("audio-sample-required");
  }

  // Activation-confirmation-stale: ONLY for Active offerings.
  // The slice plan's grandfathering invariant preserves Active
  // rows' marketplace eligibility even when the confirmation
  // version drifts; the inventory surfaces this category so the
  // operator can plan a re-publish. A Draft / Paused / Archived
  // row is never reported as confirmation-stale because the
  // marketplace does not require Visibility on those rows.
  //
  // The `confirmationVersion` field carries the EFFECTIVE version
  // (see `deriveEffectiveConfirmationVersion`); the caller is
  // responsible for merging activation and update evidence before
  // invoking the predicate.
  if (input.status === "Active" && input.confirmationVersion !== input.currentConfirmationVersion) {
    reasonCategories.push("activation-confirmation-stale");
  }

  // seller-profile-not-published: ONLY for Active offerings. A
  // Draft / Paused / Archived offering does not require the
  // profile to be Published for the marketplace; the inventory
  // surfaces this category only for Active rows where the seller
  // could repair by republishing their profile (or pausing).
  if (input.status === "Active" && input.sellerProfileStatus !== "Published") {
    reasonCategories.push("seller-profile-not-published");
  }

  // Grandfathering semantics (86E): `isAvailable` is the durable
  // Active alias per the slice plan's Lifecycle section. It is
  // independent of `reasonCategories` so a grandfathered
  // nonconforming Active row can simultaneously report
  // `isAvailable=true` (marketplace eligibility preserved) and
  // `updateNeeded=true` (the actionable Update-needed signal).
  const isAvailable = input.status === "Active";
  const updateNeeded = input.status === "Active" && reasonCategories.length > 0;
  const isGrandfatheredNonconforming = updateNeeded;

  return {
    isAvailable,
    updateNeeded,
    reasonCategories,
    isGrandfatheredNonconforming,
  };
}
