// Repository abstraction for the M2 (#85) ServiceOffering slice.
//
// Background: BG1–BG6 establish a strict layering rule — repositories
// own Prisma queries and FOR UPDATE-locked transaction boundaries;
// services own authorization policy and use-case composition; routes
// own HTTP concerns and safe error mapping. This module defines the
// application-layer surface for the ServiceOffering slice.
//
// The repository is the only place that reads or writes the
// ServiceOffering table, the ServiceOfferingServiceArea rows, the
// ServiceOfferingPricing row, the IncludedService rows, the
// ServiceOfferingAudioSample rows (via the existing AudioRepository
// seam), and the ServiceOfferingActivation evidence rows. Other
// layers depend on this interface; the Prisma + in-memory adapters
// live next to it.
//
// Three domain-level write operations are exposed on this seam:
//   - `createDraft` — atomic lazy first-create tied to the Workspace's
//     SellerProfile. Same-attempt retries converge on the same
//     offeringId via the `(workspaceId, idempotencyKey)` unique
//     index on a sibling creation-evidence row. A separate attempt
//     (a distinct idempotencyKey) creates a NEW offering.
//   - `saveDraft` — resume / update-draft on an existing Draft
//     offering. The (offeringId, draftIdempotencyKey) compare-and-
//     set UPDATE serializes same-attempt retries; a deliberate
//     different offeringId targets a different row.
//   - `activate` — atomic Draft → Active transition with immutable
//     evidence row insertion. The (offeringId, idempotencyKey)
//     unique constraint on `service_offering_activations` is the
//     second defense against transport-retry duplicates; the first
//     defense is the application-layer pre-check in
//     `ServiceOfferingService.activate`. The activation transaction
//     ALSO re-counts CONFIRMED Live samples inside the lock so a
//     concurrent remove cannot produce a newly Active offering with
//     zero qualifying samples (per PR-review feedback #4).
//
// Three read operations are exposed:
//   - `findForOwner` — OwnerView read for the editor on-mount GET.
//   - `listForOwner` — OwnerView list for the editor listing page.
//   - `countLiveConfirmedSamples` — CONFIRMED Live audio sample count
//     for the activation completeness check. "Confirmed" means the
//     sample carries the current closed media-use confirmation
//     version and an actor + timestamp; legacy samples without
//     confirmation metadata do not satisfy the activation gate.

import type {
  ApiFieldErrorV1,
  ServiceOfferingActivationConfirmationVersionV1,
  ServiceOfferingOwnerSampleSummaryV1,
} from "@soundhub/types";

export interface ServiceOfferingDraftInput {
  readonly offeringId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string;
  readonly primaryCategoryKey: string | null;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid" | null;
  readonly serviceAreas: readonly {
    readonly countryCode: string;
    readonly region?: string;
    readonly city?: string;
  }[];
  readonly pricing: {
    readonly kind: "Fixed" | "StartingAt" | "ContactForQuote";
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly unitId?: string;
  } | null;
  readonly genreTags: readonly string[];
  readonly includedServiceCategoryKeys: readonly string[];
  readonly now: Date;
  readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
}

export interface ServiceOfferingCreateDraftInput {
  readonly workspaceId: string;
  /**
   * Acting human who clicked "Create service". Recorded for audit
   * on the creation-evidence row.
   */
  readonly createdByUserId: string;
  /**
   * Client-supplied UUID generated when the user clicks "Create
   * service". The (workspaceId, idempotencyKey) tuple is the
   * unique convergence key — a transport retry that races with
   * the original POST returns the SAME offeringId; a deliberate
   * distinct click (a new idempotencyKey) creates a NEW offering.
   */
  readonly idempotencyKey: string;
  readonly requestId: string;
  /**
   * The first-save draft payload. M2 (#85) PR-review feedback
   * (round 3): the stable identity is created atomically from
   * the first Save action — the offering row is NOT persisted
   * separately from the user's submitted fields. A "create"
   * that produces an empty row and lets the user navigate away
   * leaves a meaningless orphan behind; the create-and-save
   * is one transaction.
   */
  readonly title: string;
  readonly description: string;
  readonly primaryCategoryKey: string | null;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid" | null;
  readonly serviceAreas: readonly {
    readonly countryCode: string;
    readonly region?: string;
    readonly city?: string;
  }[];
  readonly pricing: {
    readonly kind: "Fixed" | "StartingAt" | "ContactForQuote";
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly unitId?: string;
  } | null;
  readonly genreTags: readonly string[];
  readonly includedServiceCategoryKeys: readonly string[];
  readonly now: Date;
  readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
}

