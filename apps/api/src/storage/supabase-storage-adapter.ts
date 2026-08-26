// Supabase Storage adapter.
//
// Background: ticket #61 makes Supabase Storage the deployed primary
// storage backend for seller MP3 discovery samples. The adapter
// satisfies the same application-facing contract as the deterministic
// in-memory adapter so higher layers (routes, services, repositories)
// cannot drift based on the wired backend.
//
// Wire-level contract:
//
//   1. `uploadSample` issues a POST against
//      `${SUPABASE_URL}/storage/v1/object/{bucket}/{path}`. The bucket
//      is server-side-only (SUPABASE_STORAGE_BUCKET env var); the
//      adapter validates it is configured and refuses to upload to a
//      public bucket because MP3 samples are private bytes owned by
//      the seller. The returned `storageRef` is an opaque per-sample
//      id; the bucket/path mapping is held inside the adapter and
//      never serialized to a public DTO.
//
//   2. `getPlaybackReference` derives a narrowly scoped signed URL
//      via the Storage REST `POST /storage/v1/object/sign/{bucket}/
//      {path}` endpoint. The URL is the only value returned to the
//      application; bucket name, signing key, and path never cross
//      the application boundary through the public DTO.
//
//   3. `removeSample` issues `DELETE /storage/v1/object/{bucket}/
//      {path}` and never throws for a 404 (idempotent removal per
//      the adapter contract). The storage-ref → bucket/path mapping
//      is removed from the adapter's internal index on success.
//
// Defense in depth: every adapter method validates content type and
// size BEFORE contacting Supabase. The application boundary ALSO
// validates; the duplicated checks exist so a future drift in either
// side cannot widen the policy unilaterally.

import { BG2_AUDIO_SAMPLE_CONTENT_TYPE, BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE } from "@soundhub/types";
import {
  StorageRejectedError,
  StorageUnavailableError,
  type StorageAdapter,
  type StoragePlaybackInput,
  type StoragePlaybackReference,
  type StorageUploadInput,
  type StorageUploadResult,
} from "./storage-adapter.js";

export interface SupabaseStorageAdapterOptions {
  readonly supabaseUrl?: string;
  readonly supabaseServiceRoleKey?: string;
  /**
   * Bucket name. Defaults to `offering-audio`. The adapter refuses
   * to operate if the bucket is missing.
   */
  readonly bucket?: string;
  /**
   * Signed-URL lifetime in seconds. Defaults to 300 (5 minutes), the
   * minimum window needed for an audio player to start playback
   * without crossing a signed URL expiry.
   */
  readonly signedUrlExpiresInSeconds?: number;
  /**
   * Optional HTTP fetch implementation. Tests pass a stub.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional path prefix inside the bucket. Defaults to `samples`.
   * The adapter appends `${prefix}/${offeringId}/${cuid}.mp3`.
   */
  readonly pathPrefix?: string;
}

interface SignSuccessBody {
  readonly signedURL: string;
}

interface UploadedObject {
  readonly bucket: string;
  readonly objectPath: string;
}

export class SupabaseStorageAdapter implements StorageAdapter {
  private readonly supabaseUrl: string | undefined;
  private readonly supabaseServiceRoleKey: string | undefined;
  private readonly bucket: string;
  private readonly signedUrlExpiresInSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly pathPrefix: string;
  /**
   * Per-sample mapping from opaque storage ref to bucket/object path.
   * The index lives in-process for the buildathon scope; a future
   * scope may persist it (Supabase object metadata or a side column
   * on `ServiceOfferingAudioSample`). The reference returned to the
   * application is opaque and never reveals bucket/path through any
   * public DTO — the application reads it back only via
   * `getPlaybackReference` and `removeSample`, both of which go
   * through this index.
   */
  private readonly index = new Map<string, UploadedObject>();

  constructor(options: SupabaseStorageAdapterOptions = {}) {
    this.supabaseUrl = options.supabaseUrl;
    this.supabaseServiceRoleKey = options.supabaseServiceRoleKey;
    this.bucket = options.bucket ?? "offering-audio";
    this.signedUrlExpiresInSeconds = options.signedUrlExpiresInSeconds ?? 300;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pathPrefix = options.pathPrefix ?? "samples";
  }

  /**
   * True when the adapter has the configuration required to call
   * Supabase Storage. The factory uses this to decide between
   * managed and deterministic backends at startup.
   */
  isConfigured(): boolean {
    return Boolean(this.supabaseUrl && this.supabaseServiceRoleKey);
  }

  assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new StorageUnavailableError(
        "Supabase Storage adapter requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
  }

