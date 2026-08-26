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
// Application contract invariants:
//
//   1. `uploadSample` returns an opaque `storageRef` whose content
//      the application MUST treat as a handle to the storage backend.
//      The application NEVER parses, logs, or reconstructs the
//      storage reference; only the adapter that produced it can
//      resolve it back to a playable reference via `getPlaybackReference`.
//      This keeps provider bucket names, object keys, and private
//      credentials inside the adapter boundary.
//
//   2. `removeSample` deletes the bounded object (or schedules
//      cleanup) and is idempotent. Repeated removals of the same
//      reference never throw — the application may retry without
//      surfacing a provider error.
//
//   3. `getPlaybackReference` returns a player URL the buyer-facing
//      UI can attach to an `<audio>` element. The reference is a
//      fully-formed URL (signed URL for Supabase; opaque handle for
//      the deterministic adapter). The application never receives
//      bucket names, signed headers, or other provider internals.
//
//   4. Provider failure maps to a stable `StorageUnavailableError`
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
   * Opaque storage reference. The application persists this value
   * in PostgreSQL as the `storageRef` column and passes it back to
   * `getPlaybackReference` and `removeSample`. The adapter that
   * produced it is the only component that can parse it.
   */
  readonly storageRef: string;
}

export interface StoragePlaybackReference {
  /**
   * Player URL the buyer-facing UI may attach to an `<audio>` tag.
   * For Supabase Storage this is a narrowly-scoped signed URL; for
   * the deterministic adapter this is a server-issued opaque route
   * (e.g. `/api/services/.../audio-samples/.../play`).
   * The application renders the URL but never inspects its internals.
   */
  readonly url: string;
  /**
   * Suggested `Cache-Control` hint the application MAY forward to
   * the browser. Defaults to a short browser cache so a stale signed
   * URL does not survive its expiry.
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

/**
 * Provider-neutral storage adapter.
 *
 * Every adapter MUST:
 * - Validate declared content type and observed byte size at the
 *   trusted boundary. The application ALSO validates; defense in
 *   depth so an adapter cannot be tricked into accepting non-MP3 or
 *   oversize objects by a malicious or buggy caller.
 * - Return an opaque `storageRef` from `uploadSample`. The reference
 *   MUST be unique per object and idempotent across retries that
 *   pass the same (offeringId, bytes, contentType) tuple? NO — the
 *   adapter MUST treat each `uploadSample` call as a NEW object even
 *   if the bytes happen to match. Repeated uploads create distinct
 *   storage references; the application owns the display order and
 *   metadata.
 * - Never expose bucket names, private object keys, provider subjects,
 *   or storage credentials through any return value or error message.
 */
export interface StorageAdapter {
  /**
   * Upload one bounded MP3 sample. Returns the opaque storage
   * reference the application persists in PostgreSQL.
   *
   * Throws `StorageRejectedError` for declared type / size policy
   * violations the adapter enforces defensively. Throws
   * `StorageUnavailableError` for transient provider failures
   * (network, throttling, outage).
   */
  uploadSample(input: StorageUploadInput): Promise<StorageUploadResult>;

  /**
   * Resolve an opaque storage reference back to a playable URL.
   * Returns `null` when the reference is unknown or has been removed.
   * Never throws for a missing reference — the application uses
   * `null` to hide the sample from buyer-facing discovery without
   * crashing.
   */
  getPlaybackReference(storageRef: string): Promise<StoragePlaybackReference | null>;

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