export interface ServiceOfferingActivateInput {
  readonly offeringId: string;
  readonly workspaceId: string;
  readonly sellerProfileId: string;
  readonly activatedByUserId: string;
  readonly title: string;
  readonly description: string;
  readonly primaryCategoryKey: string;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid";
  readonly serviceAreas: readonly {
    readonly countryCode: string;
    readonly region?: string;
    readonly city?: string;
  }[];
  readonly pricing: {
    readonly kind: "Fixed" | "StartingAt" | "ContactForQuote";
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly unitId?: string;
  };
  readonly genreTags: readonly string[];
  readonly includedServiceCategoryKeys: readonly string[];
  readonly confirmationVersion: ServiceOfferingActivationConfirmationVersionV1;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now: Date;
  readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
}

/**
 * Narrow activation completeness payload — the fields the
 * repository-owned activation recheck validates inside the
 * transaction. The service-layer `assertActivationCompleteness`
 * mirrors this shape so the source-of-truth validation (the
 * repository's in-tx recheck) produces the same field-error list the
 * editor renders.
 */
export interface ServiceOfferingActivationCompleteness {
  readonly title: string;
  readonly description: string;
  readonly primaryCategoryKey: string;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid";
  readonly serviceAreas: readonly { readonly countryCode: string }[];
  readonly pricingKind: "Fixed" | "StartingAt" | "ContactForQuote";
}

/**
 * Build the canonical `ApiFieldErrorV1[]` for the activation
 * completeness contract. The repository owns this so the in-tx
 * recheck and the service-layer pre-check produce the SAME list
 * (same codes, same messages) — the editor renders one shape.
 */
export function buildActivationCompletenessFieldErrors(
  input: ServiceOfferingActivationCompleteness,
): ApiFieldErrorV1[] {
  const fields: ApiFieldErrorV1[] = [];
  if (!input.title.trim()) {
    fields.push({
      path: "title",
      code: "title_required",
      message: "Title is required to activate.",
    });
  }
  if (!input.description.trim()) {
    fields.push({
      path: "description",
      code: "description_required",
      message: "Description is required to activate.",
    });
  }
  if (!input.primaryCategoryKey) {
    fields.push({
      path: "primaryCategoryKey",
      code: "category_required",
      message: "A controlled primary ServiceCategory is required to activate.",
    });
  }
  if (input.serviceMode === "InPerson" || input.serviceMode === "Hybrid") {
    if (input.serviceAreas.length === 0) {
      fields.push({
        path: "serviceAreas",
        code: "service_area_required",
        message: "At least one coarse service area is required for InPerson or Hybrid offerings.",
      });
    }
  }
  if (!input.pricingKind) {
    fields.push({
      path: "pricing.kind",
      code: "pricing_required",
      message: "An explicit pricing choice is required to activate.",
    });
  }
  return fields;
}

export interface ServiceOfferingActivationEvidenceView {
  readonly activatedAt: Date;
  readonly confirmationVersion: ServiceOfferingActivationConfirmationVersionV1;
  readonly idempotencyKey: string;
}

// M2 (#86): ServiceOfferingPause evidence and input shapes.
//
// Pause authorization is independent of activation completeness — a
// grandfathered nonconforming Active offering must remain pausable
// without satisfying the activation contract. Pause therefore records
// only the facts established by the Pause command (no
// `confirmationVersion` column — fabricating such a column would
// invent an attestation the Pause command did not invoke).
//
// The repository resolves `sellerProfileId` from the locked offering
// row inside the transaction; the field is NOT taken from the input
// because the route does not have a stable reference to it. The
// repository also requires a `playbackUrlFor` resolver so the returned
// OwnerView's sample entries carry valid URLs (the
// `serviceOfferingOwnerSampleSummaryV1Schema.playbackUrl` field is a
// `z.string().url()`; a missing resolver makes the response un-parseable
// for any conforming Active offering that has at least one CONFIRMED
// Live sample).
export type ServiceOfferingPauseReasonValue = "user_initiated" | "final_sample_removal";

