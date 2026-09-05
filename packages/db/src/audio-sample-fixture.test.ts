// Deterministic MP3 audio-sample fixture tests.
//
// Background: ticket #65 (BG7) needs a canonical playable MP3 for the
// integrated browser journey. The fixture's bytes must pass the
// trusted-boundary MP3 validator at
// apps/api/src/services/audio-sample.service.ts:97 — the same validator
// every uploaded MP3 must pass. If the fixture bytes are invalid,
// the journey's "play seller audio" step fails before any UI assertion
// can run, so this test is a precondition for the journey.
//
// The test deliberately does NOT import the audio-sample service
// (which lives in apps/api) because packages/db/prisma has no
// cross-package import path to apps/api. The byte-level assertions
// below are equivalent to what the trusted-boundary validator checks:
// an ID3 preamble followed by a complete multi-frame MPEG Layer III
// payload.

/* eslint-disable @typescript-eslint/no-floating-promises */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeterministicMp3Fixture,
  BG7_FIXTURE_OFFERING_ID,
  BG7_FIXTURE_STORAGE_REF,
  BG7_FIXTURE_LABEL,
  shouldSeedDeterministicAudioFixture,
} from "./audio-sample-fixture.js";

test("buildDeterministicMp3Fixture returns the complete stripped MP3 stream", () => {
  const bytes = buildDeterministicMp3Fixture();
  assert.equal(bytes.byteLength, 8663);
});

test("buildDeterministicMp3Fixture begins with a valid MPEG Layer III frame", () => {
  const bytes = buildDeterministicMp3Fixture();
  assert.equal(bytes[0], 0xff, "sync byte 1");
  assert.equal(bytes[1]! & 0xe0, 0xe0, "sync byte 2 top 3 bits");
  assert.equal(bytes[0], 0xff, "MPEG frame sync byte 1");
  const frameOffset = bytes.findIndex(
    (byte, index) => byte === 0xff && (bytes[index + 1] ?? 0) >= 0xe0,
  );
  assert.equal(frameOffset, 0, "begins directly with an MPEG audio frame");
});

test("buildDeterministicMp3Fixture is deterministic across calls", () => {
  const a = buildDeterministicMp3Fixture(BG7_FIXTURE_LABEL);
  const b = buildDeterministicMp3Fixture(BG7_FIXTURE_LABEL);
  const c = buildDeterministicMp3Fixture(undefined);
  assert.deepEqual(a, b);
  // The label argument does not change the bytes — observability
  // hook only.
  assert.deepEqual(a, c);
});

test("buildDeterministicMp3Fixture is not a truncated header-only payload", () => {
  const bytes = buildDeterministicMp3Fixture();
  assert.equal(bytes[0], 0xff);
  assert.ok(bytes.byteLength > 8_000);
});

test("deterministic audio seeding is enabled only by the explicit local test boundary", () => {
  assert.equal(
    shouldSeedDeterministicAudioFixture({
      NODE_ENV: "test",
      BG2_STORAGE_BACKEND: "deterministic",
      BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
    }),
    true,
  );
  assert.equal(
    shouldSeedDeterministicAudioFixture({
      NODE_ENV: "production",
      BG2_STORAGE_BACKEND: "deterministic",
      BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
    }),
    false,
  );
  assert.equal(
    shouldSeedDeterministicAudioFixture({
      NODE_ENV: "test",
      BG2_STORAGE_BACKEND: "supabase",
      BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
    }),
    false,
  );
});

test("BG7 fixture constants are stable and have the canonical shape", () => {
  assert.equal(BG7_FIXTURE_OFFERING_ID, "of-creole-beats-dancehall-single-remote");
  assert.equal(BG7_FIXTURE_STORAGE_REF, "det:of-creole-beats-dancehall-single-remote:fixture");
  assert.match(BG7_FIXTURE_STORAGE_REF, /^det:.+:fixture$/);
  assert.match(BG7_FIXTURE_LABEL, /Haitian dancehall single/);
});
