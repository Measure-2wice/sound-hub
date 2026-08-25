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
// Per ticket #59 P1-001 the smoke fails closed. A successful
// magic-link request alone does NOT return `ok: true`. The
// Golden Slice is only declared ready after the configured
// callback verification path AND the SoundHub server-side
// session integration are exercised successfully. The smoke
// result may report intermediate / partial provider reachability
// for diagnostic purposes, but `ok: true` is reserved for the
// case where the operator-injected captured token resolves
// through the application boundary into a SoundHub session that
// can be looked back up. If a full managed smoke cannot be
// completed, the smoke reports not-ready so the approved
// deterministic fallback logic can make an explicit decision
// rather than silently treating partial auth as healthy.
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
//      real callback contract end-to-end.
//
// When the operator supplies a captured token AND an
// `AuthenticationService` seam, the smoke also drives the
// SoundHub server-side session issuance step: the verified
// provider identity is resolved through the application
// boundary into a persisted UserAccount and a session, then
// the session is resolved back to confirm the round-trip. This
// step is what makes the managed path Golden-Slice-ready — a
// successful magic-link request alone is not enough.
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
import type { AuthenticationService } from "../services/authentication.service.js";

/**
 * Optional seam for the SoundHub server-side session round-trip.
 * Implementations drive the full `AuthenticationService.verifySignIn`
 * boundary against a captured verification token and report whether
 * a SoundHub session was issued and resolved back successfully.
 *
 * The seam is injected so the smoke does not need a direct
 * dependency on the auth repository; the composition root wires an
 * implementation that uses the real Prisma repository in
 * production and an in-memory fake in tests.
 */
export type SessionProbe = (input: { readonly verificationToken: string }) => Promise<{
  readonly ok: boolean;
  readonly userAccountId?: string;
  readonly sessionId?: string;
  readonly detail?: string;
}>;

export interface StartupSmokeDeps {
  readonly managed: ManagedIdentityAdapter;
  /**
   * Operator-injected captured magic-link verification token
   * (per ticket #59 P2-001). When supplied, the smoke drives the
   * full `verifySignIn` path against the configured Supabase
   * project. When absent, the smoke reports the request path is
   * reachable but the managed path is NOT ready for Golden Slice
   * selection (`ok: false`, reason
   * `session-coverage-incomplete`); the factory then selects the
   * deterministic adapter as the approved fallback.
   */
  readonly verifyToken?: string;
  /**
   * Optional SoundHub server-side session probe. When supplied
   * alongside `verifyToken`, the smoke also exercises the full
   * `AuthenticationService.verifySignIn` boundary — proving the
   * verified provider identity resolves to a persisted
   * UserAccount and a SoundHub session — before reporting
   * `ok: true`. When absent, the smoke still proves the
   * provider-side verify contract but reports the session
   * integration as unproven, so the factory selects the
   * deterministic fallback.
   */
  readonly sessionProbe?: SessionProbe;
}

/**
 * Build the default `SessionProbe` against a real
 * `AuthenticationService`. The probe drives the service's
 * `verifySignIn` with the captured token, then `resolveSession`
 * with the resulting session id. Both steps must succeed for the
 * smoke to report `ok: true`.
 */
export function buildSessionProbe(authService: AuthenticationService): SessionProbe {
  return async ({ verificationToken }) => {
    try {
      const verified = await authService.verifySignIn({ verificationToken });
      const resolved = await authService.resolveSession(verified.session.sessionId);
      if (!resolved) {
        return {
          ok: false,
          detail: "resolveSession returned null for the freshly issued session",
        };
      }
      return {
        ok: true,
        userAccountId: verified.publicUser.userAccountId,
        sessionId: verified.session.sessionId,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/**
 * Run the bounded end-to-end provider smoke. Returns the result
 * the factory consumes; failures are explicit so the factory can
 * log the fallback decision.
 *
 * Per ticket #59 P1-001 the smoke is FAIL-CLOSED. `ok: true` is
 * only returned after EVERY step succeeds:
 *   - provider health endpoint is reachable;
 *   - OTP request endpoint is reachable;
 *   - OTP-style Supabase callback verification succeeds for an
 *     operator-supplied captured token;
 *   - the SoundHub server-side session seam maps the verified
 *     provider identity to a persisted UserAccount and issues a
 *     SoundHub session that resolves back successfully.
 *
 * Any missing step returns `ok: false` with an explicit reason
 * so the factory can log the deterministic fallback decision.
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
  if (
    deps.verifyToken === undefined ||
    typeof deps.verifyToken !== "string" ||
    deps.verifyToken.trim() === ""
  ) {
    // No operator-injected token. Per ticket #59 P1-001 a missing
    // token does NOT return `ok: true`. The smoke has proven the
    // request path is reachable but the callback/session
    // integration is unproven; the operator MUST inject a
    // captured token before declaring the deployed managed path
    // Golden-Slice-ready. The factory then selects the
    // deterministic fallback.
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail:
        "request path exercised but no BG1_SMOKE_TEST_TOKEN supplied; managed path is not Golden-Slice-ready",
    };
  }
  let verifiedSubject: string;
  try {
    const verified = await managed.verifySignIn({ verificationToken: deps.verifyToken });
    if (!verified) {
      // A captured token that Supabase rejects is a smoke
      // failure — the operator pasted a stale token and the
      // deployed callback contract cannot be proven.
      return {
        ok: false,
        reason: "non-2xx",
        detail: "verifySignIn probe returned null for the operator-injected captured token",
      };
    }
    verifiedSubject = verified.subject;
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
  // Step 4: SoundHub server-side session integration. Per ticket
  // #59 P1-001 the smoke must cross `AuthenticationService` to
  // prove the verified provider identity resolves to a persisted
  // UserAccount and a SoundHub session. Without this step the
  // smoke is partial and the factory selects the deterministic
  // fallback.
  if (!deps.sessionProbe) {
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail:
        "verify path exercised but no SoundHub session probe was supplied; managed path is not Golden-Slice-ready",
    };
  }
  const probe = await deps.sessionProbe({ verificationToken: deps.verifyToken });
  if (!probe.ok) {
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail: `verify path exercised (subject=${verifiedSubject}) but SoundHub session integration failed: ${probe.detail ?? "unknown"}; managed path is not Golden-Slice-ready`,
    };
  }
  return {
    ok: true,
    detail: `request + verify + session exercised against Supabase; resolved subject=${verifiedSubject}; sessionId=${probe.sessionId ?? "<unset>"}`,
  };
}
