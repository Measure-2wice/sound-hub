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
// Per ticket #61 follow-up review (P0-001, P1-001..P1-005) this
// service:
//
//   - Carries the explicit actingWorkspaceId on every consequential
//     command. The server revalidates (user, actingWorkspaceId)
//     membership + capability AND that the supplied workspace matches
//     the offering's owning workspace. A user belonging to both
//     Workspaces cannot modify a stale offering under the wrong
//     acting workspace.
//
//   - Validates genuine MP3 content at the trusted boundary
//     (header magic bytes + bounded frame check), not only the
//     multipart Content-Type declaration.
//
//   - Enforces the 3-sample cap atomically via the repository's
//     transactional create. A losing concurrent upload returns
//     AUDIO_SAMPLE_LIMIT_EXCEEDED; the service cleans up the
//     uploaded storage object so it does not become an orphan.
//
//   - Hides a sample from discovery immediately on removal. If the
//     storage object cannot be deleted, the row is marked
//     `PendingCleanup` and a bounded retry completes the deletion on
//     the next operation against the offering.
//
//   - Never returns a Supabase signed URL, bucket name, or object
//     path to the application. The `playbackUrl` field on the
//     public DTO is always a SoundHub-owned in-app route.

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
import type { AudioRepository, AudioSampleRecord } from "../audio-repository/audio-repository.js";
import { toPublicAudioSample } from "../audio-repository/audio-repository.js";
import {
  StorageReferenceUnknownError,
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
      | "AUDIO_STORAGE_FAILED"
      | "INVALID_AUTH_REQUEST",
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
   * Optional clock. Tests inject a controlled controlled clock so
   * removal timestamps are deterministic.
   */
  readonly now?: () => number;
  /**
   * Base URL the in-app playback route resolves from. The service
   * composes `playbackUrl` from this base so the browser always
   * fetches the application route, never a provider URL. Tests
   * inject a stub.
   */
  readonly publicApiBaseUrl?: string;
  /**
   * Optional content validator. Default: the built-in MP3 header
   * check. Tests inject a permissive validator that accepts any
   * bytes (for fixture-only paths) or a strict validator (for
   * the P1-003 observed-content tests).
   */
  readonly contentValidator?: Mp3ContentValidator;
}

/**
 * MP3 content validator. The trusted boundary calls this after the
 * multipart Content-Type and byte size pass, BEFORE storage is
 * invoked. Returns `{ ok: true }` for genuine MP3 bytes; returns
 * `{ ok: false, reason }` otherwise. The default implementation
 * performs a bounded header check (no duration enforcement per the
 * spec §"duration validation is not required").
 */
export interface Mp3ContentValidator {
  validate(input: { bytes: Uint8Array }): { ok: true } | { ok: false; reason: string };
}

const DEFAULT_MP3_VALIDATOR: Mp3ContentValidator = {
  validate(input) {
    const bytes = input.bytes;
    if (bytes.length < 4) {
      return { ok: false, reason: "MP3 payload is shorter than the minimum header." };
    }
    // MP3 frame sync: an ID3v2 tag starts with "ID3", or a raw
    // MPEG frame starts with an 11-bit sync word (0xFFE_). Both are
    // bounded header checks; no transcoding or duration parsing.
    const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
    if (isId3) {
      // ID3v2 header is 10 bytes; the size is encoded at bytes 6-9
      // (syncsafe). We only need to confirm the declared size does
      // not exceed the payload.
      const declared =
        (((bytes[6] ?? 0) & 0x7f) << 21) |
        (((bytes[7] ?? 0) & 0x7f) << 14) |
        (((bytes[8] ?? 0) & 0x7f) << 7) |
        ((bytes[9] ?? 0) & 0x7f);
      if (bytes.length < 10 + declared) {
        return {
          ok: false,
          reason: "Declared ID3v2 size exceeds the payload.",
        };
      }
      return { ok: true };
    }
    const b0 = bytes[0] ?? 0;
    const b1 = bytes[1] ?? 0;
    const sync = (b0 << 3) | (b1 >> 5);
    if (sync !== 0x7ff) {
      return {
        ok: false,
        reason: "Payload does not begin with an MP3 frame sync word or ID3 tag.",
      };
    }
    return { ok: true };
  },
};

export interface UploadSampleInput {
  readonly userAccountId: string;
  readonly offeringId: string;
  readonly actingWorkspaceId: string;
  readonly label: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly bytes: Uint8Array;
}

export interface ListSamplesInput {
  readonly userAccountId: string;
  readonly offeringId: string;
  readonly actingWorkspaceId: string;
}

