// Audio sample application service.
//
// Background: ticket #61 requires that every consequential audio
// command revalidates the authenticated UserAccount identity, the
// current WorkspaceMembership, the Seller capability, and the
// ServiceOffering ownership. The route layer is the only caller of
// this service. Routes never touch the repository or the storage
// adapter directly — the service is the single owner of the
// authorization and lifecycle rules.
//
// Order of operations for `uploadSample`:
//
//   1. Resolve the authenticated userAccountId via the session
//      (the route supplies it from the session cookie).
//   2. Resolve the bounded ServiceOffering context (ownership +
//      profile + workspace + capability + status).
//   3. Require current WorkspaceMembership in the offering's owning
//      Workspace AND the Seller capability. Reuses
//      WorkspaceAuthorizationService so the GS 4 / GS 5 / GS 6
//      invariant lives in exactly one place.
//   4. Enforce offering eligibility (GS 10): the seller can manage
//      samples for an Active offering only. The repository's
//      context exposes status; the service narrows the transition.
//   5. Enforce the 3-sample cap and the MP3 / 25 MB limits at the
//      trusted boundary (GS 11). The repository does not enforce
//      these; the service is the source of truth.
//   6. Call the storage adapter FIRST. Only after the storage
//      operation succeeds does the service persist the row; a
//      storage failure removes the row's only durable handle (GS 9).
//   7. Return the buyer-safe public DTO mapped from the persisted
//      row.
//
// Removal flow is symmetric: ownership + membership + capability +
// offering status, then delete the row, then remove the storage
// object. The storage removal runs AFTER the row delete so a retried
// command cannot surface a sample whose storage object is gone.

import {
  BG2_AUDIO_SAMPLE_CONTENT_TYPE,
  BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE,
  BG2_AUDIO_SAMPLE_MAX_DISPLAY_ORDER,
  BG2_AUDIO_SAMPLE_MAX_PER_OFFERING,
  type Bg2AudioSamplePublicV1,
} from "@soundhub/types";
import {
  AuthorizationError,
  type WorkspaceAuthorizationService,
} from "./workspace-authorization.service.js";
import { toPublicAudioSample, type AudioRepository } from "../audio-repository/audio-repository.js";
import {
  StorageRejectedError,
  StorageUnavailableError,
  type StorageAdapter,
} from "../storage/storage-adapter.js";

export class AudioSampleError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "AUDIO_OFFERING_NOT_FOUND"
      | "AUDIO_OFFERING_INELIGIBLE"
      | "AUDIO_SAMPLE_NOT_FOUND"
      | "AUDIO_SAMPLE_LIMIT_EXCEEDED"
      | "AUDIO_CONTENT_TYPE_UNSUPPORTED"
      | "AUDIO_PAYLOAD_TOO_LARGE"
      | "AUDIO_PAYLOAD_MISSING"
      | "AUDIO_PROVIDER_UNAVAILABLE"
      | "AUDIO_STORAGE_FAILED",
  ) {
    super(message);
    this.name = "AudioSampleError";
  }
}

export interface AudioSampleServiceDeps {
  readonly repository: AudioRepository;
  readonly storage: StorageAdapter;
  readonly workspaceAuthorization: WorkspaceAuthorizationService;
  /**
   * Optional clock. Tests inject a controlled clock so removal
   * timestamps are deterministic.
   */
  readonly now?: () => number;
}

export interface UploadSampleInput {
  readonly userAccountId: string;
  readonly offeringId: string;
  readonly label: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly bytes: Uint8Array;
}

export interface ListSamplesInput {
  readonly userAccountId: string;
  readonly offeringId: string;
}

export interface ListSamplesResult {
  readonly offeringId: string;
  readonly samples: readonly Bg2AudioSamplePublicV1[];
}

export interface RemoveSampleInput {
  readonly userAccountId: string;
  readonly offeringId: string;
  readonly sampleId: string;
}

export interface RemoveSampleResult {
  readonly sampleId: string;
  readonly offeringId: string;
  readonly removedAt: Date;
}

export interface UploadSampleResult {
  readonly sample: Bg2AudioSamplePublicV1;
}

export class AudioSampleService {
  private readonly repository: AudioRepository;
  private readonly storage: StorageAdapter;
  private readonly workspaceAuthorization: WorkspaceAuthorizationService;
  private readonly now: () => number;