export interface ServiceOfferingPauseInput {
  readonly offeringId: string;
  readonly workspaceId: string;
  readonly pausedByUserId: string;
  readonly reason: ServiceOfferingPauseReasonValue;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now: Date;
  readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
}

export interface ServiceOfferingPauseEvidenceView {
  readonly pausedAt: Date;
  readonly reason: ServiceOfferingPauseReasonValue;
  readonly idempotencyKey: string;
}

export interface ServiceOfferingPauseResult {
  readonly offering: ServiceOfferingOwnerViewRecord;
  readonly evidence: ServiceOfferingPauseEvidenceView;
  /**
   * `true` when the operation converged on an already-persisted
   * pause row (transport retry after a lost response). The caller
   * treats this as success.
   */
  readonly convergedFromExistingPause: boolean;
}

// M2 (#86): ServiceOfferingReactivate input — same STRICT public
// field set as activation because the repository re-runs the same
// activation completeness check. Failure leaves the offering Paused
// (no new ServiceOfferingActivation row written). The reactivation
// idempotencyKey is bound to the existing
// (offeringId, idempotencyKey) DB unique constraint on the
// `service_offering_activations` table.
export interface ServiceOfferingReactivateInput {
  readonly offeringId: string;
  readonly workspaceId: string;
  readonly reactivatedByUserId: string;
  readonly title: string;
  readonly description: string;
  readonly primaryCategoryKey: string;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid";
  readonly serviceAreas: readonly {
    readonly countryCode: string;
    readonly region?: string;
    readonly city?: string;
  }[];
  readonly pricing: {
    readonly kind: "Fixed" | "StartingAt" | "ContactForQuote";
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly unitId?: string;
  };
  readonly genreTags: readonly string[];
  readonly includedServiceCategoryKeys: readonly string[];
  readonly confirmationVersion: ServiceOfferingActivationConfirmationVersionV1;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now: Date;
  readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
}

// M2 (#86): ServiceOfferingUpdateActive input — same STRICT public
// field set as activation because the repository runs the same
// activation completeness check before replacing the public fields
// atomically. The lifecycle does NOT change (Active → Active); the
// existing ServiceOfferingActivation rows are NOT touched. The
// idempotencyKey is bound to a NEW unique index on the
// `service_offering_updates` table.
export interface ServiceOfferingUpdateActiveInput {
  readonly offeringId: string;
  readonly workspaceId: string;
  readonly sellerProfileId: string;
  readonly updatedByUserId: string;
  readonly title: string;
  readonly description: string;
  readonly primaryCategoryKey: string;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid";
  readonly serviceAreas: readonly {
    readonly countryCode: string;
    readonly region?: string;
    readonly city?: string;
  }[];
  readonly pricing: {
    readonly kind: "Fixed" | "StartingAt" | "ContactForQuote";
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly unitId?: string;
  };
  readonly genreTags: readonly string[];
  readonly includedServiceCategoryKeys: readonly string[];
  readonly confirmationVersion: ServiceOfferingActivationConfirmationVersionV1;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly now: Date;
  readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
}

export interface ServiceOfferingUpdateEvidenceView {
  readonly updatedAt: Date;
  readonly confirmationVersion: ServiceOfferingActivationConfirmationVersionV1;
  readonly idempotencyKey: string;
}

export interface ServiceOfferingUpdateActiveResult {
  readonly offering: ServiceOfferingOwnerViewRecord;
  readonly evidence: ServiceOfferingUpdateEvidenceView;
  /**
   * `true` when the operation converged on an already-persisted
   * update row (transport retry after a lost response). The caller
   * treats this as success.
   */
  readonly convergedFromExistingUpdate: boolean;
}

