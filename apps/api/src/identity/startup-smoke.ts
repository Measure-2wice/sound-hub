// Bounded deployed-provider configuration smoke.
//
// Background: BG1 requires that the managed authentication path
// "receive a bounded deployed-environment smoke" so the
// composition root can fail fast and fall back to the
// deterministic adapter when managed is unreachable. The smoke
// is a non-destructive, non-OTP configuration probe: it
// validates managed-auth configuration and constructs the
// managed adapter. It does NOT request, consume, or revoke a
// live Supabase OTP. End-to-end managed email verification is
// validated by an explicit bounded operational smoke procedure
// (see `docs/deployment/managed-provider-smoke.md`), not by an
// application-startup health check.
//
// Per ticket #59 GS 2 the smoke is FAIL-CLOSED — a managed
// path that fails the bounded configuration probe is replaced
// by the approved deployed deterministic fallback at
// composition time, never at request time.
//
// The smoke probes:
//
//   1. /auth/v1/health — the configured Supabase project is
//      reachable on its Auth endpoint.
//
// The smoke is bounded by the adapter's smokeTimeoutMs so a hung
// network call cannot block startup indefinitely. The smoke
// returns { ok: false, reason, detail } on every failure mode so
// the factory can log the fallback decision and operators can act
// without spelunking the code.

import type { ManagedIdentityAdapter, SmokeResult } from "./managed-identity-adapter.js";

/**
 * Run the bounded deployed-provider configuration smoke. Returns
 * the result the factory consumes; failures are explicit so the
 * factory can log the fallback decision.
 *
 * Per ticket #59 GS 2 the smoke is FAIL-CLOSED: `ok: true` is
 * only returned when the configured managed provider responds
 * 2xx on its `/auth/v1/health` endpoint within the bounded
 * timeout. Any non-2xx response, network failure, or timeout
 * causes the factory to select the deterministic adapter as
 * the approved deployed fallback.
 *
 * The smoke does NOT request a Supabase OTP, does NOT consume
 * a verification token, and does NOT revoke a SoundHub
 * session. End-to-end managed email verification is validated
 * by the bounded operational smoke procedure documented at
 * `docs/deployment/managed-provider-smoke.md`, not by
 * application startup.
 */
export async function runStartupSmoke(deps: {
  readonly managed: ManagedIdentityAdapter;
}): Promise<SmokeResult> {
  return deps.managed.smoke();
}
