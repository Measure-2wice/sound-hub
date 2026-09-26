// SellerProfile service (M2 #84).
//
// Background: BG1-BG6 establish a strict layering rule — services own
// authorization policy and use-case composition; routes own HTTP
// concerns and safe error mapping; repositories own Prisma queries
// and FOR UPDATE-locked transaction boundaries.
//
// This service is the single owner of the seller-profile write/read
// use cases for a Seller-capable Personal Workspace. It composes:
//
//   - `WorkspaceAuthorizationService.requirePersonalActingMembership`
//     (Personal-Workspace-only — Organization seller-profile
//     administration is out of #84 scope per the user's directive).
//   - `WorkspaceAuthorizationService.requireCapability` for the
//     Seller capability precondition.
//   - `SellerProfileRepository.saveDraft` for the lazy first-save /
//     resume / update-draft flow.
//   - `SellerProfileRepository.publishProfile` and
//     `updatePublishedProfile` for the publication flow with
//     same-attempt retry convergence via `idempotencyKey`.
//
// The service exposes typed errors that the route layer translates to
// the safe error envelope via `buildSafeError` + `mapStatus`. The
// service NEVER echoes Prisma error messages; every cross-boundary
// error is a stable `SellerProfileServiceError` instance.
//
// Atomicity invariants:
//   - `saveDraft` is idempotent w.r.t. the same (workspaceId,
//     payload) pair via the unique constraint on
//     `seller_profiles.workspaceId`.
//   - `publishProfile` and `updatePublishedProfile` are idempotent
//     w.r.t. the same `(workspaceId, idempotencyKey)` pair via the
//     application-layer pre-check + the DB unique index.
//   - All three write methods run inside a `Prisma.$transaction` on
//     the Prisma adapter; the in-memory adapter uses a per-Workspace
//     mutex chain. A failure mid-write rolls back atomically.

import {
  type SellerProfileDraftRequestV1,
  type SellerProfileDraftResponseV1,
  type SellerProfileGetResponseV1,
  type SellerProfilePublicationResponseV1,
  type SellerProfilePublishRequestV1,
  type SellerProfileUpdateRequestV1,
} from "@soundhub/types";
import type {
  SellerProfileRepository} from "../repositories/seller-profile.repository.js";
import {
  type SellerProfileOwnerViewRecord,
  type SellerProfilePublicationResult
} from "../repositories/seller-profile.repository.js";
import { SellerProfileNotDraftError } from "../repositories/seller-profile.repository.js";
import { SellerProfileNotPublishedError } from "../repositories/seller-profile.repository.js";
import type { WorkspaceAuthorizationService } from "./workspace-authorization.service.js";

export class SellerProfileServiceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "SELLER_PROFILE_INVALID"
      | "SELLER_PROFILE_FORBIDDEN"
      | "SELLER_PROFILE_NOT_FOUND"
      | "SELLER_PROFILE_DUPLICATE"
      | "SELLER_PROFILE_INCOMPLETE"
      | "SELLER_PROFILE_NOT_DRAFT"
      | "SELLER_PROFILE_NOT_PUBLISHED"
      | "SELLER_PROFILE_INTERNAL_FAILED",
  ) {
    super(message);
    this.name = "SellerProfileServiceError";
  }
}

export interface SellerProfileServiceDeps {
  readonly repository: SellerProfileRepository;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
}

export interface SellerProfileSaveDraftInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly request: SellerProfileDraftRequestV1;
}

export interface SellerProfilePublishInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly request: SellerProfilePublishRequestV1;
  readonly requestId: string;
}

export interface SellerProfileUpdateInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly request: SellerProfileUpdateRequestV1;
  readonly requestId: string;
}

export interface SellerProfileGetCurrentInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
}

export class SellerProfileService {
  constructor(private readonly deps: SellerProfileServiceDeps) {}