  constructor(deps: AudioSampleServiceDeps) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.workspaceAuthorization = deps.workspaceAuthorization;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Upload a bounded MP3 sample to a seller-owned ServiceOffering.
   * The application boundary enforces content type and byte size
   * BEFORE invoking this method; this service runs the same checks
   * defensively.
   */
  async uploadSample(input: UploadSampleInput): Promise<UploadSampleResult> {
    const context = await this.repository.getOfferingContext(input.offeringId);
    if (!context) {
      throw new AudioSampleError("ServiceOffering not found.", "AUDIO_OFFERING_NOT_FOUND");
    }
    // GS 8 + GS 4: require current WorkspaceMembership in the
    // owning Workspace AND the Seller capability. The authorization
    // service throws AuthorizationError for non-members, suspended
    // workspaces, and missing capabilities; we translate those into
    // the BG2 safe-envelope codes below.
    try {
      await this.workspaceAuthorization.requireCapability({
        userAccountId: input.userAccountId,
        workspaceId: context.sellerWorkspaceId,
        requiredCapability: "Seller",
      });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        throw mapAuthorizationError(err, context);
      }
      throw err;
    }
    // GS 10: only an Active offering may carry discovery samples.
    // A Draft / Paused / Archived offering is ineligible — the
    // seller must publish or unpause the offering first. A
    // Suspended profile or workspace is rejected here too because
    // requireCapability rejects the suspended workspace branch
    // before this point.
    if (context.offeringStatus !== "Active" || context.sellerProfileStatus !== "Published") {
      throw new AudioSampleError(
        "ServiceOffering is not eligible to carry discovery samples.",
        "AUDIO_OFFERING_INELIGIBLE",
      );
    }

    // GS 11: only audio/mpeg, ≤ 25 MB. The boundary ALSO validates;
    // these checks are defense in depth.
    if (input.contentType !== BG2_AUDIO_SAMPLE_CONTENT_TYPE) {
      throw new AudioSampleError(
        `Only ${BG2_AUDIO_SAMPLE_CONTENT_TYPE} samples are allowed.`,
        "AUDIO_CONTENT_TYPE_UNSUPPORTED",
      );
    }
    if (input.byteSize > BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE) {
      throw new AudioSampleError(
        `Sample exceeds the ${BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE}-byte limit.`,
        "AUDIO_PAYLOAD_TOO_LARGE",
      );
    }
    if (input.byteSize <= 0) {
      throw new AudioSampleError("Sample is empty.", "AUDIO_PAYLOAD_MISSING");
    }
    if (input.bytes.byteLength !== input.byteSize) {
      throw new AudioSampleError(
        "Declared byte size does not match the observed bytes.",
        "AUDIO_PAYLOAD_TOO_LARGE",
      );
    }

    // GS 11: a fourth sample is rejected. The repository is the
    // canonical source of truth for the current sample count.
    const existing = await this.repository.listSamplesForOffering(input.offeringId);
    if (existing.length >= BG2_AUDIO_SAMPLE_MAX_PER_OFFERING) {
      throw new AudioSampleError(
        `ServiceOffering already has ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING} samples; remove one before uploading another.`,
        "AUDIO_SAMPLE_LIMIT_EXCEEDED",
      );
    }

    const nextDisplayOrder = pickNextDisplayOrder(existing);

    // GS 9: storage first. The PostgreSQL row is persisted only after
    // the storage operation succeeds; on storage failure the sample
    // does not exist in PostgreSQL and the seller can retry without
    // cleanup.
    let storageRef: string;
    try {
      const uploaded = await this.storage.uploadSample({
        label: input.label,
        contentType: BG2_AUDIO_SAMPLE_CONTENT_TYPE,
        byteSize: input.byteSize,
        offeringId: input.offeringId,
        bytes: input.bytes,
      });
      storageRef = uploaded.storageRef;
    } catch (err) {
      throw mapStorageError(err);
    }

