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
    assert.equal(result.storageRef.includes("offering-audio"), false);
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

  test("getPlaybackReference resolves a signed URL via the storage sign endpoint", async () => {
    const { fetchImpl } = makeFetchStub(() =>
      jsonResponse({ signedURL: "/object/sign/offering-audio/samples/x.mp3?token=abc" }),
    );
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
    const ref = await adapter.getPlaybackReference({
      storageRef: result.storageRef,
      offeringId: "of-1",
      sampleId: "smp-1",
    });
    assert.ok(ref);
    assert.equal(ref.url, `${SUPABASE_URL}/object/sign/offering-audio/samples/x.mp3?token=abc`);
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

  test("removeSample issues a DELETE that returns 404 idempotently", async () => {
    // Stub returns 200 for uploads (so the test can mint a ref)
    // and 404 for DELETEs (so the adapter treats it as already gone).
    const { fetchImpl, calls } = makeFetchStub((call) => {
      if (call.init.method === "DELETE") return new Response(null, { status: 404 });
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
    await adapter.removeSample(ref);
    // Final call is the DELETE for the just-uploaded ref.
    const last = calls[calls.length - 1];
    assert.ok(last);
    assert.equal(last.init.method, "DELETE");
  });

  test("the storage reference never embeds bucket or object path", async () => {
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
    // Per ticket #61 follow-up review: storageRef is opaque and
    // never reveals the bucket name or the object path. The adapter
    // resolves it back to bucket/path via its internal index.
    assert.equal(result.storageRef.includes("offering-audio"), false);
    assert.equal(result.storageRef.includes("/samples/"), false);
    assert.equal(result.storageRef.includes(".mp3"), false);
  });

  test("removal drops the storage reference from the internal index", async () => {
    // Stub returns 200 for uploads (so the test can mint a ref)
    // and 404 for sign/delete (so the adapter treats the object as
    // gone). After removal the adapter must not re-resolve the
    // storage reference — `getPlaybackReference` returns null.
    const { fetchImpl } = makeFetchStub((call) => {
      if (call.init.method === "DELETE") return new Response(null, { status: 200 });
      if (call.init.method === "POST") return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
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
    await adapter.removeSample(ref);
    const playback = await adapter.getPlaybackReference({
      storageRef: ref,
      offeringId: "of-1",
      sampleId: "smp-1",
    });
    assert.equal(playback, null);
  });
});
