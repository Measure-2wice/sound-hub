// Bounded deployed-provider smoke.
//
// Background: BG1 requires that the managed authentication path
// "receive a bounded deployed-environment smoke" so the
// composition root can fail fast and fall back to the
// deterministic adapter when managed is unreachable. Per ticket
// #59 P1-001 the smoke MUST run on the same adapter instance the
// serving application uses — the factory now owns the smoke so a
// separate ManagedIdentityAdapter can never drift out of sync
// with the production selection.
//
// The smoke probes the three Supabase endpoints the managed
// adapter depends on:
//
//   1. /auth/v1/health — Supabase project is reachable.
//   2. /auth/v1/otp — magic-link request endpoint (with the
//      official `redirect_to` query parameter and current
//      request body shape).
//   3. /auth/v1/verify — magic-link callback verification
//      endpoint, exercised with an operator-injected captured
//      token (`BG1_SMOKE_TEST_TOKEN`) so the smoke proves the
//      real callback contract end-to-end. Without the operator
//      token the smoke reports a partial ok (request path only)
//      so the operator knows to inject a token before declaring
//      the deployed environment healthy.
//
// The smoke is bounded by the adapter's smokeTimeoutMs so a hung
// network call cannot block startup indefinitely. The smoke
// returns { ok: false, reason, detail } on every failure mode so
// the factory can log the fallback decision and operators can act
// without spelunking the code.

import type { ManagedIdentityAdapter, SmokeResult } from "./managed-identity-adapter.js";
import {
  IdentityProviderUnavailableError,
  IdentityVerificationFailedError,
} from "./identity-adapter.js";

export interface StartupSmokeDeps {
  readonly managed: ManagedIdentityAdapter;
  /**
   * Operator-injected captured magic-link token. When supplied,
   * the smoke drives the full `verifySignIn` path against the
   * configured Supabase project so the deployed callback
   * contract is proven end-to-end. When absent, the smoke only
   * exercises the request path and reports `ok: true` with a
   * `detail` line so the operator knows to inject a token
   * before declaring the deployed environment healthy.
   *
   * The smoke NEVER synthesises a successful identity on its
   * own — a missing token does not produce a `verified !== null`
   * result; the smoke uses the operator token exactly as the
   * managed callback would.
   */
  readonly verifyToken?: string;
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
  // 2xx response proves the endpoint is reachable AND that the
  // request body / `redirect_to` query parameter contract is
  // honoured (Supabase 422s when the body carries an
  // `options.emailRedirectTo` field per the prior iteration's
  // misuse). A 4xx response (e.g. rate limit) is acceptable for
  // the smoke because it still proves the endpoint round-trips.
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
  // Step 3: callback verification endpoint.
  if (deps.verifyToken === undefined || deps.verifyToken.trim() === "") {
    // No operator-injected token. We deliberately do NOT probe
    // with a known-bad token here: per ticket #59 P1-001 a
    // bad-token 4xx proves the endpoint is reachable but not
    // that the full callback/session integration works. The
    // operator MUST inject a captured token before declaring
    // the deployed managed path healthy.
    return {
      ok: true,
      detail:
        "request path exercised; no BG1_SMOKE_TEST_TOKEN supplied, verify-path coverage is partial",
    };
  }
  try {
    const verified = await managed.verifySignIn({ requestId: deps.verifyToken });
    if (verified === null) {
      // A captured token that Supabase rejects is a smoke
      // failure — the operator pasted a stale token and the
      // deployed callback contract cannot be proven.
      return {
        ok: false,
        reason: "non-2xx",
        detail: "verifySignIn probe returned null for the operator-injected captured token",
      };
    }
    return {
      ok: true,
      detail: `request + verify exercised against Supabase; resolved subject=${verified.subject}`,
    };
  } catch (err) {
    if (err instanceof IdentityVerificationFailedError) {
      return {
        ok: false,
        reason: "non-2xx",
        detail: `verifySignIn probe rejected the captured token: ${err.message}`,
      };
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
}