export interface ServiceOfferingOwnerViewRecord {
  readonly serviceOfferingId: string;
  readonly workspaceId: string;
  readonly sellerProfileId: string;
  readonly status: "Draft" | "Active" | "Paused" | "Archived";
  readonly title: string;
  readonly description: string;
  readonly primaryCategoryKey: string | null;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid" | null;
  readonly serviceAreas: readonly {
    readonly countryCode: string;
    readonly region?: string;
    readonly city?: string;
  }[];
  readonly pricing: {
    readonly kind: "Fixed" | "StartingAt" | "ContactForQuote";
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly unitId?: string;
  } | null;
  readonly genreTags: readonly string[];
  readonly includedServiceCategoryKeys: readonly string[];
  readonly samples: readonly ServiceOfferingOwnerSampleSummaryV1[];
  readonly activatedAt: Date | null;
  readonly activatedByDisplayName: string | null;
}

export interface ServiceOfferingActivationResult {
  readonly offering: ServiceOfferingOwnerViewRecord;
  readonly evidence: ServiceOfferingActivationEvidenceView;
  /**
   * `true` when the operation converged on an already-persisted
   * activation (transport retry after a lost response). The caller
   * treats this as success.
   */
  readonly convergedFromExistingActivation: boolean;
}

export class ServiceOfferingNotFoundError extends Error {
  constructor(public readonly offeringId: string) {
    super(`No ServiceOffering found for offeringId ${offeringId}`);
    this.name = "ServiceOfferingNotFoundError";
  }
}

export class ServiceOfferingNotDraftError extends Error {
  constructor(
    public readonly offeringId: string,
    public readonly currentStatus: "Draft" | "Active" | "Paused" | "Archived",
  ) {
    super(`ServiceOffering ${offeringId} is ${currentStatus}; activation requires Draft`);
    this.name = "ServiceOfferingNotDraftError";
  }
}

export class ServiceOfferingNotOwnedError extends Error {
  constructor(
    public readonly offeringId: string,
    public readonly workspaceId: string,
  ) {
    super(`ServiceOffering ${offeringId} is not owned by workspace ${workspaceId}`);
    this.name = "ServiceOfferingNotOwnedError";
  }
}

/**
 * Raised when a request supplies a syntactically valid but
 * semantically unknown controlled-value key (ServiceCategory.key or
 * PricingUnit.key). Surfaces as a 4xx SERVICE_OFFERING_INVALID so
 * the editor's multi-error summary can highlight the offending
 * field rather than collapsing to a spurious 500.
 */
export class ServiceOfferingUnknownKeyError extends Error {
  constructor(
    public readonly field: "primaryCategoryKey" | "pricingUnitId" | "includedServiceCategoryKeys",
    public readonly key: string,
  ) {
    super(`Unknown ${field}: ${key}`);
    this.name = "ServiceOfferingUnknownKeyError";
  }
}

/**
 * Raised by the repository's `activate` method when the activation
 * transaction's re-check finds the offering does not satisfy the
 * activation contract — either the field-level payload is missing
 * a required value, or fewer than one qualifying CONFIRMED Live
 * sample remains inside the lock (a concurrent remove dropped the
 * last sample after the service-layer pre-check passed). The
 * repository owns the source-of-truth revalidation so a race
 * window between the service-layer pre-check and the activation
 * transaction cannot activate an incomplete offering.
 *
 * The `fieldErrors` carry the same `ApiFieldErrorV1` shape the
 * editor renders. The repository's recheck produces the same
 * field-error list the service-layer pre-check produced before
 * the rework so the editor renders identical UI.
 *
 * Surfaces as `SERVICE_OFFERING_INCOMPLETE` so the editor renders
 * the same field-error summary it would render for any other
 * activation-completeness gap.
 */
export class ServiceOfferingIncompleteError extends Error {
  constructor(
    public readonly reasons: readonly string[],
    public readonly fieldErrors: readonly ApiFieldErrorV1[] = [],
  ) {
    super(`Activation completeness re-check failed: ${reasons.join(", ")}`);
    this.name = "ServiceOfferingIncompleteError";
  }
}

