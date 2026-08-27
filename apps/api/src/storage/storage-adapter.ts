// Provider-neutral storage adapter contract.
//
// Background: ticket #61 requires that the seller-audio slice upload,
// list, play, and remove MP3 discovery samples through a
// provider-neutral storage boundary. The deployed primary path is
// Supabase Storage; automated tests use a deterministic in-memory
// adapter. Every adapter obeys the same application-facing contract
// so the higher layers (routes, services, repositories) cannot drift
// based on which provider is wired.
//
// Application contract invariants (post review P0-001):
//
//   1. `uploadSample` returns an opaque `storageRef` whose content
//      the application MUST treat as a handle to the storage backend.
//      The application NEVER parses, logs, or reconstructs the
//      storage reference to derive bucket/path/provider URLs; only
//      the adapter that produced it can resolve it back via
//      `getPlaybackBytes`. PostgreSQL is the only place the
//      reference is persisted; it never crosses the public DTO.
//
//   2. `getPlaybackReference` returns a SoundHub-owned playback URL
//      that points at the application route
//      `${apiOrigin}/api/services/{offeringId}/audio-samples/{sampleId}/play`.
//      The application proxy-streams the bytes through this route
//      after re-running eligibility and removal checks on every
//      request. Provider signed URLs, bucket names, and object
//      paths are NEVER serialized to a public DTO, response header,
//      or error envelope. The Supabase adapter mints the signed URL
//      internally and resolves the bytes; the bytes never appear
//      on the public HTTP boundary in a provider-typed form.
//
//   3. `getPlaybackBytes` returns the raw MP3 bytes for the given
//      storage ref. The deterministic adapter returns its in-memory
//      bytes; the Supabase adapter fetches the signed URL
//      internally and returns the bytes. The application runs
//      offering eligibility + sample existence checks before
//      calling this method.
//
//   4. `removeSample` deletes the bounded object (or schedules
//      cleanup) and is idempotent. Repeated removals of the same
//      reference never throw — the application may retry without
//      surfacing a provider error.
//
//   5. Provider failure maps to a stable `StorageUnavailableError`
//      so the route layer can surface `AUDIO_PROVIDER_UNAVAILABLE`
//      without leaking adapter internals.

import { BG2_AUDIO_SAMPLE_CONTENT_TYPE, BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE } from "@soundhub/types";

export interface StorageUploadInput {
  /**
   * Buyer-facing label carried into provider metadata when supported.
   * NEVER used as a key/path component by the application.
   */
  readonly label: string;
  /**
   * Declared MIME type. The application enforces
   * `audio/mpeg` at the trusted boundary before calling the adapter.
   */
  readonly contentType: typeof BG2_AUDIO_SAMPLE_CONTENT_TYPE;
  /**
   * Observed byte size, bounded at `BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE`.
   * The application enforces the limit before invoking the adapter;
   * the adapter still validates because it cannot trust the caller.
   */
  readonly byteSize: number;
  /**
   * The owning ServiceOffering id. Used by the adapter to derive a
   * private provider object key. The application treats the value
   * as opaque; the adapter is the only place it influences the key.
   */
  readonly offeringId: string;
  /**
   * The raw bytes of the audio sample. Adapter implementations MAY
   * stream, copy, or buffer as needed; the application reads the
   * entire buffer once at the trusted boundary so the byte count
   * above is authoritative.
   */
  readonly bytes: Uint8Array;
}

export interface StorageUploadResult {
  /**
   * Self-contained server-internal locator. The application persists
   * this value in PostgreSQL as the `storageRef` column and passes
   * it back to `getPlaybackBytes` and `removeSample`. The adapter
   * that produced it is the only component that parses it. The
   * reference is NEVER serialized to public DTOs, response
   * headers, or error envelopes.
   */
  readonly storageRef: string;
}

/**
 * Inputs to `getPlaybackReference`. The adapter always returns a
 * SoundHub-owned playback URL rooted at the application route
 * `${apiOrigin}/api/services/{offeringId}/audio-samples/{sampleId}/play`.
 * `storageRef` lets the deterministic adapter verify the object
 * exists before composing the URL; the Supabase adapter composes
 * the same URL regardless of the storage ref.
 */