  async saveDraft(input: SellerProfileSaveDraftInput): Promise<SellerProfileDraftResponseV1> {
    this.assertCompleteDraftFields(input.request);
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    try {
      const profile = await this.deps.repository.saveDraft({
        workspaceId: input.workspaceId,
        identity: input.request.identity,
        basedIn: input.request.basedIn,
        disciplines: input.request.disciplines,
        now: new Date(),
      });
      return {
        ok: true,
        profile: toResponseProfile(profile),
        returnTo: input.request.returnTo ?? null,
        safeReturnTo: null,
      };
    } catch (err) {
      throw this.translateRepositoryError(err);
    }
  }

  async publishProfile(
    input: SellerProfilePublishInput,
  ): Promise<SellerProfilePublicationResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    this.assertPublishCompleteness(input.request);
    try {
      const result = await this.deps.repository.publishProfile({
        workspaceId: input.workspaceId,
        identity: input.request.identity,
        basedIn: input.request.basedIn,
        disciplines: input.request.disciplines,
        confirmationVersion: input.request.confirmationVersion,
        idempotencyKey: input.request.idempotencyKey,
        requestId: input.requestId,
        publishedByUserId: input.userAccountId,
        now: new Date(),
      });
      return this.toPublicationResponse(result, input.request.returnTo ?? null);
    } catch (err) {
      throw this.translateRepositoryError(err);
    }
  }

  async updatePublishedProfile(
    input: SellerProfileUpdateInput,
  ): Promise<SellerProfilePublicationResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    this.assertUpdateCompleteness(input.request);
    try {
      const result = await this.deps.repository.updatePublishedProfile({
        workspaceId: input.workspaceId,
        identity: input.request.identity,
        basedIn: input.request.basedIn,
        disciplines: input.request.disciplines,
        confirmationVersion: input.request.confirmationVersion,
        idempotencyKey: input.request.idempotencyKey,
        requestId: input.requestId,
        publishedByUserId: input.userAccountId,
        now: new Date(),
      });
      return this.toPublicationResponse(result, input.request.returnTo ?? null);
    } catch (err) {
      throw this.translateRepositoryError(err);
    }
  }

  async getCurrentProfile(
    input: SellerProfileGetCurrentInput,
  ): Promise<SellerProfileGetResponseV1> {
    await this.assertPersonalSellerCapability(input.userAccountId, input.workspaceId);
    const profile = await this.deps.repository.findCurrentProfile(input.workspaceId);
    return {
      ok: true,
      profile: profile ? toResponseProfile(profile) : null,
    };
  }

  /**
   * Translate a repository-layer error into the stable typed
   * service error so the route layer can collapse it into the safe
   * envelope via `mapStatus`. The repository contract is the only
   * surface that owns persistence errors; the service owns the
   * translation.
   */
  private translateRepositoryError(err: unknown): SellerProfileServiceError {
    if (err instanceof SellerProfileServiceError) {
      return err;
    }
    if (err instanceof SellerProfileNotDraftError) {
      return new SellerProfileServiceError(
        `Publish requires a Draft profile; current status is ${err.currentStatus}`,
        "SELLER_PROFILE_NOT_DRAFT",
      );
    }
    if (err instanceof SellerProfileNotPublishedError) {
      return new SellerProfileServiceError(
        "Update requires a Published profile",
        "SELLER_PROFILE_NOT_PUBLISHED",
      );
    }
    return new SellerProfileServiceError(
      "An unexpected error occurred while persisting the seller profile.",
      "SELLER_PROFILE_INTERNAL_FAILED",
    );
  }

  // ---------- private helpers ----------

  private async assertPersonalSellerCapability(
    userAccountId: string,
    workspaceId: string,
  ): Promise<void> {
    // Personal-Workspace-only authorization. Organization seller
    // administration is out of #84 scope. The helper throws
    // PersonalActingMembershipError; we translate to the typed
    // service error so the route layer can collapse it into the
    // safe envelope with the other authorization failures.
    try {
      await this.deps.workspaceAuthorizationService.requirePersonalActingMembership({
        userAccountId,
        workspaceId,
      });
    } catch {
      throw new SellerProfileServiceError(
        "Personal-Workspace-only authorization rejected",
        "SELLER_PROFILE_FORBIDDEN",
      );
    }
    try {
      await this.deps.workspaceAuthorizationService.requireCapability({
        userAccountId,
        workspaceId,
        requiredCapability: "Seller",
      });
    } catch {
      throw new SellerProfileServiceError(
        "Seller capability precondition failed",
        "SELLER_PROFILE_FORBIDDEN",
      );
    }
  }

  private assertCompleteDraftFields(request: SellerProfileDraftRequestV1): void {
    if (!request.identity.professionalName.trim()) {
      throw new SellerProfileServiceError("professionalName is required", "SELLER_PROFILE_INVALID");
    }
    if (!request.identity.bio.trim()) {
      throw new SellerProfileServiceError("bio is required", "SELLER_PROFILE_INVALID");
    }
    if (!request.basedIn.countryCode) {
      throw new SellerProfileServiceError(
        "basedIn.countryCode is required",
        "SELLER_PROFILE_INVALID",
      );
    }
  }

  private assertPublishCompleteness(request: SellerProfilePublishRequestV1): void {
    if (request.disciplines.specialtyKeys.length < 1) {
      throw new SellerProfileServiceError(
        "At least one controlled specialty is required to publish.",
        "SELLER_PROFILE_INCOMPLETE",
      );
    }
    if (request.disciplines.caribbeanAffiliationCodes.length < 1) {
      throw new SellerProfileServiceError(
        "At least one Caribbean affiliation is required to publish.",
        "SELLER_PROFILE_INCOMPLETE",
      );
    }
  }

  private assertUpdateCompleteness(request: SellerProfileUpdateRequestV1): void {
    if (request.disciplines.specialtyKeys.length < 1) {
      throw new SellerProfileServiceError(
        "At least one controlled specialty is required.",
        "SELLER_PROFILE_INCOMPLETE",
      );
    }
    if (request.disciplines.caribbeanAffiliationCodes.length < 1) {
      throw new SellerProfileServiceError(
        "At least one Caribbean affiliation is required.",
        "SELLER_PROFILE_INCOMPLETE",
      );
    }
  }

  private toPublicationResponse(
    result: SellerProfilePublicationResult,
    returnTo: string | null,
  ): SellerProfilePublicationResponseV1 {
    return {
      ok: true,
      profile: toResponseProfile(result.profile),
      evidence: {
        publishedAt: result.evidence.publishedAt.toISOString(),
        confirmationVersion: result.evidence.confirmationVersion,
        idempotencyKey: result.evidence.idempotencyKey,
      },
      returnTo,
      safeReturnTo: null,
    };
  }
}

