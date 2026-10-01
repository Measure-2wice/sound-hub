// ServiceOffering service (M2 #85).
//
// Background: BG1–BG6 establish a strict layering rule — services own
// authorization policy and use-case composition; routes own HTTP
// concerns and safe error mapping; repositories own Prisma queries
// and FOR UPDATE-locked transaction boundaries.
//
// This service is the single owner of the seller-offering write/read
// use cases for a Seller-capable Personal Workspace. It composes:
//   - `WorkspaceAuthorizationService.requirePersonalActingMembership`
//     (Personal-Workspace-only — Organization seller-offering
//     administration is out of #85 scope per the user's directive).
//   - `WorkspaceAuthorizationService.requireCapability` for the
//     Seller capability precondition.
//   - The SellerProfile's Published status: activation requires a
//     Published SellerProfile so draft-profile sellers cannot
//     activate a marketplace-eligible offering before their
//     professional identity is in the public catalog. The
//     createDraft path does NOT require Published (a Draft
//     SellerProfile can own a Draft offering).
//   - `ServiceOfferingRepository.createDraft` for the lazy first-create
//     flow. Idempotent on the `(workspaceId, idempotencyKey)` tuple
//     via the sibling creation-evidence row.
//   - `ServiceOfferingRepository.saveDraft` for the resume /
//     update-draft flow.
//   - `ServiceOfferingRepository.activate` for the atomic
//     Draft → Active transition with same-attempt retry convergence
//     via `idempotencyKey`. The activation transaction ALSO re-counts
//     CONFIRMED Live samples inside the lock so a concurrent remove
//     cannot produce a newly Active offering with zero qualifying
//     samples (per PR-review feedback #4). The repository's
//     recheck is the source of truth; the service-layer pre-check
//     was removed to avoid the race window.
//
// The service exposes typed errors that the route layer translates to
// the safe error envelope via `buildSafeError` + `mapStatus`. The
// service NEVER echoes Prisma error messages; every cross-boundary
// error is a stable `ServiceOfferingServiceError` instance.
//
// Atomicity invariants:
//   - `createDraft` is idempotent w.r.t. the same
//     `(workspaceId, idempotencyKey)` pair via the application-layer
//     pre-check + the sibling creation-evidence unique index.
//   - `saveDraft` is idempotent w.r.t. the same (offeringId,
//     payload) pair via the application-layer compare-and-set
//     UPDATE inside the repository.
//   - `activate` is idempotent w.r.t. the same
//     `(offeringId, idempotencyKey)` pair via the application-layer
//     pre-check + the DB unique index
//     `service_offering_activations_offering_idem_unique_idx`. The
//     activation transaction also re-counts CONFIRMED Live samples
//     and rejects with SERVICE_OFFERING_INCOMPLETE if the count
//     drops below the minimum inside the lock.
//   - All three write methods run inside a `Prisma.$transaction` on
//     the Prisma adapter; the in-memory adapter uses a
//     per-offering mutex chain. A failure mid-write rolls back
//     atomically.

import type {
  ApiFieldErrorV1,
  ServiceOfferingActivateRequestV1,
  ServiceOfferingActivationResponseV1,
  ServiceOfferingCreateDraftRequestV1,
  ServiceOfferingDraftRequestV1,
  ServiceOfferingDraftResponseV1,
  ServiceOfferingGetResponseV1,
  ServiceOfferingOwnerListResponseV1,
  ServiceOfferingOwnerViewV1,
  ServiceOfferingPauseResponseV1,
  ServiceOfferingUpdateRequestV1,
  ServiceOfferingUpdateResponseV1,
} from "@soundhub/types";
import type {
  ServiceOfferingOwnerViewRecord,
  ServiceOfferingRepository,
} from "../repositories/service-offering.repository.js";
import { ServiceOfferingAlreadyPausedError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingIncompleteError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingInvalidUpdateError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingNotActiveError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingNotDraftError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingNotFoundError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingNotOwnedError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingNotPausedError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingSellerProfileMissingError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingSellerProfileNotPublishedError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingUnknownKeyError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingUpdateNotActiveError } from "../repositories/service-offering.repository.js";
import type { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";

export class ServiceOfferingServiceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "SERVICE_OFFERING_INVALID"
      | "SERVICE_OFFERING_FORBIDDEN"
      | "SERVICE_OFFERING_NOT_FOUND"
      | "SERVICE_OFFERING_INCOMPLETE"
      | "SERVICE_OFFERING_NOT_DRAFT"
      | "SERVICE_OFFERING_ALREADY_ACTIVE"
      | "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED"
      | "SERVICE_OFFERING_ALREADY_PAUSED"
      | "SERVICE_OFFERING_NOT_PAUSED"
      | "SERVICE_OFFERING_NOT_ACTIVE"
      | "SERVICE_OFFERING_INVALID_UPDATE"
      | "SERVICE_OFFERING_INTERNAL_FAILED",
    public readonly fieldErrors: readonly ApiFieldErrorV1[] = [],
  ) {
    super(message);
    this.name = "ServiceOfferingServiceError";
  }
}

