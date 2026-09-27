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
// Two domain-level write operations are exposed on this seam:
//   - `saveDraft` — lazy first-save / resume / update-draft. Uses
//     the existing `service_offerings.sellerProfileId` relationship
//     to scope retries: same-attempt retry identity is enforced via
//     a (offeringId, draftIdempotencyKey) record on the activation
//     table or via a soft per-session token. The implementation
//     relies on the application's compare-and-set UPDATE to enforce
//     the at-most-one-offering-per-attempt invariant.
//   - `activate` — atomic Draft → Active transition with immutable
//     evidence row insertion. The (offeringId, idempotencyKey)
//     unique constraint on `service_offering_activations` is the
//     second defense against transport-retry duplicates; the first
//     defense is the application-layer pre-check in
//     `ServiceOfferingService.activate`.
//
// Three read operations are exposed:
//   - `findForOwner` — OwnerView read for the editor on-mount GET.
//   - `listForOwner` — OwnerView list for the editor listing page.
//   - `countLiveSamples` — Live audio sample count for the activation
//     completeness check.

import type {
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
}

export interface ServiceOfferingActivationEvidenceView {
  readonly activatedAt: Date;
  readonly confirmationVersion: ServiceOfferingActivationConfirmationVersionV1;
  readonly idempotencyKey: string;
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

export interface ServiceOfferingRepository {
  /**
   * Save the draft — lazy first-save, resume, or update-draft.
   * Idempotent on `offeringId` via the (offeringId,
   * draftIdempotencyKey) pattern. A Draft may be re-saved
   * indefinitely; an Active / Paused / Archived offering is rejected
   * with `ServiceOfferingNotDraftError`.
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
   * Count Live audio samples for the offering. Used by the
   * activation completeness assertion to enforce the
   * 1–3-qualifying-playable-samples rule without re-loading the
   * OwnerView.
   */
  countLiveSamples(offeringId: string): Promise<number>;
}
