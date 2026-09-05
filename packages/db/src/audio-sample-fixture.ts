// Deterministic MP3 audio-sample fixture.
//
// Background: ticket #65 (BG7) needs one canonical playable MP3 that
// the integrated browser journey can preview without requiring a
// managed Supabase Storage upload. The fixture lives in the seed
// layer (not as a committed binary) so the bytes are deterministic
// across machines and never drift from the trusted-boundary MP3
// validator at apps/api/src/services/audio-sample.service.ts:97.
//
// The bytes are a deterministic short silent MPEG Layer III stream.
// They contain complete encoded frames, with no ID3 or artwork
// metadata, so an MP3-capable browser can establish a usable state.
//
// The function is intentionally single-purpose: it produces the ONE
// canonical BG7 fixture. It is NOT a generalized MP3 generator.
// Solves the single canonical sample only — no framework.
//
// Insertion boundary: ticket #65 P1 (Codex review) requires the
// fixture insertion to require all four of:
//   1. NODE_ENV === "test"
//   2. deterministic storage backend
//   3. explicit BG7_DETERMINISTIC_AUDIO_FIXTURE=1
//   4. the actual DATABASE_URL is the approved disposable/local
//      PostgreSQL test target.
// Caller-controlled env flags alone are not sufficient — the
// fail-closed database-target guard lives in
// `approved-disposable-test-db.ts` and is invoked through
// `shouldSeedDeterministicAudioFixtureForDatabase` below.

const FIXTURE_BASE64 =
  "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";

export function shouldSeedDeterministicAudioFixture(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    env.NODE_ENV === "test" &&
    env.BG2_STORAGE_BACKEND === "deterministic" &&
    env.BG7_DETERMINISTIC_AUDIO_FIXTURE === "1"
  );
}

/**
 * Combined predicate that mirrors the BG7 insertion-boundary
 * contract from ticket #65 P1 (Codex review). Returns the caller-
 * controlled flag result AND the database-target verification. The
 * insertion call site MUST refuse to mutate any row unless this
 * predicate returns `approved: true`. The helper re-exports the
 * database-target guard from `./approved-disposable-test-db.ts` so
 * the rule lives in exactly one place.
 *
 * The predicate is a fail-closed boundary: an unparseable URL, an
 * unknown host/port/database, or a missing DATABASE_URL all return
 * `{ approved: false, reason }`. The `reason` field carries a
 * bounded diagnostic (host, port, database name) so callers can log
 * without leaking credentials.
 */
export type DeterministicAudioFixtureInsertionDecision =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: string };

export function shouldSeedDeterministicAudioFixtureForDatabase(
  env: Readonly<Record<string, string | undefined>>,
): DeterministicAudioFixtureInsertionDecision {
  if (!shouldSeedDeterministicAudioFixture(env)) {
    return {
      approved: false,
      reason: "deterministic audio fixture flags are not enabled",
    };
  }
  const url = env.DATABASE_URL;
  return checkApprovedDisposableTestDatabase(url);
}

// Re-export the fail-closed database-target guard so callers can
// reach it from the canonical fixture module. This keeps
// `seed.ts` and any future insertion call site importing from one
// path while preserving the single source of truth in
// `approved-disposable-test-db.ts`.
export {
  APPROVED_DISPOSABLE_TEST_DB,
  ApprovedDisposableTestDbError,
  checkApprovedDisposableTestDatabase,
  isApprovedDisposableTestDatabase,
} from "./approved-disposable-test-db.js";
import { checkApprovedDisposableTestDatabase } from "./approved-disposable-test-db.js";

/**
 * Build the short deterministic MP3 used by the browser proof.
 *
 * The `label` parameter is preserved for future observability hooks
 * (logging, instrumentation) but does NOT alter the bytes — the
 * function is byte-deterministic across calls regardless of input.
 */
export function buildDeterministicMp3Fixture(label?: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(FIXTURE_BASE64, "base64"));
  // Touch the label to avoid unused-arg lint; observability hooks can
  // be added here without changing the byte output.
  if (label !== undefined) {
    // no-op; intentionally observable in trace logs only
    void label;
  }
  return bytes;
}

/**
 * The canonical storage reference for the BG7 audio fixture. This
 * stable, non-cuid reference lets the deterministic storage adapter
 * recognize the fixture and lazily re-mint bytes on first playback
 * (see apps/api/src/storage/deterministic-storage-adapter.ts).
 *
 * Shape: `det:<offeringId>:fixture` so the adapter's existing
 * `det:` prefix guard already classifies it. The `:fixture`
 * suffix distinguishes this row from any uploaded sample and keeps
 * the recognition logic single-purpose.
 */
export const BG7_FIXTURE_STORAGE_REF = "det:of-creole-beats-dancehall-single-remote:fixture";

/**
 * The canonical offering id that owns the BG7 audio fixture.
 * Matches the M1 demo buyer's first recommendation.
 */
export const BG7_FIXTURE_OFFERING_ID = "of-creole-beats-dancehall-single-remote";

/**
 * The canonical display label for the BG7 audio fixture. Surfaced
 * in the seed log and (optionally) in the player UI for clarity.
 */
export const BG7_FIXTURE_LABEL = "Creole Beats — Haitian dancehall single preview";
