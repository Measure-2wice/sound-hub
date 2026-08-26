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

    // Step 1: skip an optional ID3v2 tag. The tag is exactly 10
    // bytes long with a syncsafe size at bytes 6..9. Anything
    // following the tag is the audio stream. A tag whose declared
    // size fills or exceeds the payload is rejected: no audio
    // frame can follow.
    let offset = 0;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      if (bytes.length < 10) {
        return { ok: false, reason: "ID3v2 header is truncated." };
      }
      const declared =
        (((bytes[6] ?? 0) & 0x7f) << 21) |
        (((bytes[7] ?? 0) & 0x7f) << 14) |
        (((bytes[8] ?? 0) & 0x7f) << 7) |
        ((bytes[9] ?? 0) & 0x7f);
      offset = 10 + declared;
      if (offset >= bytes.length) {
        return {
          ok: false,
          reason: "Declared ID3v2 size exhausts the payload (no audio frame follows).",
        };
      }
    }

    // Step 2: many encoders emit zero padding between an ID3 tag
    // and the first frame. Skip at most one such byte so a tagged
    // file is still accepted; do not skip arbitrarily so a junk
    // payload cannot pass.
    if (bytes[offset] === 0x00 && offset + 1 + 4 <= bytes.length) {
      offset += 1;
    }

    if (offset + 4 > bytes.length) {
      return {
        ok: false,
        reason: "Payload does not contain an MPEG frame after the ID3 tag.",
      };
    }

    // Step 3: validate the 4-byte MPEG frame header. Each field's
    // reserved values are rejected so a junk byte stream cannot
    // satisfy the boundary.
    const h0 = bytes[offset] ?? 0;
    const h1 = bytes[offset + 1] ?? 0;
    const h2 = bytes[offset + 2] ?? 0;
    const h3 = bytes[offset + 3] ?? 0;

    // 11-bit sync word.
    const sync = (h0 << 3) | (h1 >> 5);
    if (sync !== 0x7ff) {
      return {
        ok: false,
        reason: "Payload does not begin with an MP3 frame sync word or ID3 tag.",
      };
    }

    // MPEG version: 11=MPEG-1, 10=MPEG-2, 00=MPEG-2.5, 01=reserved.
    const mpegVersionBits = (h1 >> 3) & 0x03;
    if (mpegVersionBits === 0x01) {
      return { ok: false, reason: "MPEG version is reserved (01)." };
    }

    // Layer: 01=Layer III, 10=Layer II, 11=Layer I, 00=reserved.
    // Only Layer III is accepted at the trusted boundary.
    const layerBits = (h1 >> 1) & 0x03;
    if (layerBits !== 0x01) {
      return { ok: false, reason: "MPEG layer is not Layer III." };
    }

    // Bitrate index: 0000=free-format, 1111=bad. Free-format is
    // legal but cannot be size-validated at the boundary; reject.
    const bitrateIndex = (h2 >> 4) & 0x0f;
    if (bitrateIndex === 0x00) {
      return { ok: false, reason: "MPEG bitrate index is free-format (not supported)." };
    }
    if (bitrateIndex === 0x0f) {
      return { ok: false, reason: "MPEG bitrate index is bad (1111)." };
    }

    // Sample rate index: 11=reserved.
    const sampleRateIndex = (h2 >> 2) & 0x03;
    if (sampleRateIndex === 0x03) {
      return { ok: false, reason: "MPEG sample rate index is reserved (11)." };
    }

    // Padding bit (0/1).
    const padding = (h2 >> 1) & 0x01;

    // Emphasis: 10=reserved, 11=reserved. 00=none, 01=50/15µs.
    const emphasis = h3 & 0x03;
    if (emphasis === 0x02 || emphasis === 0x03) {
      return { ok: false, reason: "MPEG emphasis is reserved." };
    }

    // Step 4: verify the audio frame body fits in the payload.
    // Frame size = samples_per_frame * bitrate / sample_rate + padding.
    const sampleRateHz = MPEG_SAMPLE_RATE_HZ[mpegVersionBits]?.[sampleRateIndex];
    if (sampleRateHz === undefined) {
      return { ok: false, reason: "MPEG sample rate index is out of range." };
    }
    // Per ticket #61 follow-up review (P1-001): the MPEG-1 Layer III
    // bitrate table (higher bitrates, samples-per-frame = 1152) lives
    // at index 1, and the MPEG-2/2.5 Layer III table (lower bitrates,
    // samples-per-frame = 576) lives at index 0. Selecting table 0 for
    // MPEG-1 underestimates the frame size and accepts truncated
    // payloads; selecting table 1 for MPEG-2/2.5 overestimates and
    // rejects valid-length frames. Map the version to the correct
    // table here.
    const bitrateTableIndex = mpegVersionBits === 0x03 ? 1 : 0;
    const bitrateKbps = MPEG_L3_BITRATE_KBPS[bitrateTableIndex]?.[bitrateIndex];
    if (bitrateKbps === undefined) {
      return { ok: false, reason: "MPEG bitrate index is out of range." };
    }
    // Layer III samples-per-frame: 1152 (MPEG-1) or 576 (MPEG-2/2.5).
    const samplesPerFrame = mpegVersionBits === 0x03 ? 1152 : 576;
    const frameSize =
      Math.floor((samplesPerFrame * bitrateKbps * 1000) / (8 * sampleRateHz)) + padding;
    if (frameSize < 24) {
      // Sanity: an MPEG L3 frame is at least 24 bytes. A smaller
      // derived size indicates a malformed combination we should
      // not accept.
      return { ok: false, reason: "Computed MPEG frame size is implausibly small." };
    }
    if (offset + frameSize > bytes.length) {
      return {
        ok: false,
        reason: "MPEG frame body exceeds the payload (truncated frame).",
      };
    }

    return { ok: true };
  },
};