export interface ServiceOfferingServiceDeps {
  readonly repository: ServiceOfferingRepository;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  /**
   * Read the SellerProfile's status for the acting Workspace. The
   * service uses this to assert the SellerProfile is Published
   * before activation. The route layer wires a thin function that
   * reads through the Prisma client; tests inject a stub.
   */
  readonly getSellerProfileStatus: (input: {
    readonly workspaceId: string;
  }) => Promise<"Draft" | "Published" | "Suspended" | null>;
  /**
   * Compose the SoundHub-owned in-app playback URL. Mirrors the
   * `AudioSampleService.playbackUrlFor` helper so the editor can
   * render a `<audio>` element without reaching for storage
   * internals.
   */
  readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
  /**
   * Optional clock. Tests inject a controlled clock so activation
   * timestamps are deterministic.
   */
  readonly now?: () => Date;
}

export interface ServiceOfferingCreateDraftInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  /**
   * M2 (#85) PR-review feedback (round 3): the first-save draft
   * payload. The repository creates the offering AND persists these
   * fields atomically — no orphan empty rows. A deliberate
   * second click with a new idempotencyKey creates a NEW offering
   * row AND starts a fresh field-set.
   */
  readonly draft: ServiceOfferingCreateDraftRequestV1;
}

export interface ServiceOfferingSaveDraftInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly offeringId: string;
  readonly request: ServiceOfferingDraftRequestV1;
}

export interface ServiceOfferingActivateInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly offeringId: string;
  readonly request: ServiceOfferingActivateRequestV1;
  readonly requestId: string;
}

// M2 (#86, slice 86B): the Pause command carries only the
// idempotencyKey. The repository resolves the workspaceId /
// offeringId / pausedByUserId / reason from the input + the
// persisted row. The service-level authorization precondition
// (`assertPersonalSellerCapability`) gates by userAccountId and
// workspaceId — both sourced from the route's resolveActor helper.
export interface ServiceOfferingPauseServiceInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly offeringId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

// M2 (#86, slice 86B): Reactivate accepts the same STRICT public
// field set as Activate (the schema alias `serviceOfferingReactivateRequestV1Schema`
// is the existing `serviceOfferingActivateRequestV1Schema`). The
// service-level `SellerProfile.published` precondition is enforced
// before the repository call — mirroring the Activate flow.
export interface ServiceOfferingReactivateServiceInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly offeringId: string;
  readonly request: ServiceOfferingActivateRequestV1;
  readonly requestId: string;
}

// M2 (#86, slice 86C): Active → Active update command input.
// Reuses the existing STRICT activation request schema via the
// alias `serviceOfferingUpdateRequestV1Schema` — the request
// carries the complete replacement public field set so the
// repository can run the same activation contract. The `request`
// field is typed as `ServiceOfferingUpdateRequestV1` (an alias of
// `ServiceOfferingActivateRequestV1`) to keep route → service
// typing symmetric with the activate / reactivate flows.
export interface ServiceOfferingUpdateActiveServiceInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly offeringId: string;
  readonly request: ServiceOfferingUpdateRequestV1;
  readonly requestId: string;
}

export interface ServiceOfferingGetInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly offeringId: string;
}

export interface ServiceOfferingListInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
}

export class ServiceOfferingService {
  constructor(private readonly deps: ServiceOfferingServiceDeps) {}

