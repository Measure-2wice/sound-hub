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
import { BG7_FIXTURE_STORAGE_REF, buildDeterministicMp3Fixture } from "@soundhub/db";
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
  /**
   * BG7: refs that were explicitly removed and must NOT be lazily
   * re-minted on the next `getPlaybackBytes` call. Without this,
   * the canonical BG7 fixture would resurrect after a removeSample
   * because the hydration guard would re-populate the Map.
   * Single-purpose: tracks only the canonical fixture reference.
   */
  private fixtureRemoved = false;
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
   *
   * BG7: also returns the canonical URL when the supplied ref is
   * the canonical BG7 fixture reference (so the browser can render
   * `<audio src>` before any playback has actually streamed).
   */
  getPlaybackReference(input: StoragePlaybackInput): Promise<StoragePlaybackReference | null> {
    if (input.storageRef !== BG7_FIXTURE_STORAGE_REF && !this.objects.has(input.storageRef)) {
      return Promise.resolve(null);
    }
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
   *
   * BG7 fixture re-mint: when the supplied `storageRef` equals the
   * canonical BG7 fixture reference (`BG7_FIXTURE_STORAGE_REF`), the
   * adapter lazily re-mints the deterministic fixture bytes and
   * caches them in the existing `objects` Map before returning. This
   * pattern is exactly what the adapter comment at the top of this
   * file anticipates ("the seeded `deterministic-samples` fixture
   * re-mints the same bytes, so the locator still resolves"). The
   * fixture is single-purpose and is NOT a generalized framework.
   *
   * If the caller previously invoked `removeSample` on the
   * canonical fixture, this method rejects with the canonical
   * unknown-ref error — removal is sticky.
   *
   * Production/managed storage behavior is unchanged: any ref that
   * is NOT the canonical fixture reference and is not already cached
   * returns the canonical unknown-ref error. The Supabase adapter
   * has its own implementation and is unaffected.
   */
  getPlaybackBytes(storageRef: string): Promise<Uint8Array> {
    if (!storageRef.startsWith(DET_STORAGE_REF_PREFIX)) {
      return Promise.reject(
        new StorageReferenceUnknownError("Storage reference is not managed by this adapter."),
      );
    }
    // Canonical BG7 fixture lazy hydration. Re-mints the bytes the
    // first time the locator resolves, then caches them so subsequent
    // lookups hit the in-memory Map. No second fixture build per
    // process. Removal is sticky via `fixtureRemoved`.
    if (storageRef === BG7_FIXTURE_STORAGE_REF) {
      if (this.fixtureRemoved) {
        return Promise.reject(
          new StorageReferenceUnknownError("Storage reference has been removed."),
        );
      }
      const cached = this.objects.get(storageRef);
      if (!cached) {
        const bytes = buildDeterministicMp3Fixture();
        this.objects.set(storageRef, {
          bytes,
          contentType: BG2_AUDIO_SAMPLE_CONTENT_TYPE,
          storedAt: this.now(),
        });
      }
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
    if (storageRef === BG7_FIXTURE_STORAGE_REF) {
      this.fixtureRemoved = true;
    }
    this.objects.delete(storageRef);
    return Promise.resolve();
  }

  private makeStorageRef(offeringId: string): string {
    return `${DET_STORAGE_REF_PREFIX}${offeringId}:${randomUUID()}`;
  }
}
