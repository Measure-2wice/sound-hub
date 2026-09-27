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
//     professional identity is in the public catalog.
//   - `ServiceOfferingRepository.saveDraft` for the lazy first-save /
//     resume / update-draft flow.
//   - `ServiceOfferingRepository.activate` for the atomic
//     Draft → Active transition with same-attempt retry convergence
//     via `idempotencyKey`.
//
// The service exposes typed errors that the route layer translates to
// the safe error envelope via `buildSafeError` + `mapStatus`. The
// service NEVER echoes Prisma error messages; every cross-boundary
// error is a stable `ServiceOfferingServiceError` instance.
//
// Atomicity invariants:
//   - `saveDraft` is idempotent w.r.t. the same (offeringId,
//     payload) pair via the application-layer compare-and-set
//     UPDATE inside the repository.
//   - `activate` is idempotent w.r.t. the same
//     `(offeringId, idempotencyKey)` pair via the application-layer
//     pre-check + the DB unique index
//     `service_offering_activations_offering_idem_unique_idx`.
//   - All three write methods run inside a `Prisma.$transaction` on
//     the Prisma adapter; the in-memory adapter uses a
//     per-offering mutex chain. A failure mid-write rolls back
//     atomically.

import type {
  ApiFieldErrorV1,
  ServiceOfferingActivateRequestV1,
  ServiceOfferingActivationResponseV1,
  ServiceOfferingDraftRequestV1,
  ServiceOfferingDraftResponseV1,
  ServiceOfferingGetResponseV1,
  ServiceOfferingOwnerListResponseV1,
} from "@soundhub/types";
import type {
  ServiceOfferingOwnerViewRecord,
  ServiceOfferingRepository,
} from "../repositories/service-offering.repository.js";
import { ServiceOfferingNotDraftError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingNotFoundError } from "../repositories/service-offering.repository.js";
import { ServiceOfferingNotOwnedError } from "../repositories/service-offering.repository.js";
import type { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";
import { BG2_AUDIO_SAMPLE_MAX_PER_OFFERING } from "@soundhub/types";

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

    const existing = await this.deps.repository.findForOwner({
      workspaceId: input.workspaceId,
      offeringId: input.offeringId,
      playbackUrlFor: this.deps.playbackUrlFor,
    });
    if (!existing) {
      throw new ServiceOfferingServiceError(
        "ServiceOffering not found for this Workspace.",
        "SERVICE_OFFERING_NOT_FOUND",
      );
    }
    const liveSampleCount = await this.deps.repository.countLiveSamples(input.offeringId);
    this.assertActivationCompleteness({
      request: input.request,
      liveSampleCount,
    });

    try {
      const result = await this.deps.repository.activate({
        offeringId: input.offeringId,
        workspaceId: input.workspaceId,
        sellerProfileId: existing.sellerProfileId,
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
      // safe envelope collapses this to a 403 FORBIDDEN; the
      // offering id is not echoed.
      return new ServiceOfferingServiceError(
        "Acting Workspace is not the owner of this ServiceOffering.",
        "SERVICE_OFFERING_FORBIDDEN",
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

  /**
   * Validate the activation contract at the trusted boundary so a
   * direct API client cannot smuggle an incomplete payload through.
   * Mirrors `SellerProfileService.assertPublishCompleteness`.
   */
  private assertActivationCompleteness(input: {
    readonly request: ServiceOfferingActivateRequestV1;
    readonly liveSampleCount: number;
  }): void {
    const fields: ApiFieldErrorV1[] = [];
    if (!input.request.title.trim()) {
      fields.push({
        path: "title",
        code: "title_required",
        message: "Title is required to activate.",
      });
    }
    if (!input.request.description.trim()) {
      fields.push({
        path: "description",
        code: "description_required",
        message: "Description is required to activate.",
      });
    }
    if (!input.request.primaryCategoryKey) {
      fields.push({
        path: "primaryCategoryKey",
        code: "category_required",
        message: "A controlled primary ServiceCategory is required to activate.",
      });
    }
    if (input.request.serviceMode === "InPerson" || input.request.serviceMode === "Hybrid") {
      if (input.request.serviceAreas.length === 0) {
        fields.push({
          path: "serviceAreas",
          code: "service_area_required",
          message: "At least one coarse service area is required for InPerson or Hybrid offerings.",
        });
      }
    }
    if (!input.request.pricing.kind) {
      fields.push({
        path: "pricing.kind",
        code: "pricing_required",
        message: "An explicit pricing choice is required to activate.",
      });
    }
    if (input.liveSampleCount < 1 || input.liveSampleCount > BG2_AUDIO_SAMPLE_MAX_PER_OFFERING) {
      fields.push({
        path: "samples",
        code: "samples_required",
        message: `Activation requires 1 to ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING} playable samples.`,
      });
    }
    if (fields.length > 0) {
      throw new ServiceOfferingServiceError(
        "Activation requires a complete ServiceOffering.",
        "SERVICE_OFFERING_INCOMPLETE",
        fields,
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

function toResponseOwnerView(
  record: ServiceOfferingOwnerViewRecord,
): ServiceOfferingDraftResponseV1["offering"] {
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
  };
}

export { ServiceOfferingNotDraftError, ServiceOfferingNotFoundError, ServiceOfferingNotOwnedError };
