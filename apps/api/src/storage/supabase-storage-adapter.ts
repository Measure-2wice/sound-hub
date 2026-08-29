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
//      adapter validates it is configured. The returned `storageRef`
//      is a self-contained server-internal locator `supa:{bucket}:{path}`
//      the application persists in PostgreSQL; the adapter parses
//      the locator on every subsequent call without consulting any
//      in-process index, so the locator is durable across adapter
//      restarts. The application NEVER serializes the locator to a
//      public DTO.
//
//   2. `getPlaybackReference` composes the in-app
//      `${apiOrigin}/api/services/{offeringId}/audio-samples/{sampleId}/play`
//      URL. Provider signed URLs, bucket names, and object paths are
//      NEVER returned to the application or serialized to a public
//      DTO. The application proxy route streams the bytes through
//      that path after re-running eligibility + sample-existence
//      checks on every request.
//
//   3. `getPlaybackBytes` mints a narrowly scoped signed URL via
//      the Storage REST `POST /storage/v1/object/sign/{bucket}/{path}`
//      endpoint, fetches the bytes through the SDK-supplied `fetch`,
//      and returns the bytes. The application calls this only
//      after eligibility checks have run. The signed URL never
//      appears in a public DTO; the bytes are returned as a
//      streaming response from the in-app route.
//
//   4. `removeSample` issues `DELETE /storage/v1/object/{bucket}/{path}`
//      and never throws for a 404 (idempotent removal per the
//      adapter contract).
//
// Defense in depth: every adapter method validates content type and
// size BEFORE contacting Supabase. The application boundary ALSO
// validates; the duplicated checks exist so a future drift in either
// side cannot widen the policy unilaterally.

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

export interface SupabaseStorageAdapterOptions {
  readonly supabaseUrl?: string;
  readonly supabaseServiceRoleKey?: string;
  /**
   * Bucket name. Defaults to `offering-audio`. The adapter refuses
   * to operate if the bucket is missing.
   */
  readonly bucket?: string;
  /**
   * Base URL the in-app playback route resolves from. Defaults to
   * `http://localhost:4000`. The playback URL returned to the
   * application is composed from this base so the browser fetches
   * the in-app route, not the Supabase endpoint.
   */
  readonly playbackBaseUrl?: string;
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

export class SupabaseStorageAdapter implements StorageAdapter {
  private readonly supabaseUrl: string | undefined;
  private readonly supabaseServiceRoleKey: string | undefined;
  private readonly bucket: string;
  private readonly playbackBaseUrl: string;
  private readonly signedUrlExpiresInSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly pathPrefix: string;

  constructor(options: SupabaseStorageAdapterOptions = {}) {
    this.supabaseUrl = options.supabaseUrl;
    this.supabaseServiceRoleKey = options.supabaseServiceRoleKey;
    this.bucket = options.bucket ?? "offering-audio";
    this.playbackBaseUrl = options.playbackBaseUrl ?? "http://localhost:4000";
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
    return { storageRef: this.encodeStorageRef(this.bucket, objectPath) };
  }