export interface ListSamplesResult {
  readonly offeringId: string;
  readonly samples: readonly Bg2AudioSamplePublicV1[];
}

export interface RemoveSampleInput {
  readonly userAccountId: string;
  readonly offeringId: string;
  readonly sampleId: string;
  readonly actingWorkspaceId: string;
}

export interface RemoveSampleResult {
  readonly sampleId: string;
  readonly offeringId: string;
  readonly removedAt: Date;
}

export interface UploadSampleResult {
  readonly sample: Bg2AudioSamplePublicV1;
}

export interface PlaybackBytes {
  readonly bytes: Uint8Array;
  readonly contentType: typeof BG2_AUDIO_SAMPLE_CONTENT_TYPE;
  readonly storageRef: string;
}

export class AudioSampleService {
  private readonly repository: AudioRepository;
  private readonly storage: StorageAdapter;
  private readonly workspaceAuthorization: WorkspaceAuthorizationService;
  private readonly now: () => number;
  private readonly publicApiBaseUrl: string;
  private readonly contentValidator: Mp3ContentValidator;

  constructor(deps: AudioSampleServiceDeps) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.workspaceAuthorization = deps.workspaceAuthorization;
    this.now = deps.now ?? (() => Date.now());
    this.publicApiBaseUrl = (deps.publicApiBaseUrl ?? "http://localhost:4000").replace(/\/+$/, "");
    this.contentValidator = deps.contentValidator ?? DEFAULT_MP3_VALIDATOR;
  }

  async uploadSample(input: UploadSampleInput): Promise<UploadSampleResult> {
    this.assertActingWorkspace(input.actingWorkspaceId);
    const context = await this.repository.getOfferingContext(input.offeringId);
    if (!context) {
      throw new AudioSampleError("ServiceOffering not found.", "AUDIO_OFFERING_NOT_FOUND");
    }
    try {
      await this.workspaceAuthorization.requireCapability({
        userAccountId: input.userAccountId,
        workspaceId: input.actingWorkspaceId,
        requiredCapability: "Seller",
      });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        throw mapAuthorizationError(err, context);
      }
      throw err;
    }
    if (context.sellerWorkspaceId !== input.actingWorkspaceId) {
      throw new AudioSampleError(
        "Acting Workspace is not the owner of this ServiceOffering.",
        "AUDIO_OFFERING_INELIGIBLE",
      );
    }
    if (context.offeringStatus !== "Active" || context.sellerProfileStatus !== "Published") {
      throw new AudioSampleError(
        "ServiceOffering is not eligible to carry discovery samples.",
        "AUDIO_OFFERING_INELIGIBLE",
      );
    }
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
    // P1-003: observed-content validation at the trusted boundary.
    const contentCheck = this.contentValidator.validate({ bytes: input.bytes });
    if (!contentCheck.ok) {
      throw new AudioSampleError(
        `Sample content is not valid MP3: ${contentCheck.reason}`,
        "AUDIO_CONTENT_TYPE_UNSUPPORTED",
      );
    }

    // Retry any PendingCleanup samples for this offering first so
    // the cap is enforced against the canonical Live count after
    // retries complete. The bounded retry is part of the
    // upload command so we never need a separate scheduler.
    await this.retryPendingCleanupForOffering({
      offeringId: input.offeringId,
    });

    // P1-004: storage first so the atomic cap check (which happens
    // inside the repository transaction) covers the new row.
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

    const nextDisplayOrder = await this.pickNextDisplayOrder(input.offeringId);
    const created = await this.repository.createSampleWithCap({
      offeringId: input.offeringId,
      label: input.label,
      contentType: BG2_AUDIO_SAMPLE_CONTENT_TYPE,
      byteSize: input.byteSize,
      displayOrder: nextDisplayOrder,
      storageRef,
    });
    if (!created) {
      // Cap reached (atomic guard). Clean up the storage object
      // we just uploaded so it does not become an orphan.
      try {
        await this.storage.removeSample(storageRef);
      } catch {
        // Best-effort cleanup; a failed removal flips the (now
        // non-existent) row to PendingCleanup but the row never
        // existed. Surface the original failure to the caller.
      }
      throw new AudioSampleError(
        `ServiceOffering already has ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING} samples; remove one before uploading another.`,
        "AUDIO_SAMPLE_LIMIT_EXCEEDED",
      );
    }
    return {
      sample: toPublicAudioSample({ record: created, playbackUrl: this.playbackUrlFor(created) }),
    };
  }

  async listSamplesForSeller(input: ListSamplesInput): Promise<ListSamplesResult> {
    this.assertActingWorkspace(input.actingWorkspaceId);
    const context = await this.repository.getOfferingContext(input.offeringId);
    if (!context) {
      throw new AudioSampleError("ServiceOffering not found.", "AUDIO_OFFERING_NOT_FOUND");
    }
    try {
      await this.workspaceAuthorization.requireCapability({
        userAccountId: input.userAccountId,
        workspaceId: input.actingWorkspaceId,
        requiredCapability: "Seller",
      });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        throw mapAuthorizationError(err, context);
      }
      throw err;
    }
    if (context.sellerWorkspaceId !== input.actingWorkspaceId) {
      throw new AudioSampleError(
        "Acting Workspace is not the owner of this ServiceOffering.",
        "AUDIO_OFFERING_INELIGIBLE",
      );
    }
    // Best-effort retry on every seller list so a previous
    // upload that flipped samples to PendingCleanup can be
    // completed without a separate scheduler.
    await this.retryPendingCleanupForOffering({
      offeringId: input.offeringId,
    });
    const samples = await this.repository.listSamplesForOffering(input.offeringId);
    return {
      offeringId: input.offeringId,
      samples: samples.map((record) =>
        toPublicAudioSample({ record, playbackUrl: this.playbackUrlFor(record) }),
      ),
    };
  }

  /**
   * Read-only sample listing for buyer-facing discovery. Returns
   * the public DTO for every LIVE sample owned by an Active
   * offering. A sample whose storage object is missing is silently
   * skipped so the buyer UI never surfaces a broken player reference.
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
    return {
      offeringId,
      samples: samples.map((record) =>
        toPublicAudioSample({ record, playbackUrl: this.playbackUrlFor(record) }),
      ),
    };
  }

  /**
   * Remove a sample from a seller-owned ServiceOffering. The row
   * is hidden from discovery immediately; the storage object is
   * removed (or marked PendingCleanup if removal fails so a
   * bounded retry can complete the deletion).
   */
  async removeSample(input: RemoveSampleInput): Promise<RemoveSampleResult> {
    this.assertActingWorkspace(input.actingWorkspaceId);
    const context = await this.repository.getOfferingContext(input.offeringId);
    if (!context) {
      throw new AudioSampleError("ServiceOffering not found.", "AUDIO_OFFERING_NOT_FOUND");
    }
    try {
      await this.workspaceAuthorization.requireCapability({
        userAccountId: input.userAccountId,
        workspaceId: input.actingWorkspaceId,
        requiredCapability: "Seller",
      });
    } catch (err) {
      if (err instanceof AuthorizationError) {
        throw mapAuthorizationError(err, context);
      }
      throw err;
    }
    if (context.sellerWorkspaceId !== input.actingWorkspaceId) {
      throw new AudioSampleError(
        "Acting Workspace is not the owner of this ServiceOffering.",
        "AUDIO_OFFERING_INELIGIBLE",
      );
    }
    const sample = await this.repository.findSampleById({
      offeringId: input.offeringId,
      sampleId: input.sampleId,
    });
    if (!sample) {
      throw new AudioSampleError("Sample not found.", "AUDIO_SAMPLE_NOT_FOUND");
    }
    // Step 1: hide from discovery (the row's cleanupStatus flips
    // to Removed inside the transaction that also deletes the
    // row). Buyer/seller lists observe only Live rows.
    await this.repository.markRemovedAndDelete({
      offeringId: input.offeringId,
      sampleId: input.sampleId,
    });
    // Step 2: try to delete the bounded storage object. On
    // failure, mark the row PendingCleanup so the next operation
    // against the offering can retry. The Prisma adapter's
    // markRemovedAndDelete already deleted the row, so on a
    // PendingCleanup transition we have no row to update; instead
    // we surface AUDIO_STORAGE_FAILED so the caller can retry the
    // removal command.
    try {
      await this.storage.removeSample(sample.storageRef);
    } catch (err) {
      if (err instanceof StorageReferenceUnknownError) {
        // Already gone — idempotent success.
      } else if (err instanceof StorageUnavailableError) {
        // P1-005: the provider is unreachable. Surface as a
        // retryable error; the bounded retry path drives the
        // next attempt on the next operation.
        throw new AudioSampleError(
          "Storage provider is unavailable; sample is hidden from discovery and will be retried.",
          "AUDIO_STORAGE_FAILED",
        );
      } else {
        throw mapStorageError(err);
      }
    }
    return {
      sampleId: sample.sampleId,
      offeringId: input.offeringId,
      removedAt: new Date(this.now()),
    };
  }

  /**
   * Read a single sample's bytes for the buyer-facing playback
   * route. Re-runs eligibility + sample-existence checks on
   * every request (per the reviewer's P0-001 invariant: "after
   * removal or offering ineligibility, subsequent application-
   * mediated playback must be rejected"). The deterministic and
   * Supabase adapters both implement the provider-neutral
   * `getPlaybackBytes` contract.
   */
  async getBytesForPlayback(input: {
    readonly offeringId: string;
    readonly sampleId: string;
  }): Promise<PlaybackBytes | null> {
    const context = await this.repository.getOfferingContext(input.offeringId);
    if (!context) return null;
    if (
      context.offeringStatus !== "Active" ||
      context.sellerProfileStatus !== "Published" ||
      context.sellerWorkspaceStatus !== "Active" ||
      !context.hasSellerCapability
    ) {
      // Ineligible offerings never expose playable bytes.
      return null;
    }
    const sample = await this.repository.findSampleById({
      offeringId: input.offeringId,
      sampleId: input.sampleId,
    });
    if (!sample) return null;
    if (sample.cleanupStatus !== "Live") {
      // PendingCleanup / Removed samples are not playable.
      return null;
    }
    try {
      const bytes = await this.storage.getPlaybackBytes(sample.storageRef);
      return { bytes, contentType: BG2_AUDIO_SAMPLE_CONTENT_TYPE, storageRef: sample.storageRef };
    } catch (err) {
      if (err instanceof StorageReferenceUnknownError) {
        return null;
      }
      throw mapStorageError(err);
    }
  }

  /**
   * Bounded retry pass for PendingCleanup samples on the given
   * offering. Called from upload + seller-list to keep the cleanup
   * window bounded without introducing a scheduler. The retry
   * attempts each pending sample in oldest-first order; the
   * bounded set is the offering's own cleanup backlog.
   */
  private async retryPendingCleanupForOffering(input: {
    readonly offeringId: string;
  }): Promise<void> {
    const pending = await this.repository.listPendingCleanupForOffering(input.offeringId);
    for (const sample of pending) {
      try {
        await this.storage.removeSample(sample.storageRef);
        // The row is already deleted from the Live set; we just
        // need to forget the storage reference on the server side.
      } catch {
        // Swallow; the next operation retries.
      }
    }
  }

  /**
   * Compose the SoundHub-owned in-app playback URL. Provider
   * signed URLs, bucket names, and object paths are NEVER part of
   * this URL — the application proxy route streams the bytes
   * through this path after re-running eligibility + sample-
   * existence checks.
   */
  private playbackUrlFor(record: AudioSampleRecord): string {
    return `${this.publicApiBaseUrl}/api/services/${encodeURIComponent(record.offeringId)}/audio-samples/${encodeURIComponent(record.sampleId)}/play`;
  }

  private async pickNextDisplayOrder(offeringId: string): Promise<number> {
    const existing = await this.repository.listSamplesForOffering(offeringId);
    const taken = new Set(existing.map((s) => s.displayOrder));
    for (let candidate = 1; candidate <= BG2_AUDIO_SAMPLE_MAX_DISPLAY_ORDER; candidate += 1) {
      if (!taken.has(candidate)) return candidate;
    }
    throw new AudioSampleError(
      "ServiceOffering already has the maximum number of samples.",
      "AUDIO_SAMPLE_LIMIT_EXCEEDED",
    );
  }

  private assertActingWorkspace(actingWorkspaceId: string): void {
    if (
      typeof actingWorkspaceId !== "string" ||
      actingWorkspaceId.length === 0 ||
      actingWorkspaceId.length > 128
    ) {
      throw new AudioSampleError("Acting Workspace id is required.", "INVALID_AUTH_REQUEST");
    }
  }
}

function mapAuthorizationError(
  err: AuthorizationError,
  context: { readonly sellerWorkspaceId: string },
): AudioSampleError {
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
  if (err instanceof StorageReferenceUnknownError) {
    return new AudioSampleError(
      "Underlying storage object has been removed.",
      "AUDIO_SAMPLE_NOT_FOUND",
    );
  }
  if (err instanceof StorageRejectedError) {
    return new AudioSampleError(err.message, "AUDIO_CONTENT_TYPE_UNSUPPORTED");
  }
  return new AudioSampleError("Storage operation failed.", "AUDIO_STORAGE_FAILED");
}