// MPEG sample rate table indexed by version then sample-rate index.
// version: 00=MPEG-2.5, 10=MPEG-2, 11=MPEG-1.
const MPEG_SAMPLE_RATE_HZ: Readonly<Record<number, ReadonlyArray<number | undefined>>> = {
  // MPEG-2.5
  0x00: [11025, 12000, 8000, undefined],
  // MPEG-2
  0x02: [22050, 24000, 16000, undefined],
  // MPEG-1
  0x03: [44100, 48000, 32000, undefined],
};

// MPEG Layer III bitrate (kbps) indexed by version group then index.
// version group: 0=MPEG-2/2.5, 1=MPEG-1. Index 0 = free, index 0xF = bad.
const MPEG_L3_BITRATE_KBPS: Readonly<Record<number, ReadonlyArray<number | undefined>>> = {
  // MPEG-2 / MPEG-2.5 Layer III
  0: [undefined, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, undefined],
  // MPEG-1 Layer III
  1: [undefined, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, undefined],
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
    // P1-005: observed-content validation at the trusted boundary.
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
    // P1-002: also retry any orphaned storage locators so a
    // previously-recorded orphan (created when the immediate
    // post-upload storage-delete failed) can be completed across
    // service restarts. Bounded by the offering's own backlog.
    await this.retryOrphanedStorageForOffering({
      offeringId: input.offeringId,
    });

    // P1-004: pre-flight cap check before any storage write so a
    // known-full offering never produces an orphan object. The
    // authoritative atomic guard still runs in the repository
    // (P1-002) so concurrent uploads are still serialized; this
    // pre-flight is the cheap-and-correct path that also lets us
    // return the deterministic cap error for the common case.
    const existing = await this.repository.listSamplesForOffering(input.offeringId);
    if (existing.length >= BG2_AUDIO_SAMPLE_MAX_PER_OFFERING) {
      throw new AudioSampleError(
        `ServiceOffering already has ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING} samples; remove one before uploading another.`,
        "AUDIO_SAMPLE_LIMIT_EXCEEDED",
      );
    }

    // P1-004: storage first, but every post-upload failure path
    // covers the uploaded object via either a clean delete or a
    // durable PendingCleanup write. The cap guard is the
    // authoritative atomic check; this is a defense-in-depth path
    // for write failures between storage and DB.
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

    try {
      const created = await this.repository.createSampleWithCap({
        offeringId: input.offeringId,
        label: input.label,
        contentType: BG2_AUDIO_SAMPLE_CONTENT_TYPE,
        byteSize: input.byteSize,
        storageRef,
      });
      if (!created) {
        // Concurrent writer beat us to the slot under the
        // per-offering advisory lock. Clean up the storage object
        // we just uploaded so it does not become an orphan.
        await this.cleanupOrphanedStorage({
          offeringId: input.offeringId,
          storageRef,
        });
        throw new AudioSampleError(
          `ServiceOffering already has ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING} samples; remove one before uploading another.`,
          "AUDIO_SAMPLE_LIMIT_EXCEEDED",
        );
      }
      return {
        sample: toPublicAudioSample({
          record: created,
          playbackUrl: this.playbackUrlFor(created),
        }),
      };
    } catch (err) {
      // P1-004 + P1-002: any non-cap failure during the DB create
      // must not leak the uploaded storage object. Best-effort
      // delete; if even that fails we surface the original DB
      // error to the caller AND record a durable orphan locator so
      // the bounded retry path on the next operation can complete
      // the storage-side cleanup across service restarts.
      await this.cleanupOrphanedStorage({
        offeringId: input.offeringId,
        storageRef,
      });
      throw err;
    }
  }

  /**
   * Best-effort cleanup for an uploaded storage object whose DB
   * counterpart did not persist. The helper returns whether the
   * storage-side delete confirmed success (or the object was
   * already gone). When the helper returns `false`, the caller
   * records a durable orphan locator so the bounded retry path on
   * the next operation can discover and complete the storage
   * cleanup across service restarts. Per ticket #61 follow-up
   * review (P1-002) the previous implementation silently swallowed
   * the failure and dropped the storage ref; this implementation
   * makes the locator durable.
   */
  private async tryCleanupOrphanedStorage(storageRef: string): Promise<boolean> {
    try {
      await this.storage.removeSample(storageRef);
      return true;
    } catch (err) {
      if (err instanceof StorageReferenceUnknownError) return true;
      return false;
    }
  }

  /**
   * Best-effort cleanup wrapper used by the upload path. On
   * failure, a durable orphan locator is recorded so the bounded
   * retry can complete the cleanup later. The caller's primary
   * error always propagates.
   */
  private async cleanupOrphanedStorage(input: {
    readonly offeringId: string;
    readonly storageRef: string;
  }): Promise<void> {
    const ok = await this.tryCleanupOrphanedStorage(input.storageRef);
    if (!ok) {
      try {
        await this.repository.recordOrphanedStorage(input);
      } catch {
        // The orphan record write itself failed. The caller's
        // primary error still propagates; the bounded retry is the
        // only remaining recovery path and will retry on the next
        // operation.
      }
    }
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
    // P1-002: also drive the bounded orphan-locator retry pass.
    await this.retryOrphanedStorageForOffering({
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
   * Remove a sample from a seller-owned ServiceOffering. Per P1-003
   * the row is hidden from discovery immediately and the bounded
   * storage reference is preserved so a durable retry can complete
   * the deletion:
   *   1. Mark the row `PendingCleanup` so buyer/seller lists stop
   *      surfacing it but the storage ref survives.
   *   2. Attempt the provider delete.
   *   3a. On success (or already-gone), finalize the row (delete).
   *   3b. On provider failure, leave the row `PendingCleanup` and
   *       surface AUDIO_STORAGE_FAILED so the caller knows to retry.
   *       The bounded retry path on the next operation against the
   *       offering completes the deletion.
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
    if (sample.cleanupStatus === "PendingCleanup") {
      // A previous removal attempt left the row pending. The
      // bounded retry can complete it; surface a retryable error
      // so the caller can re-issue or wait for the next op.
      throw new AudioSampleError(
        "Storage cleanup is in progress; retry the removal after the next operation against the offering.",
        "AUDIO_STORAGE_FAILED",
      );
    }
    // Step 1: hide from discovery immediately by flipping the
    // status to PendingCleanup. The row survives so the bounded
    // retry can complete the provider deletion later. Live samples
    // are excluded from buyer/seller listings.
    await this.repository.markPendingCleanup({
      offeringId: input.offeringId,
      sampleId: input.sampleId,
    });
    // Step 2: attempt the provider delete immediately.
    try {
      await this.storage.removeSample(sample.storageRef);
    } catch (err) {
      if (err instanceof StorageReferenceUnknownError) {
        // Already gone — fall through to finalize.
      } else if (err instanceof StorageUnavailableError) {
        // The row is now PendingCleanup; the bounded retry will
        // retry this exact storageRef on the next operation.
        throw new AudioSampleError(
          "Storage provider is unavailable; sample is hidden from discovery and will be retried.",
          "AUDIO_STORAGE_FAILED",
        );
      } else {
        throw mapStorageError(err);
      }
    }
    // Step 3: provider delete succeeded (or was already gone) —
    // finalize by deleting the row.
    await this.repository.finalizePendingCleanup({
      offeringId: input.offeringId,
      sampleId: input.sampleId,
    });
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
   * attempts each pending sample in oldest-first order; on
   * success (or already-absent) the row is finalized so the
   * bounded backlog converges. The bounded set is the offering's
   * own cleanup backlog.
   */
  private async retryPendingCleanupForOffering(input: {
    readonly offeringId: string;
  }): Promise<void> {
    const pending = await this.repository.listPendingCleanupForOffering(input.offeringId);
    for (const sample of pending) {
      let removed = false;
      try {
        await this.storage.removeSample(sample.storageRef);
        removed = true;
      } catch (err) {
        if (err instanceof StorageReferenceUnknownError) {
          // Already gone — treat as removed so the row finalizes.
          removed = true;
        }
        // Any other error: leave the row for the next pass.
      }
      if (removed) {
        try {
          await this.repository.finalizePendingCleanup({
            offeringId: sample.offeringId,
            sampleId: sample.sampleId,
          });
        } catch {
          // Swallow; the next operation retries the finalize.
        }
      }
    }
  }

  /**
   * Bounded retry pass for orphaned storage locators (P1-002).
   * Called from upload + seller-list so the cleanup window stays
   * bounded without a scheduler. Each orphan is attempted in
   * oldest-first order; success deletes the locator row, failure
   * leaves it for the next pass.
   */
  private async retryOrphanedStorageForOffering(input: {
    readonly offeringId: string;
  }): Promise<void> {
    const orphans = await this.repository.listOrphanedStorageForOffering(input.offeringId);
    for (const orphan of orphans) {
      const ok = await this.tryCleanupOrphanedStorage(orphan.storageRef);
      if (ok) {
        try {
          await this.repository.removeOrphanedStorage(orphan.storageRef);
        } catch {
          // Swallow; the next operation retries.
        }
      }
      // On failure we leave the row so the next pass retries.
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
