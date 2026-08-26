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
    const bytes = adapter.getBytesForPlayback(uploaded.storageRef);
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
    assert.equal(adapter.getBytesForPlayback(uploaded.storageRef), null);
  });
});