  /**
   * Compose the in-app SoundHub-owned playback URL. The URL is
   * always rooted at the application route; the application
   * proxy-streams the bytes through this path. The Supabase
   * signed URL is minted internally only on `getPlaybackBytes`.
   * Returns `null` when the storage ref is unparseable or
   * addresses a different bucket than this adapter is wired for.
   */
  getPlaybackReference(input: StoragePlaybackInput): Promise<StoragePlaybackReference | null> {
    const parsed = this.decodeStorageRef(input.storageRef);
    if (!parsed || parsed.bucket !== this.bucket) {
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
   * Resolve the storage ref to raw MP3 bytes by minting a scoped
   * signed URL and fetching the bytes. The application calls this
   * only after eligibility + sample-existence checks have run.
   * The signed URL never appears in a public DTO; the bytes are
   * returned as a streaming response from the in-app route.
   */
  async getPlaybackBytes(storageRef: string): Promise<Uint8Array> {
    this.assertConfigured();
    const parsed = this.decodeStorageRef(storageRef);
    if (!parsed) {
      throw new StorageReferenceUnknownError("Storage reference is unparseable.");
    }
    const { bucket, objectPath } = parsed;
    const signedUrl = await this.mintSignedUrl(bucket, objectPath);
    if (!signedUrl) {
      throw new StorageReferenceUnknownError("Underlying storage object has been removed.");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(signedUrl, { method: "GET" });
    } catch (err) {
      throw new StorageUnavailableError(err instanceof Error ? err.message : String(err));
    }
    if (!response.ok) {
      if (response.status === 404 || response.status === 400) {
        throw new StorageReferenceUnknownError("Underlying storage object has been removed.");
      }
      throw new StorageUnavailableError(
        `Supabase Storage fetch returned ${String(response.status)}.`,
      );
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }

  async removeSample(storageRef: string): Promise<void> {
    this.assertConfigured();
    const record = this.decodeStorageRef(storageRef);
    if (!record) {
      // Idempotent: an unparseable reference is treated as already
      // removed so a retried command never raises.
      return;
    }
    // Per ticket #61 follow-up review (P1-001): the official Supabase
    // Storage REST removal contract issues DELETE against the
    // bucket URL with a JSON body of `{ prefixes: [objectPath] }`.
    // The previous implementation issued DELETE against the object
    // URL with no body, which the provider ignores; a 404 from the
    // wrong route was treated as already-absent, leaving the object
    // permanently stored while the service finalized its durable
    // cleanup row. See StorageFileApi.remove in
    // supabase/storage-js.
    const url = `${this.supabaseUrl}/storage/v1/object/${record.bucket}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.supabaseServiceRoleKey}`,
          apikey: this.supabaseServiceRoleKey ?? "",
        },
        body: JSON.stringify({ prefixes: [record.objectPath] }),
      });
    } catch (err) {
      throw new StorageUnavailableError(err instanceof Error ? err.message : String(err));
    }
    if (response.status === 404) {
      // The provider reports the object as already absent via a
      // bucket-level 404 (e.g. the prefixes body did not match any
      // object, or the bucket is empty). Treat as idempotent
      // success so the bounded retry can finalize the durable
      // cleanup row.
      return;
    }
    if (response.status === 400) {
      // Per ticket #61 follow-up review (P1-001): a generic 400
      // from the bucket DELETE indicates a malformed request,
      // invalid bucket, invalid prefix, or policy rejection — NOT
      // object absence. The provider-faithful contract is silent
      // about whether 400 is ever a valid "already absent" signal;
      // the safe interpretation is to surface the failure as a
      // retryable storage error so the bounded retry drives the
      // next attempt. A 200 or 404 remains the only confirmed-
      // success / confirmed-absent path.
      throw new StorageUnavailableError(
        `Supabase Storage delete returned 400 (malformed request, invalid prefix, or policy rejection): not treated as object absence.`,
      );
    }
    if (!response.ok) {
      throw new StorageUnavailableError(
        `Supabase Storage delete returned ${String(response.status)}.`,
      );
    }
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
   * Self-contained server-internal locator. The application
   * persists this value in PostgreSQL; the adapter parses it on
   * every subsequent call without consulting any in-process
   * index. The reference is NEVER serialized to a public DTO.
   *
   * The bucket name is is included in the locator because the
   * adapter may be wired with one of several buckets in the
   * future (e.g. bucket-per-tenant migrations); the application
   * does not parse the locator and does not see the bucket name.
   */
  private encodeStorageRef(bucket: string, objectPath: string): string {
    return `supa:${bucket}:${objectPath}`;
  }

  private decodeStorageRef(storageRef: string): { bucket: string; objectPath: string } | null {
    if (typeof storageRef !== "string") return null;
    const parts = storageRef.split(":");
    if (parts.length < 3 || parts[0] !== "supa") return null;
    const bucket = parts[1] ?? "";
    const objectPath = parts.slice(2).join(":");
    if (bucket.length === 0 || objectPath.length === 0) return null;
    return { bucket, objectPath };
  }

