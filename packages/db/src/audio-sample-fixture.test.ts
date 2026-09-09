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
  shouldSeedDeterministicAudioFixtureForDatabase,
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
  const a = buildDeterministicMp3Fixture();
  const b = buildDeterministicMp3Fixture();
  assert.deepEqual(a, b);
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

// Ticket #65 P1 (Codex review): the combined insertion-boundary
// predicate must require all four conditions:
//   1. NODE_ENV=test
//   2. deterministic storage backend
//   3. explicit BG7_DETERMINISTIC_AUDIO_FIXTURE=1
//   4. DATABASE_URL points at the approved disposable/local
//      PostgreSQL test target.
// Environment flags alone are not sufficient: caller-controlled
// flags combined with a managed DATABASE_URL must be refused.
test("shouldSeedDeterministicAudioFixtureForDatabase approves only when flags AND approved DATABASE_URL are set (ticket #65 P1)", () => {
  const approvedUrl = "postgresql://soundhub:password@localhost:5433/soundhub_m1_test";
  const managedSupabaseUrl =
    "postgresql://soundhub:password@db.supabase.example:6543/postgres?sslmode=require";
  const managedWrongPortUrl = "postgresql://soundhub:password@localhost:5432/soundhub_m1_test";
  const managedWrongDatabaseUrl = "postgresql://soundhub:password@localhost:5433/soundhub_prod";

  // Positive case: all four conditions met.
  assert.deepEqual(
    shouldSeedDeterministicAudioFixtureForDatabase({
      NODE_ENV: "test",
      BG2_STORAGE_BACKEND: "deterministic",
      BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
      DATABASE_URL: approvedUrl,
    }),
    { approved: true },
  );

  // Flags are off — the combined predicate must refuse without
  // even checking the database target.
  const flagsOff = shouldSeedDeterministicAudioFixtureForDatabase({
    NODE_ENV: "test",
    BG2_STORAGE_BACKEND: "supabase",
    BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
    DATABASE_URL: approvedUrl,
  });
  assert.equal(flagsOff.approved, false);
  if (flagsOff.approved) throw new Error("unreachable");
  assert.match(flagsOff.reason, /flags are not enabled/);

  // All flags on, but DATABASE_URL points at a managed host.
  const managedHost = shouldSeedDeterministicAudioFixtureForDatabase({
    NODE_ENV: "test",
    BG2_STORAGE_BACKEND: "deterministic",
    BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
    DATABASE_URL: managedSupabaseUrl,
  });
  assert.equal(managedHost.approved, false);
  if (managedHost.approved) throw new Error("unreachable");
  assert.match(managedHost.reason, /not an approved local host/);

  // All flags on, but DATABASE_URL uses a non-approved port.
  const wrongPort = shouldSeedDeterministicAudioFixtureForDatabase({
    NODE_ENV: "test",
    BG2_STORAGE_BACKEND: "deterministic",
    BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
    DATABASE_URL: managedWrongPortUrl,
  });
  assert.equal(wrongPort.approved, false);
  if (wrongPort.approved) throw new Error("unreachable");
  assert.match(wrongPort.reason, /port 5432 must be 5433/);

  // All flags on, but DATABASE_URL uses a non-approved database
  // name (e.g. a production database).
  const wrongDatabase = shouldSeedDeterministicAudioFixtureForDatabase({
    NODE_ENV: "test",
    BG2_STORAGE_BACKEND: "deterministic",
    BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
    DATABASE_URL: managedWrongDatabaseUrl,
  });
  assert.equal(wrongDatabase.approved, false);
  if (wrongDatabase.approved) throw new Error("unreachable");
  assert.match(wrongDatabase.reason, /database soundhub_prod must be soundhub_m1_test/);

  // All flags on, but DATABASE_URL is missing entirely.
  const missingUrl = shouldSeedDeterministicAudioFixtureForDatabase({
    NODE_ENV: "test",
    BG2_STORAGE_BACKEND: "deterministic",
    BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
  });
  assert.equal(missingUrl.approved, false);
  if (missingUrl.approved) throw new Error("unreachable");
  assert.match(missingUrl.reason, /DATABASE_URL is not set/);

  // All flags on, but DATABASE_URL is not a postgres URL.
  const notPostgres = shouldSeedDeterministicAudioFixtureForDatabase({
    NODE_ENV: "test",
    BG2_STORAGE_BACKEND: "deterministic",
    BG7_DETERMINISTIC_AUDIO_FIXTURE: "1",
    DATABASE_URL: "mysql://soundhub:password@db.example.com:3306/soundhub",
  });
  assert.equal(notPostgres.approved, false);
  if (notPostgres.approved) throw new Error("unreachable");
  assert.match(notPostgres.reason, /not a postgres URL: mysql:/);
});