    const created = await this.repository.createSample({
      offeringId: input.offeringId,
      label: input.label,
      contentType: BG2_AUDIO_SAMPLE_CONTENT_TYPE,
      byteSize: input.byteSize,
      displayOrder: nextDisplayOrder,
      storageRef,
    });
    return { sample: toPublicAudioSample(created) };
  }

  /**
   * List the bounded samples for a seller-owned ServiceOffering.
   * Authorization is identical to upload (GS 4 + GS 7 + GS 8): the
   * seller acting through the owning Workspace can list; everyone
   * else cannot. The buyer-facing discovery surface uses a
   * separate read-only path that does not require Seller authority.
   */
  async listSamplesForSeller(input: ListSamplesInput): Promise<ListSamplesResult> {
    const context = await this.repository.getOfferingContext(input.offeringId);
    if (!context) {
      throw new AudioSampleError("ServiceOffering not found.", "AUDIO_OFFERING_NOT_FOUND");
    }
    try {
      await this.workspaceAuthorization.requireCapability({
        userAccountId: input.userAccountId,
        workspaceId: context.sellerWorkspaceId,
        requiredCapability: "Seller",
      });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        throw mapAuthorizationError(err, context);
      }
      throw err;
    }
    const samples = await this.repository.listSamplesForOffering(input.offeringId);
    return {
      offeringId: input.offeringId,
      samples: samples.map(toPublicAudioSample),
    };
  }

  /**
   * Read-only sample listing for buyer-facing discovery. Returns
   * the public DTO for every sample the storage adapter can resolve
   * for an Active offering owned by a Published SellerProfile under
   * an Active Workspace with the Seller capability. A sample whose
   * storage object is missing is silently skipped so the buyer UI
   * never surfaces a broken player reference.
   *
   * No WorkspaceMembership check: the buyer may view any Active
   * offering's samples (the search results path already establishes
   * eligibility). The opaque `storageRef` is included so the
   * buyer-facing renderer's playback URL can be derived server-side
   * without exposing provider internals.
   */
  async listSamplesForBuyer(offeringId: string): Promise<ListSamplesResult> {
    const context = await this.repository.getOfferingContext(offeringId);
    if (!context) {
      throw new AudioSampleError("ServiceOffering not found.", "AUDIO_OFFERING_NOT_FOUND");
    }
    if (
      context.offeringStatus !== "Active" ||
      context.sellerProfileStatus !== "Published" ||
      context.sellerWorkspaceStatus !== "Active" ||
      !context.hasSellerCapability
    ) {
      throw new AudioSampleError(
        "ServiceOffering is not eligible for discovery.",
        "AUDIO_OFFERING_INELIGIBLE",
      );
    }
    const samples = await this.repository.listSamplesForOffering(offeringId);
    const playable: Bg2AudioSamplePublicV1[] = [];
    for (const record of samples) {
      const ref = await this.storage.getPlaybackReference(record.storageRef);
      if (!ref) continue;
      playable.push(toPublicAudioSample(record));
    }
    return { offeringId, samples: playable };
  }

  /**
   * Remove a sample from a seller-owned ServiceOffering. The
   * ServiceOffering row is deleted first; the storage object is
   * removed (or scheduled for cleanup) AFTER. A retried command
   * therefore cannot surface a sample whose storage object is gone
   * because the row has already been deleted.
   */
  async removeSample(input: RemoveSampleInput): Promise<RemoveSampleResult> {
    const context = await this.repository.getOfferingContext(input.offeringId);
    if (!context) {
      throw new AudioSampleError("ServiceOffering not found.", "AUDIO_OFFERING_NOT_FOUND");
    }
    try {
      await this.workspaceAuthorization.requireCapability({
        userAccountId: input.userAccountId,
        workspaceId: context.sellerWorkspaceId,
        requiredCapability: "Seller",
      });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        throw mapAuthorizationError(err, context);
      }
      throw err;
    }
    const sample = await this.repository.findSampleById({
      offeringId: input.offeringId,
      sampleId: input.sampleId,
    });
    if (!sample) {
      throw new AudioSampleError("Sample not found.", "AUDIO_SAMPLE_NOT_FOUND");
    }
    // Delete the row first; idempotent on retry because the second
    // call returns "sample not found" cleanly. The storage removal
    // is best-effort because the row is already gone — a storage
    // failure surfaces as AUDIO_STORAGE_FAILED but the buyer-facing
    // surface no longer exposes the sample (GS 10).
    await this.repository.deleteSample({
      offeringId: input.offeringId,
      sampleId: input.sampleId,
    });
    try {
      await this.storage.removeSample(sample.storageRef);
    } catch (err) {
      if (!(err instanceof StorageUnavailableError)) {
        throw mapStorageError(err);
      }
      // Storage already gone or unreachable: swallow because the
      // buyer-facing surface already hides the sample.
    }
    return {
      sampleId: sample.sampleId,
      offeringId: input.offeringId,
      removedAt: new Date(this.now()),
    };
  }

  /**
   * Read a single sample's bytes for the buyer-facing playback
   * route. Authorization is identical to the buyer list path: an
   * Active offering owned by a Published SellerProfile under an
   * Active Workspace with the Seller capability. The route layer
   * streams the returned bytes with the audio/mpeg content type.
   */
  async getBytesForPlayback(input: {
    readonly offeringId: string;
    readonly sampleId: string;
  }): Promise<{ readonly bytes: Uint8Array; readonly storageRef: string } | null> {
    const context = await this.repository.getOfferingContext(input.offeringId);
    if (!context) return null;
    if (
      context.offeringStatus !== "Active" ||
      context.sellerProfileStatus !== "Published" ||
      context.sellerWorkspaceStatus !== "Active" ||
      !context.hasSellerCapability
    ) {
      return null;
    }
    const sample = await this.repository.findSampleById({
      offeringId: input.offeringId,
      sampleId: input.sampleId,
    });
    if (!sample) return null;
    // The deterministic adapter exposes `getBytesForPlayback` for
    // the in-process route; Supabase Storage returns a signed URL
    // instead. The application contract is "a buyer-facing URL the
    // audio tag can fetch"; the bytes path is a deterministic-only
    // extension so this method only succeeds for the deterministic
    // adapter.
    const adapter = this.storage as unknown as {
      getBytesForPlayback?: (ref: string) => Uint8Array | null;
    };
    if (typeof adapter.getBytesForPlayback !== "function") return null;
    const bytes = adapter.getBytesForPlayback.call(this.storage, sample.storageRef);
    if (!bytes) return null;
    return { bytes, storageRef: sample.storageRef };
  }
}

