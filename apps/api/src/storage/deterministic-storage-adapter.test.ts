// Deterministic storage adapter tests.
//
// Background: ticket #61 requires that the deterministic in-memory
// storage adapter obey the same application-facing contract as the
// deployed Supabase Storage adapter. These tests pin every
// observable branch — opaque storage reference, idempotent removal,
// MP3-only enforcement, 25 MB cap, playback URL composition —
// so a future drift in either side is caught by the suite.
//
// Per ticket #61 follow-up review (P0-001) the deterministic adapter
// MUST keep stored bytes available past the playback URL TTL
// window: a sample lives until `removeSample` is called or the
// process restarts. Tests pin that behavior.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeterministicStorageAdapter } from "./deterministic-storage-adapter.js";
import { StorageRejectedError, StorageUnavailableError } from "./storage-adapter.js";
import { BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE } from "@soundhub/types";
import {
  BG7_FIXTURE_STORAGE_REF,
  BG7_FIXTURE_OFFERING_ID,
  buildDeterministicMp3Fixture,
} from "@soundhub/db";

describe("DeterministicStorageAdapter", () => {
  test("uploadSample returns an opaque storage reference", async () => {
    const adapter = new DeterministicStorageAdapter();
    const result = await adapter.uploadSample({
      label: "S",
      contentType: "audio/mpeg",
      byteSize: 16,
      offeringId: "of-1",
      bytes: new Uint8Array(16),
    });
    assert.ok(result.storageRef.startsWith("det:"));
    assert.ok(result.storageRef.length > 4);
    // The storage ref is opaque to the application; the adapter
    // never reveals bucket/path/provider internals through it.
    assert.equal(result.storageRef.includes("/"), false);
    assert.equal(result.storageRef.includes(" "), false);
  });

  test("uploadSample rejects a non-MP3 content type", async () => {
    const adapter = new DeterministicStorageAdapter();
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

  test("uploadSample rejects an oversize byte count", async () => {
    const adapter = new DeterministicStorageAdapter();
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

  test("uploadSample rejects when declared and observed byte sizes disagree", async () => {
    const adapter = new DeterministicStorageAdapter();
    await assert.rejects(
      () =>
        adapter.uploadSample({
          label: "S",
          contentType: "audio/mpeg",
          byteSize: 32,
          offeringId: "of-1",
          bytes: new Uint8Array(16),
        }),
      (err: unknown) => err instanceof StorageRejectedError,
    );
  });

  test("getPlaybackReference composes the in-app buyer-safe playback route", async () => {
    const adapter = new DeterministicStorageAdapter({
      playbackBaseUrl: "http://api.example.test",
    });
    const uploaded = await adapter.uploadSample({
      label: "S",
      contentType: "audio/mpeg",
      byteSize: 8,
      offeringId: "of-1",
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    const ref = await adapter.getPlaybackReference({
      storageRef: uploaded.storageRef,
      offeringId: "of-1",
      sampleId: "smp-1",
    });
    assert.ok(ref);
    assert.equal(ref.url, "http://api.example.test/api/services/of-1/audio-samples/smp-1/play");
    assert.equal(ref.cacheControlHint, "private, max-age=60");
  });

  test("getPlaybackReference returns null for an unknown reference", async () => {
    const adapter = new DeterministicStorageAdapter();
    const ref = await adapter.getPlaybackReference({
      storageRef: "det:missing:abc",
      offeringId: "of-1",
      sampleId: "smp-1",
    });
    assert.equal(ref, null);
  });

  test("removeSample is idempotent for an unknown reference", async () => {
    const adapter = new DeterministicStorageAdapter();
    await adapter.removeSample("det:unknown:abc");
    // Second call must not throw.
    await adapter.removeSample("det:unknown:abc");
  });

  test("removeSample refuses refs the adapter did not mint", async () => {
    const adapter = new DeterministicStorageAdapter();
    await assert.rejects(
      () => adapter.removeSample("supa:bucket:path"),
      (err: unknown) => err instanceof StorageUnavailableError,
    );
  });

  test("seedSample produces a sample the upload path also accepts", async () => {
    const adapter = new DeterministicStorageAdapter();
    const seeded = adapter.seedSample({
      bytes: new Uint8Array([0x49, 0x44, 0x33]),
      offeringId: "of-1",
    });
    const ref = await adapter.getPlaybackReference({
      storageRef: seeded,
      offeringId: "of-1",
      sampleId: "smp-1",
    });
    assert.ok(ref);
  });

  test("stored bytes remain available past any future playback URL TTL", async () => {
    // Per ticket #61 P0-001 follow-up: a sample lives until
    // removeSample, not until a playback URL TTL expires. This test
    // pins that contract by simulating a clock that advances well
    // beyond the previous 5-minute window.
    let nowMs = 1_700_000_000_000;
    const adapter = new DeterministicStorageAdapter({
      now: () => nowMs,
    });
    const uploaded = await adapter.uploadSample({
      label: "Persistent",
      contentType: "audio/mpeg",
      byteSize: 4,
      offeringId: "of-1",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    // Advance the clock 30 minutes (10x the previous playback TTL).
    nowMs += 30 * 60 * 1000;
    const playbackRef = await adapter.getPlaybackReference({
      storageRef: uploaded.storageRef,
      offeringId: "of-1",
      sampleId: "smp-1",
    });
    assert.ok(playbackRef, "playback reference survives the previous TTL window");
    const bytes = await adapter.getPlaybackBytes(uploaded.storageRef);
    assert.ok(bytes);
    assert.equal(bytes.length, 4);
  });

  test("removeSample ends playback immediately (no TTL grace)", async () => {
    const adapter = new DeterministicStorageAdapter();
    const uploaded = await adapter.uploadSample({
      label: "S",
      contentType: "audio/mpeg",
      byteSize: 4,
      offeringId: "of-1",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    await adapter.removeSample(uploaded.storageRef);
    const ref = await adapter.getPlaybackReference({
      storageRef: uploaded.storageRef,
      offeringId: "of-1",
      sampleId: "smp-1",
    });
    assert.equal(ref, null);
    await assert.rejects(
      () => adapter.getPlaybackBytes(uploaded.storageRef),
      (err: unknown) => err instanceof Error && err.name === "StorageReferenceUnknownError",
    );
  });

  // ----------------------------------------------------------------
  // BG7 canonical-fixture lazy hydration (ticket #65).
  //
  // The seed persists a single canonical ServiceOfferingAudioSample
  // row with `storageRef = BG7_FIXTURE_STORAGE_REF`. The adapter's
  // cold-start `objects` Map does not contain that ref. On the first
  // `getPlaybackBytes` call the adapter must lazily re-mint the
  // fixture bytes via `buildDeterministicMp3Fixture`, cache them,
  // and return them. The Supabase adapter is unaffected.
  // ----------------------------------------------------------------

  test("BG7 fixture: getPlaybackBytes lazily re-mints canonical fixture bytes", async () => {
    const adapter = new DeterministicStorageAdapter();
    const bytes = await adapter.getPlaybackBytes(BG7_FIXTURE_STORAGE_REF);
    assert.ok(bytes);
    // The fixture is the SAME 417-byte MPEG-1 Layer III frame the
    // existing mp3FrameBytes() test helper emits. The exact bytes
    // returned by buildDeterministicMp3Fixture are the canonical
    // answer; we assert byte equality here so a future drift is
    // caught.
    const canonical = buildDeterministicMp3Fixture();
    assert.deepEqual(bytes, canonical);
  });

  test("BG7 fixture: second getPlaybackBytes call returns identical bytes (cache hit)", async () => {
    const adapter = new DeterministicStorageAdapter();
    const first = await adapter.getPlaybackBytes(BG7_FIXTURE_STORAGE_REF);
    const second = await adapter.getPlaybackBytes(BG7_FIXTURE_STORAGE_REF);
    assert.deepEqual(first, second);
  });

  test("BG7 fixture: getPlaybackReference composes the canonical in-app playback URL", async () => {
    const adapter = new DeterministicStorageAdapter();
    const ref = await adapter.getPlaybackReference({
      storageRef: BG7_FIXTURE_STORAGE_REF,
      offeringId: BG7_FIXTURE_OFFERING_ID,
      sampleId: "smp-bg7-fixture",
    });
    assert.ok(ref);
    if (!ref) throw new Error("playback reference must be present");
    // The URL pattern matches the in-app playback route the browser
    // fetches for `<audio src>`. The seed's `storageRef` is preserved
    // verbatim; only the URL is is composed from the offeringId + sampleId.
    assert.match(
      ref.url,
      /\/api\/services\/of-creole-beats-dancehall-single-remote\/audio-samples\/smp-bg7-fixture\/play$/,
    );
  });

  test("BG7 fixture: removeSample followed by getPlaybackBytes returns unknown-ref error", async () => {
    const adapter = new DeterministicStorageAdapter();
    // Warm the cache.
    await adapter.getPlaybackBytes(BG7_FIXTURE_STORAGE_REF);
    await adapter.removeSample(BG7_FIXTURE_STORAGE_REF);
    await assert.rejects(
      () => adapter.getPlaybackBytes(BG7_FIXTURE_STORAGE_REF),
      (err: unknown) => err instanceof Error && err.name === "StorageReferenceUnknownError",
    );
  });

  test("BG7 fixture: non-canonical det: refs still return unknown-ref on cold start", async () => {
    // The hydration guard is single-purpose: ONLY the canonical
    // BG7_FIXTURE_STORAGE_REF triggers re-mint. Any other `det:`
    // reference that was never cached is rejected — production
    // behavior is preserved.
    const adapter = new DeterministicStorageAdapter();
    await assert.rejects(
      () => adapter.getPlaybackBytes(`det:${BG7_FIXTURE_OFFERING_ID}:some-uploaded-id`),
      (err: unknown) => err instanceof Error && err.name === "StorageReferenceUnknownError",
    );
  });

  test("BG7 fixture: uploadSample path is unaffected by the hydration guard", async () => {
    const adapter = new DeterministicStorageAdapter();
    const result = await adapter.uploadSample({
      label: "Live upload",
      contentType: "audio/mpeg",
      byteSize: 16,
      offeringId: BG7_FIXTURE_OFFERING_ID,
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    });
    // Uploaded refs are NOT the canonical fixture ref and must NOT
    // be re-minted — the in-memory Map holds the uploaded bytes.
    const bytes = await adapter.getPlaybackBytes(result.storageRef);
    assert.equal(bytes.length, 16);
    assert.equal(bytes[0], 1);
  });
});