  private async mintSignedUrl(bucket: string, objectPath: string): Promise<string | null> {
    const url = `${this.supabaseUrl}/storage/v1/object/sign/${bucket}/${objectPath}`;
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
    // Per ticket #61 follow-up review (P1-001): Supabase Storage's
    // /object/sign endpoint returns a path-only `signedURL` like
    // `/object/sign/<bucket>/<path>?token=...`. The application must
    // resolve it against the Storage API base `${SUPABASE_URL}/storage/v1`
    // (NOT the project root). Without this prefix the subsequent
    // fetch targets `${SUPABASE_URL}/object/sign/...` and the GET
    // fails, so managed playback is broken even though upload
    // succeeded. The Storage SDK and supabase-js both compose the
    // same base; see SupabaseClient and StorageFileApi.
    //
    // Per ticket #61 follow-up review (P0-001) the resolved URL
    // MUST stay on the configured Supabase origin. A hostile
    // signedURL that escapes to attacker.example / loopback / a
    // different Supabase project would let a compromised provider
    // response forge SoundHub's downstream GET. `resolveSupabaseStorageUrl`
    // returns `null` when the URL fails origin/path validation, which
    // we surface as a safe provider error.
    //
    // Per ticket #61 follow-up review (latest) the resolved URL
    // MUST also match the exact bucket + objectPath we asked the
    // provider to sign. A same-origin cross-bucket or cross-object
    // response must NOT be allowed to make SoundHub proxy another
    // private object's bytes. The helper accepts an `expected`
    // tuple (bucket, objectPath) and rejects any URL whose
    // pathname resolves to a different bucket or object.
    const resolvedUrl = resolveSupabaseStorageUrl(this.supabaseUrl ?? "", parsed.signedURL, {
      bucket,
      objectPath,
    });
    if (!resolvedUrl) {
      throw new StorageUnavailableError(
        "Supabase Storage signed URL did not match the requested bucket and object.",
      );
    }
    return resolvedUrl;
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

/**
 * Resolve a Supabase Storage signed-URL path against the Storage
 * API base. The Storage REST endpoint
 * `POST /storage/v1/object/sign/<bucket>/<path>` returns a path-only
 * `signedURL` (e.g. `/object/sign/<bucket>/<path>?token=...`). The
 * resolved URL must live under `${SUPABASE_URL}/storage/v1`, NOT
 * the project root, so the subsequent GET actually targets the
 * Storage API.
 *
 * Per ticket #61 follow-up review (P0-001) the adapter MUST reject
 * any signedURL that resolves to a host outside the configured
 * Supabase project origin. A compromised provider response (or a
 * cross-tenant response mix-up) cannot be allowed to redirect
 * SoundHub's downstream GET to attacker.example, loopback, a
 * different Supabase project, a protocol-relative URL, a
 * credential-bearing URL, or any other unexpected origin. Only the
 * exact configured origin plus a `/storage/v1/object/sign/<bucket>/...`
 * path is accepted.
 *
 * Per ticket #61 follow-up review (latest) the resolved URL MUST
 * also match the exact bucket + object the caller asked the
 * provider to sign. A same-origin cross-bucket or cross-object
 * response must NOT be allowed to make SoundHub proxy another
 * private object's bytes. When `expected` is provided the helper
 * rejects any URL whose pathname resolves to a different bucket or
 * a different object, including encoded-confusable variants.
 *
 * Returns `null` when the input fails validation. Exported for
 * unit testing the URL composition independently of the network
 * stack.
 */
export function resolveSupabaseStorageUrl(
  supabaseUrl: string,
  signedPath: string,
  expected?: { readonly bucket: string; readonly objectPath: string },
): string | null {
  const base = supabaseUrl.replace(/\/+$/, "");
  if (!base) return null;

  // Reject `..` traversal segments (raw or percent-encoded) in
  // the input path BEFORE resolution. `new URL` would silently
  // normalize `..` to navigate above the bucket prefix, which
  // would let a hostile signedURL escape its declared bucket. A
  // legitimate Storage signedURL never contains `..` segments.
  // Wrap the decoder so malformed percent encoding returns null
  // through the same safe-validation path rather than throwing.
  let normalizedForTraversal: string;
  try {
    normalizedForTraversal = decodeURIComponent(signedPath);
  } catch {
    return null;
  }
  if (normalizedForTraversal.split("/").includes("..")) return null;

  // Protocol-relative URLs (`//attacker.example/...`) must be
  // rejected outright. They are NOT legitimate signed-URL
  // responses from the Storage REST endpoint.
  if (signedPath.startsWith("//")) return null;

  // Resolve the path against the configured origin. This collapses
  // both already-absolute HTTP(S) URLs and relative paths into a
  // single URL object we can validate.
  let resolved: URL;
  try {
    resolved = new URL(signedPath, `${base}/`);
  } catch {
    return null;
  }

  // Reject unexpected schemes. The signed-URL response is always
  // https or http against the configured Supabase project.
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
    return null;
  }

  // Reject credential-bearing URLs (user:pass@host) and
  // fragment-bearing URLs. Neither is legitimate from the Storage
  // REST endpoint and both are common SSRF vectors.
  if (resolved.username || resolved.password || resolved.hash.length > 0) {
    return null;
  }

  // The origin MUST equal the configured Supabase project origin.
  // Anything else — attacker.example, loopback, link-local, a
  // different Supabase project — is a server-side request forgery.
  if (resolved.origin !== base) return null;

  // The path MUST live under the Storage API signed-URL family.
  // Supabase Storage's /object/sign endpoint returns a relative
  // path of the form `/object/sign/<bucket>/<path>?token=...` which
  // the SDK prefixes with `/storage/v1`. Accept either prefix; if
  // the resolved path is the unprefixed `/object/sign/...` form,
  // canonicalize it to the `/storage/v1/object/sign/...` form so
  // the downstream fetch targets the Storage API exactly as the
  // SDK would. A path under neither prefix (a different path
  // family or a path outside the bucket) is rejected.
  const storageV1Prefix = `/storage/v1/object/sign/`;
  const relativePrefix = `/object/sign/`;
  let canonicalPath: string;
  if (resolved.pathname.startsWith(storageV1Prefix)) {
    canonicalPath = resolved.pathname;
  } else if (resolved.pathname.startsWith(relativePrefix)) {
    canonicalPath = `${storageV1Prefix}${resolved.pathname.slice(relativePrefix.length)}`;
  } else {
    return null;
  }

  // Per ticket #61 follow-up review (latest): bind the resolved
  // pathname to the exact bucket + object the caller asked the
  // provider to sign. A same-origin cross-bucket or cross-object
  // response (e.g. a sibling object in the same bucket, or a
  // prefix-confusable encoded variant) must NOT be allowed to make
  // SoundHub proxy another private object's bytes. We compare
  // canonical, percent-decoded bucket and object segments so an
  // attacker cannot bypass the check with `..` segments or
  // double-encoded variants (the `..` traversal check above
  // already rejects literal `..`, but encoded equivalents are
  // normalized here for a final equivalence check). All
  // decodeURIComponent calls are wrapped in try/catch so malformed
  // percent encoding returns null through the safe validation
  // path rather than throwing URIError past the helper boundary.
  if (expected) {
    let expectedBucket: string;
    let expectedObject: string;
    try {
      expectedBucket = decodeURIComponent(expected.bucket);
      expectedObject = decodeURIComponent(expected.objectPath);
    } catch {
      return null;
    }
    const expectedSignPath = `${storageV1Prefix}${encodeURIComponent(expectedBucket).replace(/%2F/gi, "/")}/${encodeURIComponent(expectedObject).replace(/%2F/gi, "/")}`;
    if (canonicalPath !== expectedSignPath) return null;
  }

  return new URL(`${base}${canonicalPath}?${resolved.searchParams.toString()}`).toString();
}