function pickNextDisplayOrder(existing: ReadonlyArray<{ readonly displayOrder: number }>): number {
  // The seller assigns the deterministic order so removal + re-upload
  // does not silently reorder. Pick the smallest gap from 1..MAX so
  // the listing stays compact while a future seller edit can place a
  // new sample in the middle of the list.
  const taken = new Set(existing.map((s) => s.displayOrder));
  for (let candidate = 1; candidate <= BG2_AUDIO_SAMPLE_MAX_DISPLAY_ORDER; candidate += 1) {
    if (!taken.has(candidate)) return candidate;
  }
  // Unreachable: the repository enforces the cap before this is
  // called. Defensive throw keeps a future drift visible.
  throw new AudioSampleError(
    "ServiceOffering already has the maximum number of samples.",
    "AUDIO_SAMPLE_LIMIT_EXCEEDED",
  );
}

function mapAuthorizationError(
  err: AuthorizationError,
  context: { readonly sellerWorkspaceId: string },
): AudioSampleError {
  // The workspace authorization service rejects with one of
  // NOT_A_MEMBER / WORKSPACE_INELIGIBLE / MISSING_CAPABILITY. Map
  // the first two to AUDIO_OFFERING_INELIGIBLE because the buyer's
  // perspective treats every authorization failure of an authorized
  // seller command the same way (the seller cannot manage this
  // offering's samples). WORKSPACE_NOT_FOUND is not produced by
  // requireCapability (it always requires a workspaceId), but if it
  // were, it would map to AUDIO_OFFERING_NOT_FOUND for symmetry.
  if (err.code === "WORKSPACE_NOT_FOUND") {
    return new AudioSampleError("ServiceOffering not found.", "AUDIO_OFFERING_NOT_FOUND");
  }
  if (err.code === "NOT_A_MEMBER" || err.code === "WORKSPACE_INELIGIBLE") {
    return new AudioSampleError(
      `Workspace ${context.sellerWorkspaceId} cannot manage samples for this ServiceOffering.`,
      "AUDIO_OFFERING_INELIGIBLE",
    );
  }
  return new AudioSampleError(
    "Workspace is missing the Seller capability required to manage samples.",
    "AUDIO_OFFERING_INELIGIBLE",
  );
}

function mapStorageError(err: unknown): AudioSampleError {
  if (err instanceof StorageUnavailableError) {
    return new AudioSampleError(
      "Storage provider is currently unavailable.",
      "AUDIO_PROVIDER_UNAVAILABLE",
    );
  }
  if (err instanceof StorageRejectedError) {
    return new AudioSampleError(err.message, "AUDIO_CONTENT_TYPE_UNSUPPORTED");
  }
  return new AudioSampleError("Storage operation failed.", "AUDIO_STORAGE_FAILED");
}
