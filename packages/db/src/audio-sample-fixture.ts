// Deterministic MP3 audio-sample fixture.
//
// Background: ticket #65 (BG7) needs one canonical playable MP3 that
// the integrated browser journey can preview without requiring a
// managed Supabase Storage upload. The fixture lives in the seed
// layer (not as a committed binary) so the bytes are deterministic
// across machines and never drift from the trusted-boundary MP3
// validator at apps/api/src/services/audio-sample.service.ts:97.
//
// The bytes match the existing `mp3FrameBytes()` test helper at
// apps/api/src/routes/audio-samples.test.ts:191 — a real MPEG-1
// Layer III 128 kbps 44.1 kHz frame header + 413 bytes of
// deterministic body, total 417 bytes. The trusted-boundary
// validator accepts these bytes without modification.
//
// The function is intentionally single-purpose: it produces the ONE
// canonical BG7 fixture. It is NOT a generalized MP3 generator.
// Solves the single canonical sample only — no framework.

const FIXTURE_FRAME_SIZE = 417 as const;

/**
 * Build a deterministic 417-byte MPEG-1 Layer III frame that passes
 * the trusted-boundary MP3 validator. The frame is silent (zero
 * body) but its header is a genuine MPEG-1 Layer III frame so the
 * validator accepts it on every code path.
 *
 * The `label` parameter is preserved for future observability hooks
 * (logging, instrumentation) but does NOT alter the bytes — the
 * function is byte-deterministic across calls regardless of input.
 */
export function buildDeterministicMp3Fixture(label?: string): Uint8Array {
  // Same header bytes as the existing `mp3FrameBytes()` helper in
  // apps/api/src/routes/audio-samples.test.ts:191.
  const bytes = new Uint8Array(FIXTURE_FRAME_SIZE);
  bytes[0] = 0xff; // sync byte 1
  bytes[1] = 0xfb; // sync byte 2 (last 3 bits), MPEG-1, Layer III, no CRC
  bytes[2] = 0x90; // bitrate index 9 = 128 kbps, sample-rate 0 = 44.1 kHz, no padding
  bytes[3] = 0x00; // channel mode + emphasis (none)
  // Bytes 4..416 are zero — silent payload.
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
