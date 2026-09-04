// Deterministic storage adapter.
//
// Background: ticket #61 requires a deterministic in-memory storage
// adapter that satisfies the same application-facing contract as the
// deployed Supabase Storage adapter. This adapter backs:
//
//   - automated tests that need real storage semantics without
//     touching the network;
//   - the deterministic browser journey fixture (the buildathon
//     environment can run the integrated journey without a live
//     Supabase project);
//   - dev-mode seeded demos and emergency fallback.
//
// The adapter stores the raw bytes in a `Map<storageRef, Uint8Array>`
// scoped to the process. `storageRef` is a self-contained
// `det:<offeringId>:<uuid>` string the application persists in
// PostgreSQL and passes back to `getPlaybackBytes` and
// `removeSample`. Across a process restart, the seeded
// `deterministic-samples` fixture re-mints the same bytes, so the
// locator still resolves — the in-process index is rebuilt by the
// seed ingestion path, not by a cold start of an empty adapter.
//
// `getPlaybackReference` returns the in-app
// `${apiOrigin}/api/services/{offeringId}/audio-samples/{sampleId}/play`
// URL; the application proxy route streams the bytes through that
// path after re-running eligibility checks.

import { randomUUID } from "node:crypto";
import { BG2_AUDIO_SAMPLE_CONTENT_TYPE, BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE } from "@soundhub/types";
import {
  StorageRejectedError,
  StorageReferenceUnknownError,
  StorageUnavailableError,
  type StorageAdapter,
  type StoragePlaybackInput,
  type StoragePlaybackReference,
  type StorageUploadInput,
  type StorageUploadResult,
} from "./storage-adapter.js";

const DET_STORAGE_REF_PREFIX = "det:" as const;

export interface DeterministicStorageAdapterOptions {
  /**
   * Base URL the in-app playback route resolves from. Defaults to
   * `http://localhost:4000` so the dev server's
   * `/api/services/.../play` route resolves against the API
   * origin. Tests pass a stub to assert the URL composition
   * deterministically.
   */
  readonly playbackBaseUrl?: string;
  /**
   * Clock used by the deterministic adapter for tests; defaults to
   * `Date.now`. Reserved for future use; the current deterministic
   * implementation does not expire stored bytes by time.
   */
  readonly now?: () => number;
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: typeof BG2_AUDIO_SAMPLE_CONTENT_TYPE;
  readonly storedAt: number;
}

export class DeterministicStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<string, StoredObject>();
  private readonly playbackBaseUrl: string;
  private readonly now: () => number;

  constructor(options: DeterministicStorageAdapterOptions = {}) {
    this.playbackBaseUrl = options.playbackBaseUrl ?? "http://localhost:4000";
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Seed an in-memory object. Tests and dev fixtures call this to
   * produce a sample the seller-management UI can list without
   * uploading. The storage reference is returned in the same opaque
   * shape `uploadSample` would produce so the application cannot
   * distinguish seeded vs uploaded objects.
   */
  seedSample(input: { bytes: Uint8Array; offeringId: string }): string {
    const ref = this.makeStorageRef(input.offeringId);
    this.objects.set(ref, {
      bytes: input.bytes,
      contentType: BG2_AUDIO_SAMPLE_CONTENT_TYPE,
      storedAt: this.now(),
    });
    return ref;
  }

  uploadSample(input: StorageUploadInput): Promise<StorageUploadResult> {
    if (input.contentType !== BG2_AUDIO_SAMPLE_CONTENT_TYPE) {
      return Promise.reject(
        new StorageRejectedError(
          `Only audio/mpeg samples are accepted (got ${String(input.contentType)}).`,
        ),
      );
    }
    if (input.byteSize > BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE) {
      return Promise.reject(
        new StorageRejectedError(
          `Sample exceeds the ${BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE}-byte limit.`,
        ),
      );
    }
    if (input.bytes.byteLength !== input.byteSize) {
      return Promise.reject(
        new StorageRejectedError("Declared byte size does not match observed bytes."),
      );
    }
    const ref = this.makeStorageRef(input.offeringId);
    this.objects.set(ref, {
      bytes: input.bytes,
      contentType: input.contentType,
      storedAt: this.now(),
    });
    return Promise.resolve({ storageRef: ref });
  }

  /**
   * Compose the SoundHub-owned in-app playback URL. The URL
   * always points at the application route; the application
   * proxy-streams the bytes through that path after eligibility
   * checks. Returns `null` when the storage ref is unknown.
   */
  getPlaybackReference(input: StoragePlaybackInput): Promise<StoragePlaybackReference | null> {
    if (!this.objects.has(input.storageRef)) return Promise.resolve(null);
    const baseUrl = this.playbackBaseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/api/services/${encodeURIComponent(input.offeringId)}/audio-samples/${encodeURIComponent(input.sampleId)}/play`;
    return Promise.resolve({
      url,
      cacheControlHint: "private, max-age=60",
    });
  }

  /**
   * Return the raw MP3 bytes for the given storage ref. The
   * application calls this only after eligibility + sample-
   * existence checks have run on the in-app route.
   */
  getPlaybackBytes(storageRef: string): Promise<Uint8Array> {
    if (!storageRef.startsWith(DET_STORAGE_REF_PREFIX)) {
      return Promise.reject(
        new StorageReferenceUnknownError("Storage reference is not managed by this adapter."),
      );
    }
    const obj = this.objects.get(storageRef);
    if (!obj) {
      return Promise.reject(
        new StorageReferenceUnknownError("Storage reference has been removed."),
      );
    }
    return Promise.resolve(obj.bytes);
  }

  removeSample(storageRef: string): Promise<void> {
    if (!storageRef.startsWith(DET_STORAGE_REF_PREFIX)) {
      return Promise.reject(
        new StorageUnavailableError("Storage reference is not managed by this adapter."),
      );
    }
    this.objects.delete(storageRef);
    return Promise.resolve();
  }

  private makeStorageRef(offeringId: string): string {
    return `${DET_STORAGE_REF_PREFIX}${offeringId}:${randomUUID()}`;
  }
}
