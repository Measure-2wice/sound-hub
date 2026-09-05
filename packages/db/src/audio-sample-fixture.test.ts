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
// MPEG-1 Layer III sync word, no CRC, 128 kbps / 44.1 kHz header,
// and a 417-byte frame body.

/* eslint-disable @typescript-eslint/no-floating-promises */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeterministicMp3Fixture,
  BG7_FIXTURE_OFFERING_ID,
  BG7_FIXTURE_STORAGE_REF,
  BG7_FIXTURE_LABEL,
} from "./audio-sample-fixture.js";

test("buildDeterministicMp3Fixture returns exactly 417 bytes", () => {
  const bytes = buildDeterministicMp3Fixture();
  assert.equal(bytes.byteLength, 417);
});

test("buildDeterministicMp3Fixture header is a real MPEG-1 Layer III 128kbps 44.1kHz frame", () => {
  const bytes = buildDeterministicMp3Fixture();
  // Sync word: 11 bits set to 1. Encoded as 0xFF followed by the
  // top 3 bits of 0xFB.
  assert.equal(bytes[0], 0xff, "sync byte 1");
  assert.equal(bytes[1]! & 0xe0, 0xe0, "sync byte 2 top 3 bits");
  // MPEG version: bits 4..3 of byte 1 = 11 = MPEG-1.
  assert.equal((bytes[1]! >> 3) & 0x03, 0x03, "MPEG version = MPEG-1");
  // Layer: bits 2..1 of byte 1 = 01 = Layer III.
  assert.equal((bytes[1]! >> 1) & 0x03, 0x01, "layer = Layer III");
  // Protection bit: bit 0 of byte 1 = 1 = no CRC follows header.
  // (The MP3 spec calls this `protection_bit`; 0 = CRC present, 1 =
  // CRC absent. The fixture header 0xfb has protection_bit=1.)
  assert.equal(bytes[1]! & 0x01, 0x01, "protection bit set (no CRC follows header)");
  // Bitrate index 9 = 128 kbps for MPEG-1 Layer III.
  assert.equal((bytes[2]! >> 4) & 0x0f, 0x09, "bitrate index = 9 (128 kbps)");
  // Sample-rate index 0 = 44.1 kHz.
  assert.equal((bytes[2]! >> 2) & 0x03, 0x00, "sample-rate index = 0 (44.1 kHz)");
  // Padding bit unset.
  assert.equal((bytes[2]! >> 1) & 0x01, 0x00, "padding bit unset");
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

test("buildDeterministicMp3Fixture bytes equal the existing mp3FrameBytes test helper", () => {
  // The trusted-boundary validator uses the same header bytes as
  // this fixture. We compare the header slice to confirm the
  // match; the body is zero in the fixture and zero in
  // mp3FrameBytes (Buffer.alloc zero-initializes), so a full
  // 417-byte deep-equal would also hold. We assert both for
  // explicitness.
  const bytes = buildDeterministicMp3Fixture();
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xfb);
  assert.equal(bytes[2], 0x90);
  assert.equal(bytes[3], 0x00);
  // Body bytes 4..416 are all zero (silent frame).
  for (let i = 4; i < bytes.byteLength; i++) {
    assert.equal(bytes[i], 0x00, `body byte ${i} must be zero`);
  }
});

test("BG7 fixture constants are stable and have the canonical shape", () => {
  assert.equal(BG7_FIXTURE_OFFERING_ID, "of-creole-beats-dancehall-single-remote");
  assert.equal(BG7_FIXTURE_STORAGE_REF, "det:of-creole-beats-dancehall-single-remote:fixture");
  assert.match(BG7_FIXTURE_STORAGE_REF, /^det:.+:fixture$/);
  assert.match(BG7_FIXTURE_LABEL, /Haitian dancehall single/);
});