  /**
   * M2 (#85) PR-review feedback (round 3): lazy first-create bound
   * to the first Save action. Delegates to the repository's
   * `createDraft` which (a) enforces same-attempt retry
   * convergence on `(workspaceId, idempotencyKey)` via the sibling
   * creation-evidence row, and (b) atomically persists the
   * supplied draft fields in the same transaction. No empty orphan
   * row can be left behind — the create-and-save is one operation.
   * The SellerProfile must exist for the Workspace but does NOT
   * have to be Published — a Draft profile can own a Draft
   * offering and the editor's onboarding path only reaches "Save
   * Draft" after profile creation.
   */
  async createDraft(input: ServiceOfferingCreateDraftInput): Promise<ServiceOfferingOwnerViewV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    const draft = input.draft;
    try {
      const offering = await this.deps.repository.createDraft({
        workspaceId: input.workspaceId,
        createdByUserId: input.userAccountId,
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId,
        title: draft.title ?? "",
        description: draft.description ?? "",
        primaryCategoryKey: draft.primaryCategoryKey ?? null,
        serviceMode: draft.serviceMode ?? null,
        serviceAreas: (draft.serviceAreas ?? []).map((sa) => ({
          countryCode: sa.countryCode,
          ...(sa.region !== undefined ? { region: sa.region } : {}),
          ...(sa.city !== undefined ? { city: sa.city } : {}),
        })),
        pricing: draft.pricing ? toPricingInput(draft.pricing) : null,
        genreTags: draft.genreTags ?? [],
        includedServiceCategoryKeys: draft.includedServiceCategoryKeys ?? [],
        now: new Date(),
        playbackUrlFor: this.deps.playbackUrlFor,
      });
      return toResponseOwnerView(offering);
    } catch (err) {
      throw this.translateRepositoryError(err);
    }
  }

  async saveDraft(input: ServiceOfferingSaveDraftInput): Promise<ServiceOfferingDraftResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    try {
      const offering = await this.deps.repository.saveDraft({
        offeringId: input.offeringId,
        workspaceId: input.workspaceId,
        title: input.request.title ?? "",
        description: input.request.description ?? "",
        primaryCategoryKey: input.request.primaryCategoryKey ?? null,
        serviceMode: input.request.serviceMode ?? null,
        serviceAreas: input.request.serviceAreas ?? [],
        pricing: input.request.pricing ? toPricingInput(input.request.pricing) : null,
        genreTags: input.request.genreTags ?? [],
        includedServiceCategoryKeys: input.request.includedServiceCategoryKeys ?? [],
        now: new Date(),
        playbackUrlFor: this.deps.playbackUrlFor,
      });
      return {
        ok: true,
        offering: toResponseOwnerView(offering),
        returnTo: input.request.returnTo ?? null,
        safeReturnTo: null,
      };
    } catch (err) {
      throw this.translateRepositoryError(err);
    }
  }

  async activate(
    input: ServiceOfferingActivateInput,
  ): Promise<ServiceOfferingActivationResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    const sellerProfileStatus = await this.deps.getSellerProfileStatus({
      workspaceId: input.workspaceId,
    });
    if (sellerProfileStatus !== "Published") {
      throw new ServiceOfferingServiceError(
        "ServiceOffering activation requires a Published SellerProfile.",
        "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED",
      );
    }

    // M2 (#85) PR-review feedback: the activation transaction
    // owns the source-of-truth sample re-check (it runs INSIDE
    // the same advisory lock as the Draft → Active transition).
    // The service-layer pre-check is gone — its race window was
    // the bug. The repository raises
    // ServiceOfferingIncompleteError when the re-check fails,
    // which the service translates to the existing
    // SERVICE_OFFERING_INCOMPLETE envelope code.
    try {
      const result = await this.deps.repository.activate({
        offeringId: input.offeringId,
        workspaceId: input.workspaceId,
        sellerProfileId: "",
        activatedByUserId: input.userAccountId,
        title: input.request.title,
        description: input.request.description,
        primaryCategoryKey: input.request.primaryCategoryKey,
        serviceMode: input.request.serviceMode,
        serviceAreas: input.request.serviceAreas,
        pricing: toPricingInput(input.request.pricing)!,
        genreTags: input.request.genreTags,
        includedServiceCategoryKeys: input.request.includedServiceCategoryKeys,
        confirmationVersion: input.request.confirmationVersion,
        idempotencyKey: input.request.idempotencyKey,
        requestId: input.requestId,
        now: new Date(),
        playbackUrlFor: this.deps.playbackUrlFor,
      });
      return {
        ok: true,
        offering: toResponseOwnerView(result.offering),
        evidence: {
          activatedAt: result.evidence.activatedAt.toISOString(),
          confirmationVersion: result.evidence.confirmationVersion,
          idempotencyKey: result.evidence.idempotencyKey,
        },
        returnTo: input.request.returnTo ?? null,
        safeReturnTo: null,
      };
    } catch (err) {
      throw this.translateRepositoryError(err);
    }
  }

  /**
   * M2 (#86, slice 86B): Active → Paused transition. The Pause
   * authorization is independent of activation completeness — a
   * grandfathered nonconforming Active offering must remain
   * pausable. The service-level precondition is
   * `assertPersonalSellerCapability` only; no `SellerProfile.published`
   * check (Pause does not require it). The repository owns the
   * lookup-before-precondition idempotency contract, the resolved
   * `sellerProfileId` lookup, and the `playbackUrlFor` plumbing
   * for CONFIRMED Live samples.
   */
  async pause(input: ServiceOfferingPauseServiceInput): Promise<ServiceOfferingPauseResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    try {
      const result = await this.deps.repository.pause({
        offeringId: input.offeringId,
        workspaceId: input.workspaceId,
        pausedByUserId: input.userAccountId,
        reason: "user_initiated",
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId,
        now: new Date(),
        // The playbackUrlFor resolver threads the in-transaction
        // OwnerView's CONFIRMED Live sample URLs so the response
        // schema's `z.string().url()` check passes for conforming
        // Active offerings.
        playbackUrlFor: this.deps.playbackUrlFor,
      });
      return {
        ok: true,
        offering: toResponseOwnerView(result.offering),
        evidence: {
          pausedAt: result.evidence.pausedAt.toISOString(),
          reason: result.evidence.reason,
          idempotencyKey: result.evidence.idempotencyKey,
        },
        returnTo: null,
        safeReturnTo: null,
      };
    } catch (err) {
      throw this.translateRepositoryError(err);
    }
  }

  /**
   * M2 (#86, slice 86B, Codex review fix): Paused → Active transition.
   * Reactivation re-runs the complete current activation contract —
   * the same STRICT public field set + `confirmationVersion` as
   * Activate. Failure leaves the offering Paused; no new
   * `ServiceOfferingActivation` row is written on failure.
   *
   * The `SellerProfile.published` precondition is enforced INSIDE the
   * repository transaction (after the idempotency lookup, before the
   * evidence insert) so a concurrent unpublish/suspension between the
   * service-layer check and the transaction commit cannot cause a
   * non-conforming Reactivate, and a same-key retry of an already-
   * committed Reactivate still converges regardless of the current
   * SellerProfile status.
   */
  async reactivate(
    input: ServiceOfferingReactivateServiceInput,
  ): Promise<ServiceOfferingActivationResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    try {
      const result = await this.deps.repository.reactivate({
        offeringId: input.offeringId,
        workspaceId: input.workspaceId,
        // (sellerProfileId removed; repository resolves from locked row)
        reactivatedByUserId: input.userAccountId,
        title: input.request.title,
        description: input.request.description,
        primaryCategoryKey: input.request.primaryCategoryKey,
        serviceMode: input.request.serviceMode,
        serviceAreas: input.request.serviceAreas,
        pricing: toPricingInput(input.request.pricing)!,
        genreTags: input.request.genreTags,
        includedServiceCategoryKeys: input.request.includedServiceCategoryKeys,
        confirmationVersion: input.request.confirmationVersion,
        idempotencyKey: input.request.idempotencyKey,
        requestId: input.requestId,
        now: new Date(),
        playbackUrlFor: this.deps.playbackUrlFor,
      });
      return {
        ok: true,
        offering: toResponseOwnerView(result.offering),
        evidence: {
          activatedAt: result.evidence.activatedAt.toISOString(),
          confirmationVersion: result.evidence.confirmationVersion,
          idempotencyKey: result.evidence.idempotencyKey,
        },
        returnTo: input.request.returnTo ?? null,
        safeReturnTo: null,
      };
    } catch (err) {
      throw this.translateRepositoryError(err);
    }
  }

  /**
   * M2 (#86, slice 86C): Active → Active update. The repository
   * runs the same STRICT activation contract (field-level
   * completeness + CONFIRMED Live sample count) plus the
   * `SellerProfile.published` precondition INSIDE the locked
   * transaction — same race-safety pattern as `reactivate`. The
   * service-layer `SellerProfile.published` pre-check used by
   * `activate` is intentionally NOT used here: a concurrent
   * SellerProfile suspension between the service-level check and
   * the repository commit could otherwise leave an updated Active
   * offering associated with a now-Suspended profile. The
   * repository's in-transaction check under the workspaceLock
   * (slice 86B re-review precedent) closes that window. The
   * service-layer `assertPersonalSellerCapability` precondition
   * is the same Personal-Workspace-only + Seller-capable gate
   * every other consequential ServiceOffering command enforces.
   */
  async updateActive(
    input: ServiceOfferingUpdateActiveServiceInput,
  ): Promise<ServiceOfferingUpdateResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    try {
      const result = await this.deps.repository.updateActive({
        offeringId: input.offeringId,
        workspaceId: input.workspaceId,
        // (sellerProfileId removed; repository resolves from locked row)
        updatedByUserId: input.userAccountId,
        title: input.request.title,
        description: input.request.description,
        primaryCategoryKey: input.request.primaryCategoryKey,
        serviceMode: input.request.serviceMode,
        serviceAreas: input.request.serviceAreas,
        pricing: toPricingInput(input.request.pricing)!,
        genreTags: input.request.genreTags,
        includedServiceCategoryKeys: input.request.includedServiceCategoryKeys,
        confirmationVersion: input.request.confirmationVersion,
        idempotencyKey: input.request.idempotencyKey,
        requestId: input.requestId,
        now: new Date(),
        playbackUrlFor: this.deps.playbackUrlFor,
      });
      return {
        ok: true,
        offering: toResponseOwnerView(result.offering),
        evidence: {
          updatedAt: result.evidence.updatedAt.toISOString(),
          confirmationVersion: result.evidence.confirmationVersion,
          idempotencyKey: result.evidence.idempotencyKey,
        },
        returnTo: input.request.returnTo ?? null,
        safeReturnTo: null,
      };
    } catch (err) {
      throw this.translateRepositoryError(err);
    }
  }

  async getCurrentOffering(input: ServiceOfferingGetInput): Promise<ServiceOfferingGetResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    const offering = await this.deps.repository.findForOwner({
      workspaceId: input.workspaceId,
      offeringId: input.offeringId,
      playbackUrlFor: this.deps.playbackUrlFor,
    });
    return {
      ok: true,
      offering: offering ? toResponseOwnerView(offering) : null,
    };
  }

  async listOfferingsForOwner(
    input: ServiceOfferingListInput,
  ): Promise<ServiceOfferingOwnerListResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    const offerings = await this.deps.repository.listForOwner({
      workspaceId: input.workspaceId,
      playbackUrlFor: this.deps.playbackUrlFor,
    });
    return {
      ok: true,
      offerings: offerings.map(toResponseOwnerView),
    };
  }

  /**
   * Translate a repository-layer error into the stable typed
   * service error so the route layer can collapse it into the safe
   * envelope via `mapStatus`. The repository contract is the only
   * surface that owns persistence errors; the service owns the
   * translation.
   */
  private translateRepositoryError(err: unknown): ServiceOfferingServiceError {
    if (err instanceof ServiceOfferingServiceError) return err;
    if (err instanceof ServiceOfferingNotFoundError) {
      return new ServiceOfferingServiceError(
        `ServiceOffering ${err.offeringId} not found.`,
        "SERVICE_OFFERING_NOT_FOUND",
      );
    }
    if (err instanceof ServiceOfferingNotDraftError) {
      return new ServiceOfferingServiceError(
        `Activation requires a Draft ServiceOffering; current status is ${err.currentStatus}.`,
        "SERVICE_OFFERING_NOT_DRAFT",
      );
    }
    if (err instanceof ServiceOfferingNotOwnedError) {
      // The acting Workspace does not own this ServiceOffering. The
      // safe envelope collapses this to a 404 NOT_FOUND rather
      // than 403 FORBIDDEN so a cross-Workspace requester cannot
      // distinguish "exists but not yours" from "does not exist".
      // The offering id is not echoed.
      return new ServiceOfferingServiceError(
        "ServiceOffering not found for this Workspace.",
        "SERVICE_OFFERING_NOT_FOUND",
      );
    }
    if (err instanceof ServiceOfferingUnknownKeyError) {
      return new ServiceOfferingServiceError(
        `Unknown ${err.field}: ${err.key}`,
        "SERVICE_OFFERING_INVALID",
        [
          {
            path: err.field,
            code: "unknown_controlled_value",
            message: `Unknown ${err.field}: ${err.key}`,
          },
        ],
      );
    }
    if (err instanceof ServiceOfferingSellerProfileMissingError) {
      // Surface the missing SellerProfile as the same
      // SERVICE_OFFERING_INCOMPLETE envelope the activation
      // precondition produces — the editor's onboarding path
      // already routes the seller through profile creation, so a
      // missing profile here indicates a state the UI cannot
      // recover from without redirecting back to onboarding.
      return new ServiceOfferingServiceError(
        "ServiceOffering creation requires a SellerProfile for the Workspace.",
        "SERVICE_OFFERING_INCOMPLETE",
        [
          {
            path: "sellerProfile",
            code: "seller_profile_required",
            message: "Create your seller profile before authoring a service offering.",
          },
        ],
      );
    }
    if (err instanceof ServiceOfferingIncompleteError) {
      // The repository's activation recheck failed inside the
      // advisory lock — either a field-level value is missing
      // or a concurrent remove dropped the last CONFIRMED sample
      // after the caller's pre-check passed. Map to the same
      // SERVICE_OFFERING_INCOMPLETE envelope the service-layer
      // pre-check used to produce; the repository's
      // `fieldErrors` carry the same `ApiFieldErrorV1` shape the
      // editor renders.
      return new ServiceOfferingServiceError(
        "Activation requires a complete ServiceOffering.",
        "SERVICE_OFFERING_INCOMPLETE",
        err.fieldErrors,
      );
    }
    // M2 (#86, slice 86B): post-activation lifecycle errors.
    if (err instanceof ServiceOfferingNotActiveError) {
      return new ServiceOfferingServiceError(
        `ServiceOffering ${err.offeringId} is ${err.currentStatus}; this command requires Active.`,
        "SERVICE_OFFERING_NOT_ACTIVE",
      );
    }
    if (err instanceof ServiceOfferingAlreadyPausedError) {
      return new ServiceOfferingServiceError(
        `ServiceOffering ${err.offeringId} is already Paused.`,
        "SERVICE_OFFERING_ALREADY_PAUSED",
      );
    }
    if (err instanceof ServiceOfferingNotPausedError) {
      return new ServiceOfferingServiceError(
        `ServiceOffering ${err.offeringId} is ${err.currentStatus}; reactivate requires Paused.`,
        "SERVICE_OFFERING_NOT_PAUSED",
      );
    }
    if (err instanceof ServiceOfferingSellerProfileNotPublishedError) {
      return new ServiceOfferingServiceError(
        `ServiceOffering reactivate requires a Published SellerProfile (workspace ${err.workspaceId} profile ${err.sellerProfileId} is ${err.currentStatus}).`,
        "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED",
      );
    }
    // M2 (#86, slice 86C): Active → Active update errors. The
    // repository raises Update-specific typed errors so the
    // service can map them to the dedicated `SERVICE_OFFERING_*
    // _UPDATE` envelope rather than reusing the activation
    // envelope codes.
    if (err instanceof ServiceOfferingUpdateNotActiveError) {
      return new ServiceOfferingServiceError(
        `ServiceOffering ${err.offeringId} is ${err.currentStatus}; update requires Active.`,
        "SERVICE_OFFERING_NOT_ACTIVE",
      );
    }
    if (err instanceof ServiceOfferingInvalidUpdateError) {
      // The repository's update re-check failed inside the
      // advisory lock — either a field-level value is missing or
      // a concurrent remove dropped the last CONFIRMED sample
      // after the caller's pre-check passed. Map to the dedicated
      // `SERVICE_OFFERING_INVALID_UPDATE` envelope the slice 86A
      // closed-error contract added; the repository's
      // `fieldErrors` carry the same `ApiFieldErrorV1` shape the
      // editor renders for activation / reactivation.
      return new ServiceOfferingServiceError(
        "Update requires a complete ServiceOffering.",
        "SERVICE_OFFERING_INVALID_UPDATE",
        err.fieldErrors,
      );
    }
    return new ServiceOfferingServiceError(
      "An unexpected error occurred while persisting the ServiceOffering.",
      "SERVICE_OFFERING_INTERNAL_FAILED",
    );
  }

  // ---------- private helpers ----------

  private async assertPersonalSellerCapability(
    userAccountId: string,
    workspaceId: string,
  ): Promise<void> {
    try {
      await this.deps.workspaceAuthorizationService.requirePersonalActingMembership({
        userAccountId,
        workspaceId,
      });
    } catch {
      throw new ServiceOfferingServiceError(
        "Personal-Workspace-only authorization rejected",
        "SERVICE_OFFERING_FORBIDDEN",
      );
    }
    try {
      await this.deps.workspaceAuthorizationService.requireCapability({
        userAccountId,
        workspaceId,
        requiredCapability: "Seller",
      });
    } catch {
      throw new ServiceOfferingServiceError(
        "Seller capability precondition failed",
        "SERVICE_OFFERING_FORBIDDEN",
      );
    }
  }
}