export interface StoragePlaybackInput {
  readonly storageRef: string;
  readonly offeringId: string;
  readonly sampleId: string;
}

export interface StoragePlaybackReference {
  /**
   * SoundHub-owned playback URL the buyer-facing UI may attach to
   * an `<audio>` tag. Always rooted at the application route
   * `${apiOrigin}/api/services/{offeringId}/audio-samples/{sampleId}/play`.
   * The application proxy-streams the bytes through this route after
   * re-running eligibility + removal checks on every request.
   * Provider internals (bucket name, signed URL, object path)
   * never appear in this URL.
   */
  readonly url: string;
  /**
   * Suggested `Cache-Control` hint the application MAY forward to
   * the browser. Defaults to a short browser cache.
   */
  readonly cacheControlHint?: string;
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

export class StorageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageRejectedError";
  }
}

export class StorageReferenceUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageReferenceUnknownError";
  }
}

/**
 * Provider-neutral storage adapter.
 *
 * Every adapter MUST:
 * - Validate declared content type and observed byte size at the
 *   trusted boundary. The application ALSO validates; defense in
 *   depth so an adapter cannot be tricked into accepting non-MP3 or
 *   oversize objects by a malicious or buggy caller.
 * - Return a self-contained `storageRef` from `uploadSample` so a
 *   fresh adapter instance can resolve the locator after process
 *   restart. The reference must never expose bucket names,
 *   private object keys, provider subjects, or storage credentials
 *   to the application: only the adapter knows its format. The
 *   application NEVER serializes the reference to public DTOs,
 *   response headers, or error envelopes.
 * - Resolve `storageRef` back to MP3 bytes via `getPlaybackBytes`
 *   for the application proxy. Throws `StorageReferenceUnknownError`
 *   when the underlying object has been removed (idempotent on
 *   retries; the application surfaces this as `AUDIO_SAMPLE_NOT_FOUND`).
 * - Never expose bucket names, private object keys, provider subjects,
 *   or storage credentials through any return value, URL fragment,
 *   header, or error message.
 */
export interface StorageAdapter {
  /**
   * Upload one bounded MP3 sample. Returns the self-contained
   * storage reference the application persists in PostgreSQL.
   *
   * Throws `StorageRejectedError` for declared type / size policy
   * violations the adapter enforces defensively. Throws
   * `StorageUnavailableError` for transient provider failures
   * (network, throttling, outage).
   */
  uploadSample(input: StorageUploadInput): Promise<StorageUploadResult>;

  /**
   * Compose the SoundHub-owned in-app playback URL for a sample.
   * The URL always points at the application route that
   * proxy-streams the bytes after re-running eligibility checks.
   * Returns `null` when the storage ref is unknown to the adapter
   * (the application treats this as "remove from buyer-facing
   * discovery").
   *
   * The deterministic adapter verifies the object still exists in
   * its in-memory index; the Supabase adapter composes the URL
   * without contacting the provider (the eligibility check happens
   * on the application route).
   */
  getPlaybackReference(input: StoragePlaybackInput): Promise<StoragePlaybackReference | null>;

  /**
   * Resolve the storage ref to raw MP3 bytes. Called only by the
   * application proxy route AFTER eligibility + sample-existence
   * checks have run. The deterministic adapter returns its
   * in-memory bytes; the Supabase adapter mints a scoped signed
   * URL internally, fetches the bytes, and returns them.
   *
   * Throws `StorageReferenceUnknownError` when the underlying
   * object is unknown (already removed or never existed).
   * Throws `StorageUnavailableError` for transient provider
   * failures.
   */
  getPlaybackBytes(storageRef: string): Promise<Uint8Array>;

  /**
   * Remove a previously uploaded sample. Idempotent: removing an
   * already-removed or unknown reference is a no-op.
   */
  removeSample(storageRef: string): Promise<void>;
}

// The declared content type is the only one the adapter accepts.
// The application enforces the same value; the adapter's defensive
// check exists so a future adapter cannot silently broaden the type
// without changing this contract module.
export const SUPPORTED_AUDIO_CONTENT_TYPES = [BG2_AUDIO_SAMPLE_CONTENT_TYPE] as const;
export const MAX_AUDIO_BYTE_SIZE = BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE;
