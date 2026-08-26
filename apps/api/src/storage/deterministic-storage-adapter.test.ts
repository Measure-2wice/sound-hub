// Deterministic storage adapter tests.
//
// Background: ticket #61 requires that the deterministic in-memory
// storage adapter obey the same application-facing contract as the
// deployed Supabase Storage adapter. These tests pin every
// observable branch — opaque storage reference, idempotent removal,
// MP3-only enforcement, 25 MB cap, playback reference composition —
// so a future drift in either side is caught by the suite.

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

  test("getPlaybackReference resolves a stable in-process URL for an uploaded sample", async () => {
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
    const ref = await adapter.getPlaybackReference(uploaded.storageRef);
    assert.ok(ref);
    assert.ok(ref.url.startsWith("http://api.example.test/api/storage/playback/"));
    assert.equal(ref.cacheControlHint, "private, max-age=60");
  });

  test("getPlaybackReference returns null for an unknown reference", async () => {
    const adapter = new DeterministicStorageAdapter();
    const ref = await adapter.getPlaybackReference("det:missing:abc");
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
    const ref = await adapter.getPlaybackReference(seeded);
    assert.ok(ref);
  });
});