function toPricingInput(
  pricing: ServiceOfferingDraftRequestV1["pricing"] | ServiceOfferingActivateRequestV1["pricing"],
): {
  readonly kind: "Fixed" | "StartingAt" | "ContactForQuote";
  readonly amountMinor?: number;
  readonly currency?: string;
  readonly unitId?: string;
} | null {
  if (!pricing || !pricing.kind) return null;
  return {
    kind: pricing.kind,
    ...(pricing.amountMinor !== undefined ? { amountMinor: pricing.amountMinor } : {}),
    ...(pricing.currency !== undefined ? { currency: pricing.currency } : {}),
    ...(pricing.unitId !== undefined ? { unitId: pricing.unitId } : {}),
  };
}

function toResponseOwnerView(record: ServiceOfferingOwnerViewRecord): ServiceOfferingOwnerViewV1 {
  return {
    serviceOfferingId: record.serviceOfferingId,
    workspaceId: record.workspaceId,
    sellerProfileId: record.sellerProfileId,
    status: record.status,
    title: record.title,
    description: record.description,
    primaryCategoryKey: record.primaryCategoryKey,
    serviceMode: record.serviceMode,
    serviceAreas: record.serviceAreas.map((sa) => ({
      countryCode: sa.countryCode,
      ...(sa.region !== undefined ? { region: sa.region } : {}),
      ...(sa.city !== undefined ? { city: sa.city } : {}),
    })),
    pricing: record.pricing
      ? {
          kind: record.pricing.kind,
          ...(record.pricing.amountMinor !== undefined
            ? { amountMinor: record.pricing.amountMinor }
            : {}),
          ...(record.pricing.currency !== undefined ? { currency: record.pricing.currency } : {}),
          ...(record.pricing.unitId !== undefined ? { unitId: record.pricing.unitId } : {}),
        }
      : null,
    genreTags: [...record.genreTags],
    includedServiceCategoryKeys: [...record.includedServiceCategoryKeys],
    samples: [...record.samples],
    activatedAt: record.activatedAt ? record.activatedAt.toISOString() : null,
    activatedByDisplayName: record.activatedByDisplayName,
    // M2 (#86, slice 86F): readiness is derived server-side from
    // the persisted state by the runtime; the web editor renders
    // this verbatim. The mapper passes the in-memory shape through
    // unchanged — every reason category is a plain string and
    // every flag is a boolean.
    readiness: {
      isAvailable: record.readiness.isAvailable,
      updateNeeded: record.readiness.updateNeeded,
      reasonCategories: [...record.readiness.reasonCategories],
      isGrandfatheredNonconforming: record.readiness.isGrandfatheredNonconforming,
    },
  };
}

export { ServiceOfferingNotDraftError, ServiceOfferingNotFoundError, ServiceOfferingNotOwnedError };