export function toResponseProfile(
  profile: SellerProfileOwnerViewRecord,
): SellerProfilePublicationResponseV1["profile"] {
  const basedIn: { countryCode: string; region?: string; city?: string } = {
    countryCode: profile.basedIn.countryCode,
  };
  if (profile.basedIn.region !== undefined) basedIn.region = profile.basedIn.region;
  if (profile.basedIn.city !== undefined) basedIn.city = profile.basedIn.city;
  const identity: { professionalName: string; bio: string; avatarUrl?: string } = {
    professionalName: profile.identity.professionalName,
    bio: profile.identity.bio,
  };
  if (profile.identity.avatarUrl !== undefined) {
    identity.avatarUrl = profile.identity.avatarUrl;
  }
  const result: SellerProfilePublicationResponseV1["profile"] = {
    sellerProfileId: profile.sellerProfileId,
    workspaceId: profile.workspaceId,
    status: profile.status,
    identity,
    basedIn,
    disciplines: profile.disciplines,
  };
  if (profile.publishedAt) {
    (result as { publishedAt?: string }).publishedAt = profile.publishedAt.toISOString();
  }
  if (profile.publishedByDisplayName) {
    (result as { publishedByDisplayName?: string }).publishedByDisplayName =
      profile.publishedByDisplayName;
  }
  return result;
}

export { SellerProfileNotDraftError, SellerProfileNotPublishedError };
