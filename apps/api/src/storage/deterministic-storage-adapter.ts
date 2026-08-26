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
// The adapter stores the raw bytes in a `Map<storageRef, Buffer>`
// scoped to the process. `storageRef` is an opaque `det:<cuid>` string
// so the application cannot accidentally read it as a Supabase-style
// signed URL; the contract is identical to the deployed adapter. The
// `getPlaybackReference` method returns an opaque in-process URL the
// route layer exposes at `/api/services/:offeringId/audio-samples/
// :sampleId/play` so a browser can play the bytes without contacting
// Supabase.

import { randomUUID } from "node:crypto";
import { BG2_AUDIO_SAMPLE_CONTENT_TYPE, BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE } from "@soundhub/types";
import {
  StorageRejectedError,
  StorageUnavailableError,
  type StorageAdapter,
  type StoragePlaybackReference,
  type StorageUploadInput,
  type StorageUploadResult,
} from "./storage-adapter.js";

const DET_STORAGE_REF_PREFIX = "det:" as const;

export interface DeterministicStorageAdapterOptions {
  /**
   * Base URL the deterministic playback route resolves from. Defaults
   * to `http://localhost:4000` so the dev server's `/api/services/...
   * /play` route resolves against the API origin. Tests pass a stub
   * to assert the URL composition deterministically.
   */
  readonly playbackBaseUrl?: string;
  /**
   * Clock used by the deterministic playback expiry. Defaults to
   * `Date.now`. Tests pass a controlled clock.
   */
  readonly now?: () => number;
  /**
   * Lifetime of the deterministic playback route's signed reference.
   * Defaults to 5 minutes.
   */
  readonly playbackTtlMs?: number;
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: typeof BG2_AUDIO_SAMPLE_CONTENT_TYPE;
  readonly storedAt: number;
  readonly expiresAt: number;
}

export class DeterministicStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<string, StoredObject>();
  private readonly playbackBaseUrl: string;
  private readonly now: () => number;
  private readonly playbackTtlMs: number;

  constructor(options: DeterministicStorageAdapterOptions = {}) {
    this.playbackBaseUrl = options.playbackBaseUrl ?? "http://localhost:4000";
    this.now = options.now ?? (() => Date.now());
    this.playbackTtlMs = options.playbackTtlMs ?? 5 * 60 * 1000;
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
      expiresAt: this.now() + this.playbackTtlMs,
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
      expiresAt: this.now() + this.playbackTtlMs,
    });
    return Promise.resolve({ storageRef: ref });
  }

  getPlaybackReference(storageRef: string): Promise<StoragePlaybackReference | null> {
    const obj = this.objects.get(storageRef);
    if (!obj) return Promise.resolve(null);
    if (obj.expiresAt <= this.now()) {
      // Lazy GC: a sample past its TTL is treated as missing so the
      // buyer-facing UI never surfaces a broken player reference.
      this.objects.delete(storageRef);
      return Promise.resolve(null);
    }
    // The URL is an opaque in-process path. The application never
    // reads its internals; it only renders the value in the buyer-
    // facing audio tag. The test suite asserts the URL composition
    // via the `playbackBaseUrl` option.
    const url = `${this.playbackBaseUrl.replace(/\/+$/, "")}/api/storage/playback/${encodeURIComponent(
      storageRef,
    )}`;
    return Promise.resolve({
      url,
      cacheControlHint: "private, max-age=60",
    });
  }

  removeSample(storageRef: string): Promise<void> {
    if (!storageRef.startsWith(DET_STORAGE_REF_PREFIX)) {
      // Defensive: refuse to remove refs the adapter did not mint
      // so a future swap to a different adapter cannot accidentally
      // delete foreign objects.
      return Promise.reject(
        new StorageUnavailableError("Storage reference is not managed by this adapter."),
      );
    }
    this.objects.delete(storageRef);
    return Promise.resolve();
  }

  /**
   * Internal accessor used by the deterministic playback route to
   * fetch the bytes for a given storage ref. Returns `null` when the
   * object is unknown or expired. Exposed only inside this module —
   * higher layers reach the storage bytes via the route's response.
   */
  getBytesForPlayback(storageRef: string): Uint8Array | null {
    const obj = this.objects.get(storageRef);
    if (!obj) return null;
    if (obj.expiresAt <= this.now()) {
      this.objects.delete(storageRef);
      return null;
    }
    return obj.bytes;
  }

  private makeStorageRef(offeringId: string): string {
    return `${DET_STORAGE_REF_PREFIX}${offeringId}:${randomUUID()}`;
  }
}