/**
 * Raised by `createDraft` when the Workspace has no SellerProfile.
 * The FK on `service_offerings.sellerProfileId` requires one; the
 * editor's onboarding flow only reaches "Create service" after
 * profile creation, so this error surfaces as 422
 * `SERVICE_OFFERING_INCOMPLETE` (the precondition for offering
 * creation is not yet met) rather than as a generic 500.
 */
export class ServiceOfferingSellerProfileMissingError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`No SellerProfile for workspace ${workspaceId}`);
    this.name = "ServiceOfferingSellerProfileMissingError";
  }
}

// M2 (#86): typed errors for the post-activation lifecycle commands.
// The service layer translates each into the corresponding safe
// envelope via `mapStatus` (see `apps/api/src/lib/errors.ts`).

/**
 * Raised by `pause` when the offering row does not exist.
 */
export class ServiceOfferingNotActiveError extends Error {
  constructor(
    public readonly offeringId: string,
    public readonly currentStatus: "Draft" | "Active" | "Paused" | "Archived",
  ) {
    super(`ServiceOffering ${offeringId} is ${currentStatus}; pause requires Active`);
    this.name = "ServiceOfferingNotActiveError";
  }
}

/**
 * Raised by `pause` when the offering has already transitioned to
 * Paused AND no pause evidence row exists for the supplied
 * idempotencyKey (the lookup-before-precondition rule from the
 * corrected idempotency table). A retry of the same
 * previously-committed idempotencyKey converges on the existing
 * pause row and does NOT surface this error.
 */
export class ServiceOfferingAlreadyPausedError extends Error {
  constructor(public readonly offeringId: string) {
    super(`ServiceOffering ${offeringId} is already Paused`);
    this.name = "ServiceOfferingAlreadyPausedError";
  }
}

/**
 * Raised by `reactivate` when the offering is not in Paused state
 * AND no ServiceOfferingActivation evidence row exists for the
 * supplied reactivation idempotencyKey. Surfaced as 409
 * `SERVICE_OFFERING_NOT_PAUSED`.
 */
export class ServiceOfferingNotPausedError extends Error {
  constructor(
    public readonly offeringId: string,
    public readonly currentStatus: "Draft" | "Active" | "Paused" | "Archived",
  ) {
    super(`ServiceOffering ${offeringId} is ${currentStatus}; reactivate requires Paused`);
    this.name = "ServiceOfferingNotPausedError";
  }
}

/**
 * Raised by `updateActive` when the offering is not in Active state
 * AND no ServiceOfferingUpdate evidence row exists for the supplied
 * update idempotencyKey. Surfaced as 409 `SERVICE_OFFERING_NOT_ACTIVE`.
 */
export class ServiceOfferingUpdateNotActiveError extends Error {
  constructor(
    public readonly offeringId: string,
    public readonly currentStatus: "Draft" | "Active" | "Paused" | "Archived",
  ) {
    super(`ServiceOffering ${offeringId} is ${currentStatus}; updateActive requires Active`);
    this.name = "ServiceOfferingUpdateNotActiveError";
  }
}

/**
 * Raised by `updateActive` when the payload fails the activation
 * completeness check inside the transaction. Surfaced as 422
 * `SERVICE_OFFERING_INVALID_UPDATE` carrying the field-error list.
 * Mirrors the `ServiceOfferingIncompleteError` semantics for the
 * update flow.
 */
export class ServiceOfferingInvalidUpdateError extends Error {
  constructor(
    public readonly reasons: readonly string[],
    public readonly fieldErrors: readonly ApiFieldErrorV1[] = [],
  ) {
    super(`Update completeness re-check failed: ${reasons.join(", ")}`);
    this.name = "ServiceOfferingInvalidUpdateError";
  }
}

/**
 * M2 (#86, slice 86B, Codex review fix): raised by `reactivate`
 * when the SellerProfile's publication status changes between the
 * service-level precondition and the repository transaction
 * (or when the SellerProfile is not Published at the moment of
 * the repository check). The check runs INSIDE the locked
 * transaction AFTER the idempotency lookup and BEFORE the activation
 * evidence row is inserted, so:
 *   - a same-key retry of an already-committed Reactivate still
 *     converges on the existing activation row regardless of
 *     current SellerProfile status;
 *   - a fresh Reactivate against a now-Suspended SellerProfile is
 *     rejected with the same `SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED`
 *     envelope the service-level precondition uses.
 * Surfaced as 422 `SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED`.
 */