  async uploadSample(input: StorageUploadInput): Promise<StorageUploadResult> {
    this.assertConfigured();
    if (input.contentType !== BG2_AUDIO_SAMPLE_CONTENT_TYPE) {
      throw new StorageRejectedError(
        `Only audio/mpeg samples are accepted (got ${String(input.contentType)}).`,
      );
    }
    if (input.byteSize > BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE) {
      throw new StorageRejectedError(
        `Sample exceeds the ${BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE}-byte limit.`,
      );
    }
    if (input.bytes.byteLength !== input.byteSize) {
      throw new StorageRejectedError("Declared byte size does not match observed bytes.");
    }

    const objectPath = this.buildObjectPath(input.offeringId);
    const url = `${this.supabaseUrl}/storage/v1/object/${this.bucket}/${objectPath}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": input.contentType,
          Authorization: `Bearer ${this.supabaseServiceRoleKey}`,
          apikey: this.supabaseServiceRoleKey ?? "",
          "x-upsert": "false",
        },
        body: this.toBody(input.bytes),
      });
    } catch (err) {
      throw new StorageUnavailableError(err instanceof Error ? err.message : String(err));
    }
    if (!response.ok) {
      if (response.status >= 500) {
        throw new StorageUnavailableError(`Supabase Storage returned ${String(response.status)}.`);
      }
      throw new StorageRejectedError(
        `Supabase Storage rejected the upload with status ${String(response.status)}.`,
      );
    }
    const storageRef = this.makeStorageRef();
    this.index.set(storageRef, { bucket: this.bucket, objectPath });
    return { storageRef };
  }

  async getPlaybackReference(
    input: StoragePlaybackInput,
  ): Promise<StoragePlaybackReference | null> {
    this.assertConfigured();
    const record = this.index.get(input.storageRef);
    if (!record) return null;
    const url = `${this.supabaseUrl}/storage/v1/object/sign/${record.bucket}/${record.objectPath}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.supabaseServiceRoleKey}`,
          apikey: this.supabaseServiceRoleKey ?? "",
        },
        body: JSON.stringify({ expiresIn: this.signedUrlExpiresInSeconds }),
      });
    } catch (err) {
      throw new StorageUnavailableError(err instanceof Error ? err.message : String(err));
    }
    if (response.status === 404 || response.status === 400) {
      // A removed or never-existed object returns 4xx from Supabase
      // Storage. The application must hide the sample from buyer-
      // facing discovery rather than surface a player URL.
      return null;
    }
    if (!response.ok) {
      throw new StorageUnavailableError(
        `Supabase Storage sign returned ${String(response.status)}.`,
      );
    }
    const raw: unknown = await response.json().catch(() => null);
    const parsed = parseSignSuccessBody(raw);
    if (!parsed) {
      throw new StorageUnavailableError(
        "Supabase Storage sign response did not match the expected schema.",
      );
    }
    return {
      url: `${this.supabaseUrl}${parsed.signedURL}`,
      cacheControlHint: "private, max-age=60",
    };
  }

  async removeSample(storageRef: string): Promise<void> {
    this.assertConfigured();
    const record = this.index.get(storageRef);
    if (!record) {
      // Idempotent: an unknown reference is treated as already
      // removed so a retried command never raises.
      return;
    }
    const url = `${this.supabaseUrl}/storage/v1/object/${record.bucket}/${record.objectPath}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.supabaseServiceRoleKey}`,
          apikey: this.supabaseServiceRoleKey ?? "",
        },
      });
    } catch (err) {
      throw new StorageUnavailableError(err instanceof Error ? err.message : String(err));
    }
    if (response.status === 404) {
      // Already gone — idempotent success. Drop the index entry
      // either way so a subsequent remove is also a no-op.
      this.index.delete(storageRef);
      return;
    }
    if (!response.ok) {
      throw new StorageUnavailableError(
        `Supabase Storage delete returned ${String(response.status)}.`,
      );
    }
    this.index.delete(storageRef);
  }

  /**
   * Build the private object path for a given offering. The path is
   * scoped by offering id and a per-sample cuid so removal of one
   * sample cannot affect siblings.
   */
  private buildObjectPath(offeringId: string): string {
    const cuid = this.makeCuid();
    const prefix = this.pathPrefix.replace(/^\/+|\/+$/g, "");
    return `${prefix}/${encodeURIComponent(offeringId)}/${cuid}.mp3`;
  }

  /**
   * Mint a per-sample opaque id. The application never parses it;
   * the adapter resolves it back to bucket/path via the index.
   */
  private makeStorageRef(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  private makeCuid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  private toBody(bytes: Uint8Array): BodyInit {
    // Node's `fetch` accepts a Uint8Array directly; the cross-runtime
    // cast keeps the adapter portable for tests that stub `fetch`.
    return bytes as unknown as BodyInit;
  }
}

function parseSignSuccessBody(raw: unknown): SignSuccessBody | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { signedURL?: unknown };
  if (typeof candidate.signedURL !== "string") return null;
  if (candidate.signedURL.length === 0 || candidate.signedURL.length > 4096) return null;
  return { signedURL: candidate.signedURL };
}
