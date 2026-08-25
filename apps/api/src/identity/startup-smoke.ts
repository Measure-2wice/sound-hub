// Bounded deployed-provider smoke.
//
// Background: BG1 requires that the managed authentication path
// "receive a bounded deployed-environment smoke" so the
// composition root can fail fast and fall back to the
// deterministic adapter when managed is unreachable. The
// composition root runs this smoke at startup (via buildApp), and
// the factory uses the result to decide between managed and
// deterministic modes.
//
// The smoke probes the three Supabase endpoints the managed
// adapter depends on:
//
//   1. /auth/v1/health — Supabase project is reachable.
//   2. /auth/v1/otp — magic-link request endpoint.
//   3. /auth/v1/verify — magic-link callback verification
//      endpoint.
//
// For step 3, the smoke passes a known-bad token. The endpoint is
// expected to respond with 4xx (`Invalid token`); the smoke
// treats that as proof the network path is reachable. The smoke
// is bounded by the adapter's smokeTimeoutMs so a hung network
// call cannot block startup indefinitely. The smoke returns
// { ok: false, reason, detail } on every failure mode so the
// factory can log the fallback decision and operators can act
// without spelunking the code.

import type { ManagedIdentityAdapter, SmokeResult } from "./managed-identity-adapter.js";
import {
  IdentityProviderUnavailableError,
  IdentityVerificationFailedError,
} from "./identity-adapter.js";

export interface StartupSmokeDeps {
  readonly managed: ManagedIdentityAdapter;
}

/**
 * Run the bounded end-to-end provider smoke. Returns the result
 * the factory consumes; failures are explicit so the factory can
 * log the fallback decision.
 */
export async function runStartupSmoke(deps: StartupSmokeDeps): Promise<SmokeResult> {
  const managed = deps.managed;
  if (!managed.isConfigured()) {
    return {
      ok: false,
      reason: "unconfigured",
      detail: "SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set",
    };
  }
  // Step 1: Supabase project health.
  const health = await managed.smoke();
  if (!health.ok) return health;
  // Step 2: magic-link request endpoint. Supabase emails the
  // request; the smoke does not need to receive the email. A
  // 2xx response proves the endpoint is reachable. A 4xx
  // response (e.g. rate limit) is acceptable for the smoke.
  try {
    const result = await managed.requestSignIn({
      email: "bg1-startup-smoke@soundhub.example",
    });
    // The opaque handle itself is unused — the smoke only proves
    // the endpoint is reachable.
    void result;
  } catch (err) {
    if (err instanceof IdentityProviderUnavailableError) {
      return {
        ok: false,
        reason: "network",
        detail: `requestSignIn probe failed: ${err.message}`,
      };
    }
    throw err;
  }
  // Step 3: callback verification endpoint. The smoke passes a
  // known-bad token and expects Supabase to respond with 4xx
  // (`Invalid token`). Any 5xx or network failure is treated as
  // a smoke failure; an IdentityVerificationFailedError (4xx)
  // proves the endpoint is reachable.
  try {
    const verified = await managed.verifySignIn({
      requestId: "bg1-startup-smoke-bad-token",
    });
    // Supabase accepted the bad token — that is a smoke failure
    // because the verify endpoint should not return a verified
    // identity for a bogus token.
    if (verified !== null) {
      return {
        ok: false,
        reason: "non-2xx",
        detail: "verifySignIn probe accepted a known-bad token",
      };
    }
  } catch (err) {
    if (err instanceof IdentityVerificationFailedError) {
      // Expected: Supabase rejected the bad token with 4xx.
      return { ok: true };
    }
    if (err instanceof IdentityProviderUnavailableError) {
      return {
        ok: false,
        reason: "network",
        detail: `verifySignIn probe failed: ${err.message}`,
      };
    }
    throw err;
  }
  return { ok: true };
}