export class ServiceOfferingSellerProfileNotPublishedError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly sellerProfileId: string,
    public readonly currentStatus: "Draft" | "Published" | "Suspended",
  ) {
    super(
      `ServiceOffering reactivate requires a Published SellerProfile (workspace ${workspaceId} profile ${sellerProfileId} is ${currentStatus}).`,
    );
    this.name = "ServiceOfferingSellerProfileNotPublishedError";
  }
}

export interface ServiceOfferingRepository {
  /**
   * Atomically create a Draft ServiceOffering for the Workspace's
   * SellerProfile. Idempotent on the `(workspaceId, idempotencyKey)`
   * tuple via the sibling creation-evidence row — a transport retry
   * with the same idempotencyKey returns the SAME offeringId, while
   * a distinct idempotencyKey (a deliberate second click) creates a
   * fresh offering.
   *
   * M2 (#85) PR-review feedback (round 3): the spec requires the
   * stable identity to be created on the first successful save.
   * Calling `createDraft` without persisting the user's submitted
   * fields lets the user navigate away and leave a meaningless
   * orphan behind. The repository therefore creates the offering
   * AND persists the supplied draft fields in ONE transaction;
   * the editor's "Save Draft" button invokes this on first save
   * (no offeringId yet) and `saveDraft` on subsequent saves.
   *
   * Throws `ServiceOfferingSellerProfileMissingError` when the
   * Workspace has no SellerProfile — the offering FK requires one.
   * Throws `ServiceOfferingUnknownKeyError` when the payload's
   * category or pricing unit keys cannot be resolved to DB ids.
   */
  createDraft(input: ServiceOfferingCreateDraftInput): Promise<ServiceOfferingOwnerViewRecord>;

  /**
   * Save the draft — resume or update-draft on an existing Draft.
   * Idempotent on `offeringId`. A Draft may be re-saved
   * indefinitely; an Active / Paused / Archived offering is rejected
   * with `ServiceOfferingNotDraftError`. The repository THROWS
   * `ServiceOfferingNotFoundError` when no offering exists for the
   * supplied id — lazy first-create lives on the dedicated
   * `createDraft` method so update vs create have separate
   * authorization paths.
   */
  saveDraft(input: ServiceOfferingDraftInput): Promise<ServiceOfferingOwnerViewRecord>;

  /**
   * Atomic Draft → Active transition + immutable evidence row
   * insertion. The idempotencyKey is bound to the (offeringId,
   * idempotencyKey) DB unique constraint; a transport retry with
   * the same key converges on the already-persisted evidence. The
   * caller's pre-check is the first defense; the DB unique index
   * is the second.
   *
   * INSIDE the activation transaction the repository re-counts
   * CONFIRMED Live samples (per PR-review feedback #4) so a
   * concurrent remove between the service-layer pre-check and
   * commit cannot leave a newly Active offering with zero
   * qualifying samples. Throws `ServiceOfferingIncompleteError`
   * when the re-check finds the offering no longer satisfies the
   * activation contract.
   *
   * Throws `ServiceOfferingNotDraftError` if the offering has
   * already left the Draft state. Throws `ServiceOfferingNotFoundError`
   * if the offering row does not exist.
   */
  activate(input: ServiceOfferingActivateInput): Promise<ServiceOfferingActivationResult>;

  /**
   * Read the current ServiceOffering OwnerView for the Workspace.
   * Returns `null` when no offering row exists for `offeringId`.
   * Returns the row regardless of status so the editor can recover
   * from a Paused / Archived state on subsequent tickets.
   */
  findForOwner(input: {
    readonly workspaceId: string;
    readonly offeringId: string;
    readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
  }): Promise<ServiceOfferingOwnerViewRecord | null>;

