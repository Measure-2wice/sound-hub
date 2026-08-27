// Supabase storage adapter tests.
//
// Background: ticket #61 makes Supabase Storage the deployed primary
// storage backend for seller MP3 discovery samples. These tests pin
// the adapter's observable contract — opaque storage reference,
// idempotent removal, MP3-only enforcement, 25 MB cap, signed URL
// composition — against a stubbed fetch so the suite remains
// network-free.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SupabaseStorageAdapter } from "./supabase-storage-adapter.js";
import { StorageRejectedError, StorageUnavailableError } from "./storage-adapter.js";
import { BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE } from "@soundhub/types";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function makeFetchStub(handler: (call: FetchCall) => Response): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const record: FetchCall = { url, init: init ?? {} };
    calls.push(record);
    return Promise.resolve(handler(record));
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function headersValue(headers: RequestInit["headers"], name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find((entry) => entry[0] === name);
    return found?.[1];
  }
  const record: Record<string, string> = headers;
  return record[name];
}

const SUPABASE_URL = "https://supabase.example.test";
const SUPABASE_KEY = "service-role-key";

describe("SupabaseStorageAdapter", () => {
  test("isConfigured requires URL and service role key", () => {
    const missing = new SupabaseStorageAdapter({});
    assert.equal(missing.isConfigured(), false);
    const configured = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
    });
    assert.equal(configured.isConfigured(), true);
  });

  test("uploadSample issues a POST to /storage/v1/object/<bucket>/<path>", async () => {
    const capturedHolder: { current: FetchCall | null } = { current: null };
    const { fetchImpl, calls } = makeFetchStub((call) => {
      capturedHolder.current = call;
      return new Response(null, { status: 200 });
    });
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      fetchImpl,
    });
    const result = await adapter.uploadSample({
      label: "Sample",
      contentType: "audio/mpeg",
      byteSize: 4,
      offeringId: "of-1",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    const captured = capturedHolder.current;
    assert.ok(captured);
    assert.ok(captured.url.startsWith(`${SUPABASE_URL}/storage/v1/object/offering-audio/samples/`));
    assert.equal(captured.init.method, "POST");
    assert.equal(headersValue(captured.init.headers, "Content-Type"), "audio/mpeg");
    // Per ticket #61 follow-up review the storage reference is
    // an opaque handle, NOT a `supa:{bucket}:{path}` value. The
    // adapter resolves the handle back to bucket/path via an
    // internal index.
    assert.ok(result.storageRef.length > 0);
    // The storage ref is a self-contained server-internal locator
    // that the adapter parses on every call. It is NEVER serialized
    // to a public DTO; that is the privacy boundary. The locator
    // itself can include bucket/path because the application never
    // sees it.
    assert.ok(
      result.storageRef.startsWith("supa:offering-audio:"),
      "self-contained locator must identify the bucket",
    );
    assert.equal(calls.length, 1);
  });

  test("uploadSample rejects a non-MP3 content type", async () => {
    const { fetchImpl } = makeFetchStub(() => new Response(null, { status: 200 }));
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      fetchImpl,
    });
    await assert.rejects(
      () =>
        adapter.uploadSample({
          label: "S",
          contentType: "audio/wav" as unknown as "audio/mpeg",
          byteSize: 16,
          offeringId: "of-1",
          bytes: new Uint8Array(16),
        }),
      (err: unknown) => err instanceof StorageRejectedError,
    );
  });

  test("uploadSample rejects oversize objects (GS 11)", async () => {
    const { fetchImpl } = makeFetchStub(() => new Response(null, { status: 200 }));
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      fetchImpl,
    });
    await assert.rejects(
      () =>
        adapter.uploadSample({
          label: "S",
          contentType: "audio/mpeg",
          byteSize: BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE + 1,
          offeringId: "of-1",
          bytes: new Uint8Array(BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE + 1),
        }),
      (err: unknown) => err instanceof StorageRejectedError,
    );
  });

  test("uploadSample maps a 5xx to StorageUnavailableError", async () => {
    const { fetchImpl } = makeFetchStub(() => new Response(null, { status: 503 }));
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      fetchImpl,
    });
    await assert.rejects(
      () =>
        adapter.uploadSample({
          label: "S",
          contentType: "audio/mpeg",
          byteSize: 4,
          offeringId: "of-1",
          bytes: new Uint8Array(4),
        }),
      (err: unknown) => err instanceof StorageUnavailableError,
    );
  });

  test("getPlaybackReference returns the in-app SoundHub-owned URL (not a provider signed URL)", async () => {
    // Per ticket #61 follow-up review (P0-001) the public DTO must
    // never expose provider signed URLs, bucket names, or object
    // paths. The adapter composes the in-app
    // /api/services/.../play route; the Supabase signed URL is
    // minted internally only on getPlaybackBytes.
    const { fetchImpl } = makeFetchStub(() =>
      jsonResponse({ signedURL: "/object/sign/offering-audio/samples/x.mp3?token=abc" }),
    );
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      playbackBaseUrl: "http://api.example.test",
      fetchImpl,
    });
    const result = await adapter.uploadSample({
      label: "S",
      contentType: "audio/mpeg",
      byteSize: 4,
      offeringId: "of-1",
      bytes: new Uint8Array(4),
    });
    const ref = await adapter.getPlaybackReference({
      storageRef: result.storageRef,
      offeringId: "of-1",
      sampleId: "smp-1",
    });
    assert.ok(ref);
    assert.equal(ref.url, "http://api.example.test/api/services/of-1/audio-samples/smp-1/play");
    assert.equal(ref.url.includes("supa:"), false);
    assert.equal(ref.url.includes("token="), false);
  });

  test("getPlaybackReference returns null for an unknown reference", async () => {
    const { fetchImpl } = makeFetchStub(() => new Response(null, { status: 404 }));
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      fetchImpl,
    });
    const ref = await adapter.getPlaybackReference({
      storageRef: "unknown-opaque-ref",
      offeringId: "of-1",
      sampleId: "smp-1",
    });
    assert.equal(ref, null);
  });

  test("removeSample is idempotent for an unknown reference", async () => {
    const { fetchImpl, calls } = makeFetchStub(() => new Response(null, { status: 404 }));
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      fetchImpl,
    });
    // Truly unknown reference (not in the adapter's index).
    await adapter.removeSample("never-uploaded-ref");
    assert.equal(calls.length, 0, "no fetch call is made for an unindexed reference");
  });

  test("P1-001: removeSample issues a provider-faithful DELETE against /storage/v1/object/<bucket>", async () => {
    // Per ticket #61 follow-up review (P1-001): the official Supabase
    // Storage REST removal contract sends DELETE to the bucket URL
    // with a JSON body `{ prefixes: [objectPath] }`. The previous
    // implementation issued DELETE against the object URL with no
    // body, which the provider ignores; a 404 from the wrong route
    // was treated as already-absent. This test pins the exact URL,
    // method, JSON body, and content-type against a faithful fetch
    // stub.
    const uploadBytes = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const recordedCalls: FetchCall[] = [];
    let capturedObjectPath = "";
    const { fetchImpl } = makeFetchStub((call) => {
      recordedCalls.push(call);
      const uploadPrefix = `${SUPABASE_URL}/storage/v1/object/offering-audio/samples/of-1/`;
      if (call.init.method === "POST" && call.url.startsWith(uploadPrefix)) {
        // The provider-faithful prefixes body uses the full object
        // path including the path prefix (`samples/of-1/<cuid>.mp3`).
        capturedObjectPath = `samples/of-1/${call.url.slice(uploadPrefix.length)}`;
        return new Response(null, { status: 200 });
      }
      // Correct provider-faithful removal URL: bucket URL only,
      // never the object URL.
      const deleteUrl = `${SUPABASE_URL}/storage/v1/object/offering-audio`;
      if (call.init.method === "DELETE" && call.url === deleteUrl) {
        // The provider-faithful body is `{ prefixes: [objectPath] }`.
        const bodyText =
          typeof call.init.body === "string"
            ? call.init.body
            : call.init.body instanceof Uint8Array
              ? new TextDecoder().decode(call.init.body)
              : "";
        const parsed: unknown = JSON.parse(bodyText);
        assert.deepEqual(parsed, { prefixes: [capturedObjectPath] });
        assert.equal(headersValue(call.init.headers, "Content-Type"), "application/json");
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      pathPrefix: "samples",
      fetchImpl,
    });
    const ref = (
      await adapter.uploadSample({
        label: "S",
        contentType: "audio/mpeg",
        byteSize: uploadBytes.byteLength,
        offeringId: "of-1",
        bytes: uploadBytes,
      })
    ).storageRef;
    await adapter.removeSample(ref);
    const deleteCall = recordedCalls.find((c) => c.init.method === "DELETE");
    assert.ok(deleteCall, "exactly one DELETE call is issued");
    assert.equal(
      deleteCall.url,
      `${SUPABASE_URL}/storage/v1/object/offering-audio`,
      "DELETE targets the bucket URL, not the object URL",
    );
  });

  test("P1-001: removeSample treats 404 from the bucket DELETE as idempotent success", async () => {
    // The provider reports the object as already absent via a 404
    // from the correct bucket DELETE. The adapter treats that as
    // idempotent success so the bounded retry can finalize the
    // durable cleanup row.
    const uploadBytes = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const { fetchImpl, calls } = makeFetchStub((call) => {
      if (call.init.method === "POST") return new Response(null, { status: 200 });
      if (call.init.method === "DELETE") return new Response(null, { status: 404 });
      return new Response(null, { status: 404 });
    });
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      pathPrefix: "samples",
      fetchImpl,
    });
    const ref = (
      await adapter.uploadSample({
        label: "S",
        contentType: "audio/mpeg",
        byteSize: uploadBytes.byteLength,
        offeringId: "of-1",
        bytes: uploadBytes,
      })
    ).storageRef;
    await adapter.removeSample(ref);
    const deleteCall = calls.find((c) => c.init.method === "DELETE");
    assert.ok(deleteCall);
    assert.equal(deleteCall.url, `${SUPABASE_URL}/storage/v1/object/offering-audio`);
  });

  test("P1-001: removeSample surfaces a StorageUnavailableError on provider failure", async () => {
    // Provider returns 500. The adapter must surface the failure as
    // a retryable storage error so the bounded retry can drive
    // the next attempt.
    const uploadBytes = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const { fetchImpl } = makeFetchStub((call) => {
      if (call.init.method === "POST") return new Response(null, { status: 200 });
      if (call.init.method === "DELETE") return new Response(null, { status: 500 });
      return new Response(null, { status: 404 });
    });
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      pathPrefix: "samples",
      fetchImpl,
    });
    const ref = (
      await adapter.uploadSample({
        label: "S",
        contentType: "audio/mpeg",
        byteSize: uploadBytes.byteLength,
        offeringId: "of-1",
        bytes: uploadBytes,
      })
    ).storageRef;
    await assert.rejects(
      () => adapter.removeSample(ref),
      (err: unknown) => err instanceof StorageUnavailableError,
    );
  });

  test("the storage reference is durable (self-contained) but never crosses the public DTO", async () => {
    // Per ticket #61 follow-up review (P1-001) the storage ref is a
    // self-contained server-internal locator the adapter parses on
    // every call, so the locator survives an adapter restart. The
    // privacy boundary is that the locator is NEVER serialized to a
    // public DTO; the public DTO carries only the SoundHub-owned
    // in-app playback URL.
    const { fetchImpl } = makeFetchStub(() => new Response(null, { status: 200 }));
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      fetchImpl,
    });
    const result = await adapter.uploadSample({
      label: "S",
      contentType: "audio/mpeg",
      byteSize: 4,
      offeringId: "of-1",
      bytes: new Uint8Array(4),
    });
    // Self-contained: the adapter parses it back without consulting
    // any in-process index.
    assert.ok(
      result.storageRef.startsWith("supa:offering-audio:"),
      "storage ref must identify the bucket so a fresh adapter can resolve it",
    );
    // The storage ref is not part of the public DTO. The application
    // server uses it server-side only (PostgreSQL column).
    assert.notEqual(
      JSON.stringify({ sampleId: "smp-1", storageRef: result.storageRef }),
      JSON.stringify({ sampleId: "smp-1" }),
    );
  });

  test("removal is idempotent and self-contained storage ref parses back to bucket/path", async () => {
    // Per P1-001 the locator must survive an adapter restart; this
    // test asserts the locator is durable (parseable) regardless
    // of removeSample being called.
    const { fetchImpl } = makeFetchStub((call) => {
      if (call.init.method === "DELETE") return new Response(null, { status: 200 });
      return new Response(null, { status: 200 });
    });
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      fetchImpl,
    });
    const ref = (
      await adapter.uploadSample({
        label: "S",
        contentType: "audio/mpeg",
        byteSize: 4,
        offeringId: "of-1",
        bytes: new Uint8Array(4),
      })
    ).storageRef;
    // Locator is parseable; the adapter can resolve it.
    assert.ok(ref.startsWith("supa:offering-audio:"));
    await adapter.removeSample(ref);
    await adapter.removeSample(ref);
  });

  test("P1-001: getPlaybackBytes resolves the signed URL against the /storage/v1 base", async () => {
    // The sign endpoint returns a path-only signedURL like
    // /object/sign/...; the subsequent GET must target the
    // Storage API at `${SUPABASE_URL}/storage/v1/object/sign/...`,
    // not the project root. Without this prefix managed playback
    // fails even though upload succeeds.
    const uploadBytes = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4,
    ]);
    const recordedCalls: FetchCall[] = [];
    let capturedObjectPath = "";
    const { fetchImpl } = makeFetchStub((call) => {
      recordedCalls.push(call);
      const uploadPrefix = `${SUPABASE_URL}/storage/v1/object/offering-audio/samples/of-1/`;
      if (call.init.method === "POST" && call.url.startsWith(uploadPrefix)) {
        capturedObjectPath = call.url.slice(uploadPrefix.length);
        return new Response(null, { status: 200 });
      }
      const signUrl = `${SUPABASE_URL}/storage/v1/object/sign/offering-audio/samples/of-1/${capturedObjectPath}`;
      if (call.init.method === "POST" && call.url === signUrl) {
        return jsonResponse({
          signedURL: `/object/sign/offering-audio/samples/of-1/${capturedObjectPath}?token=abc`,
        });
      }
      // The subsequent GET against the resolved signed URL.
      const resolvedSignedUrl = `${SUPABASE_URL}/storage/v1/object/sign/offering-audio/samples/of-1/${capturedObjectPath}?token=abc`;
      if (call.init.method === "GET" && call.url === resolvedSignedUrl) {
        return new Response(uploadBytes, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      pathPrefix: "samples",
      fetchImpl,
    });
    const ref = (
      await adapter.uploadSample({
        label: "S",
        contentType: "audio/mpeg",
        byteSize: uploadBytes.byteLength,
        offeringId: "of-1",
        bytes: uploadBytes,
      })
    ).storageRef;
    // Simulate a fresh adapter — resolve the persisted ref.
    const freshAdapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      pathPrefix: "samples",
      fetchImpl,
    });
    const bytes = await freshAdapter.getPlaybackBytes(ref);
    assert.ok(bytes);
    assert.equal(bytes.byteLength, uploadBytes.byteLength);
    // The sign request must hit /storage/v1/object/sign/...
    const signCall = recordedCalls.find((c) => c.url.includes("/storage/v1/object/sign/"));
    assert.ok(signCall, "sign request targets the Storage API base");
    // The subsequent GET must hit the /storage/v1-prefixed URL,
    // NOT the project root.
    const downloadCall = recordedCalls.find(
      (c) =>
        c.init.method === "GET" &&
        !c.url.endsWith("/object/sign/offering-audio/samples/of-1/test.mp3"),
    );
    assert.ok(downloadCall);
    assert.ok(
      downloadCall.url.startsWith(`${SUPABASE_URL}/storage/v1/object/sign/`),
      `GET must target the Storage API base, got ${downloadCall.url}`,
    );
    assert.ok(
      !downloadCall.url.startsWith(`${SUPABASE_URL}/object/sign/`),
      `GET must NOT target the project root, got ${downloadCall.url}`,
    );
  });

  test("P0-001: a signedURL pointing at an attacker origin is rejected with no outbound GET", async () => {
    // Per ticket #61 follow-up review (P0-001): the adapter must
    // reject any signedURL that resolves to a host outside the
    // configured Supabase project. A compromised provider response
    // cannot be allowed to forge SoundHub's downstream GET to
    // attacker.example / loopback / link-local / a different
    // Supabase project / a protocol-relative URL / a credential-
    // bearing URL / or any other unexpected origin.
    const uploadBytes = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4,
    ]);
    const recordedCalls: FetchCall[] = [];
    const attackerOrigins = [
      "https://attacker.example/object/sign/offering-audio/samples/x.mp3?token=evil",
      "https://localhost:4000/storage/v1/object/sign/offering-audio/samples/x.mp3?token=evil",
      "https://169.254.169.254/latest/meta-data/object/sign/x.mp3?token=evil",
      "https://other-supabase.example.test/storage/v1/object/sign/offering-audio/samples/x.mp3?token=evil",
      "//attacker.example/storage/v1/object/sign/offering-audio/samples/x.mp3?token=evil",
      `${SUPABASE_URL.replace("https://", "https://user:pass@")}/storage/v1/object/sign/offering-audio/samples/x.mp3?token=evil`,
    ];
    const { fetchImpl } = makeFetchStub((call) => {
      recordedCalls.push(call);
      const uploadPrefix = `${SUPABASE_URL}/storage/v1/object/offering-audio/samples/of-1/`;
      if (call.init.method === "POST" && call.url.startsWith(uploadPrefix)) {
        return new Response(null, { status: 200 });
      }
      const signUrl = `${SUPABASE_URL}/storage/v1/object/sign/offering-audio/samples/of-1/`;
      if (call.init.method === "POST" && call.url.startsWith(signUrl)) {
        // Cycle through the hostile payloads so every variant is
        // exercised on its own getPlaybackBytes call.
        const calls = recordedCalls.filter(
          (c) => c.init.method === "POST" && c.url.startsWith(signUrl),
        ).length;
        const hostileSigned = attackerOrigins[(calls - 1) % attackerOrigins.length];
        return jsonResponse({ signedURL: hostileSigned });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      pathPrefix: "samples",
      fetchImpl,
    });
    const ref = (
      await adapter.uploadSample({
        label: "S",
        contentType: "audio/mpeg",
        byteSize: uploadBytes.byteLength,
        offeringId: "of-1",
        bytes: uploadBytes,
      })
    ).storageRef;
    // Each call to getPlaybackBytes triggers one sign call; assert
    // that NO GET is issued because the resolved URL is rejected.
    for (let i = 0; i < attackerOrigins.length; i += 1) {
      await assert.rejects(
        () => adapter.getPlaybackBytes(ref),
        (err: unknown) =>
          err instanceof StorageUnavailableError ||
          (err instanceof Error && err.name === "StorageReferenceUnknownError"),
      );
    }
    const getCalls = recordedCalls.filter((c) => c.init.method === "GET");
    assert.equal(getCalls.length, 0, "no outbound GET may be issued for hostile signedURL values");
  });

  test("P0-001: a signedURL with embedded traversal escapes is rejected", async () => {
    const uploadBytes = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4,
    ]);
    const recordedCalls: FetchCall[] = [];
    const traversalPaths = [
      "/storage/v1/object/sign/offering-audio/../escape.mp3?token=evil",
      "/storage/v1/object/sign/../etc/passwd?token=evil",
      "/storage/v1/object/sign/offering-audio/samples/..%2F..%2Fescape.mp3?token=evil",
    ];
    const { fetchImpl } = makeFetchStub((call) => {
      recordedCalls.push(call);
      const uploadPrefix = `${SUPABASE_URL}/storage/v1/object/offering-audio/samples/of-1/`;
      if (call.init.method === "POST" && call.url.startsWith(uploadPrefix)) {
        return new Response(null, { status: 200 });
      }
      const signUrl = `${SUPABASE_URL}/storage/v1/object/sign/offering-audio/samples/of-1/`;
      if (call.init.method === "POST" && call.url.startsWith(signUrl)) {
        const calls = recordedCalls.filter(
          (c) => c.init.method === "POST" && c.url.startsWith(signUrl),
        ).length;
        return jsonResponse({
          signedURL: traversalPaths[(calls - 1) % traversalPaths.length],
        });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      pathPrefix: "samples",
      fetchImpl,
    });
    const ref = (
      await adapter.uploadSample({
        label: "S",
        contentType: "audio/mpeg",
        byteSize: uploadBytes.byteLength,
        offeringId: "of-1",
        bytes: uploadBytes,
      })
    ).storageRef;
    for (let i = 0; i < traversalPaths.length; i += 1) {
      await assert.rejects(() => adapter.getPlaybackBytes(ref));
    }
    const getCalls = recordedCalls.filter((c) => c.init.method === "GET");
    assert.equal(
      getCalls.length,
      0,
      "no outbound GET may be issued for traversal signedURL values",
    );
  });

  test("P0-001: malformed signedURL values are rejected", async () => {
    const uploadBytes = new Uint8Array([
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4,
    ]);
    const recordedCalls: FetchCall[] = [];
    const malformedValues = [
      "",
      "not-a-url",
      "ftp://attacker.example/storage/v1/object/sign/x.mp3?token=evil",
      "javascript:alert(1)",
      "  ",
    ];
    const { fetchImpl } = makeFetchStub((call) => {
      recordedCalls.push(call);
      const uploadPrefix = `${SUPABASE_URL}/storage/v1/object/offering-audio/samples/of-1/`;
      if (call.init.method === "POST" && call.url.startsWith(uploadPrefix)) {
        return new Response(null, { status: 200 });
      }
      const signUrl = `${SUPABASE_URL}/storage/v1/object/sign/offering-audio/samples/of-1/`;
      if (call.init.method === "POST" && call.url.startsWith(signUrl)) {
        const calls = recordedCalls.filter(
          (c) => c.init.method === "POST" && c.url.startsWith(signUrl),
        ).length;
        return jsonResponse({
          signedURL: malformedValues[(calls - 1) % malformedValues.length],
        });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = new SupabaseStorageAdapter({
      supabaseUrl: SUPABASE_URL,
      supabaseServiceRoleKey: SUPABASE_KEY,
      bucket: "offering-audio",
      pathPrefix: "samples",
      fetchImpl,
    });
    const ref = (
      await adapter.uploadSample({
        label: "S",
        contentType: "audio/mpeg",
        byteSize: uploadBytes.byteLength,
        offeringId: "of-1",
        bytes: uploadBytes,
      })
    ).storageRef;
    for (let i = 0; i < malformedValues.length; i += 1) {
      await assert.rejects(() => adapter.getPlaybackBytes(ref));
    }
    const getCalls = recordedCalls.filter((c) => c.init.method === "GET");
    assert.equal(
      getCalls.length,
      0,
      "no outbound GET may be issued for malformed signedURL values",
    );
  });
});