  /**
   * List the ServiceOffering OwnerView rows for the Workspace.
   * Used by the editor listing page; no second, independently
   * deployable list lives in the browser.
   */
  listForOwner(input: {
    readonly workspaceId: string;
    readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
  }): Promise<readonly ServiceOfferingOwnerViewRecord[]>;

  /**
   * Count CONFIRMED Live audio samples for the offering. A sample
   * qualifies only when `cleanupStatus = Live` AND the row carries
   * the current closed media-use confirmation version (plus an
   * actor and timestamp). The repository-owned activation re-check
   * uses this same predicate so activation completeness and the
   * editor's readiness checklist cannot drift.
   */
  countLiveConfirmedSamples(offeringId: string): Promise<number>;

  // -------------------------------------------------------------------------
  // M2 (#86): post-activation lifecycle commands.
  //
  // `pause` (slice 86B) and `reactivate` (slice 86B) are required
  // methods — both adapters implement them. `updateActive` remains
  // optional and lands in slice 86C.
  //
  // Idempotency contract enforced by each implementation, in order:
  //   1. acquire transaction + advisory lock(s)
  //   2. lookup `(offeringId, idempotencyKey)` evidence row
  //   3. if found → return as converged success
  //   4. otherwise enforce the lifecycle precondition (status check)
  //   5. then execute the command
  // -------------------------------------------------------------------------

  /**
   * Atomic Active → Paused transition + append-only evidence row
   * insertion. The (offeringId, idempotencyKey) DB unique constraint
   * on `service_offering_pauses` is the second defense against
   * transport-retry duplicates; the per-offering advisory lock
   * acquired at the start of the transaction is the first.
   *
   * Throws `ServiceOfferingNotFoundError` if the offering row does
   * not exist. Throws `ServiceOfferingAlreadyPausedError` if the
   * offering has already transitioned to Paused and the lookup
   * found no row for the supplied idempotencyKey (the precondition
   * runs AFTER the idempotency pre-check, so a same-key retry
   * converges on the existing pause row and does NOT surface this
   * error). Throws `ServiceOfferingNotActiveError` if the offering
   * is Draft or Archived. Throws `ServiceOfferingNotOwnedError` if
   * the offering is owned by a different workspace.
   */
  pause(input: ServiceOfferingPauseInput): Promise<ServiceOfferingPauseResult>;

  /**
   * Atomic Paused → Active transition + new ServiceOfferingActivation
   * evidence row insertion. The (offeringId, idempotencyKey) DB
   * unique constraint on `service_offering_activations` is the
   * second defense; the per-offering + per-offering audio-sample
   * advisory locks are the first.
   *
   * INSIDE the transaction the repository re-runs the activation
   * completeness check (`buildActivationCompletenessFieldErrors` +
   * CONFIRMED Live sample count + `SellerProfile.published`
   * precondition). Throws `ServiceOfferingIncompleteError` when the
   * re-check fails. Throws `ServiceOfferingNotFoundError` /
   * `ServiceOfferingNotOwnedError` / `ServiceOfferingNotPausedError`
   * per the slice 86B precondition rules.
   */
  reactivate(input: ServiceOfferingReactivateInput): Promise<ServiceOfferingActivationResult>;

  /**
   * Atomic Active → Active update: validate the complete resulting
   * state, in-place update the public fields, append a new
   * ServiceOfferingUpdate evidence row. The existing
   * ServiceOfferingActivation rows are NOT touched (the activation
   * timestamp from the original Draft → Active transition is
   * preserved verbatim per ADR 0008).
   *
   * The (offeringId, idempotencyKey) DB unique constraint on
   * `service_offering_updates` is the second defense; the
   * per-offering + audio-sample advisory locks are the first.
   *
   * Throws `ServiceOfferingIncompleteError` (mapped to
   * SERVICE_OFFERING_INVALID_UPDATE) when the re-check fails.
   * Throws `ServiceOfferingNotFoundError` /
   * `ServiceOfferingNotOwnedError` / `ServiceOfferingNotActiveError`
   * per the slice 86C precondition rules.
   */
  updateActive?(
    input: ServiceOfferingUpdateActiveInput,
  ): Promise<ServiceOfferingUpdateActiveResult>;
}
