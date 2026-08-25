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
// Per ticket #59 P1-001 (next iteration) the smoke crosses the
// serving authentication seam EXACTLY ONCE. The captured one-time
// verification token is consumed by a single provider exchange
// inside the `AuthenticationService`-backed session probe — the
// smoke itself never calls `ManagedIdentityAdapter.verifySignIn`
// independently, so the captured token cannot be replay-rejected
// by the production boundary the smoke is meant to validate.
//
// The smoke probes:
//
//   1. /auth/v1/health — Supabase project is reachable.
//   2. /auth/v1/otp — magic-link request endpoint (with the
//      official `redirect_to` query parameter and current
//      request body shape). The probe uses a sentinel `.example`
//      mailbox because the smoke does not own a real mailbox;
//      delivery evidence is the captured token itself.
//   3. SoundHub server-side session round-trip — the session
//      probe drives `AuthenticationService.verifySignIn` with the
//      operator-injected captured token, the verified provider
//      identity resolves to a persisted UserAccount, a
//      SoundHub AuthSession is established, and the session is
//      resolved back to confirm the round-trip.
//
// The session probe is the SOLE exchange of the captured token.
// The smoke never inspects the provider response shape a second
// time and never re-derives identity from the same token. If the
// production seam is replay-rejecting the captured token, the
// smoke reports `ok: false` with an explicit reason so the
// approved deterministic fallback can make an explicit decision.
//
// The smoke is bounded by the adapter's smokeTimeoutMs so a hung
// network call cannot block startup indefinitely. The smoke
// returns { ok: false, reason, detail } on every failure mode so
// the factory can log the fallback decision and operators can act
// without spelunking the code.

import type { ManagedIdentityAdapter, SmokeResult } from "./managed-identity-adapter.js";
import { IdentityProviderUnavailableError } from "./identity-adapter.js";
import type { AuthenticationService } from "../services/authentication.service.js";

/**
 * Optional seam for the SoundHub server-side session round-trip.
 * Implementations drive the full `AuthenticationService.verifySignIn`
 * boundary against a captured verification token and report whether
 * a SoundHub session was issued and resolved back successfully.
 *
 * Per ticket #59 P1-001 the session probe is the SOLE exchange of
 * the captured token. Implementations MUST NOT call
 * `IdentityAdapter.verifySignIn` independently before or after
 * driving `AuthenticationService.verifySignIn` — doing so would
 * consume the captured token twice and the production seam would
 * reject the second attempt as a replay.
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
   * (per ticket #59 P2-001). When supplied, the smoke delegates
   * the verification exchange to the `sessionProbe` so the
   * captured token is consumed exactly once through the
   * production `AuthenticationService` seam. When absent, the
   * smoke reports the request path is reachable but the managed
   * path is NOT ready for Golden Slice selection (`ok: false`,
   * reason `session-coverage-incomplete`); the factory then
   * selects the deterministic adapter as the approved fallback.
   */
  readonly verifyToken?: string;
  /**
   * Optional SoundHub server-side session probe. The application
   * session probe MUST drive `AuthenticationService.verifySignIn`
   * with the captured token and then `resolveSession` with the
   * resulting session id — both steps must succeed for the smoke
   * to report `ok: true`. The smoke itself never independently
   * exchanges the captured token against the provider, so the
   * probe is the single exchange path.
   */
  readonly sessionProbe?: SessionProbe;
}

/**
 * Build the default `SessionProbe` against a real
 * `AuthenticationService`. The probe drives the service's
 * `verifySignIn` with the captured token, then `resolveSession`
 * with the resulting session id. Both steps must succeed for the
 * smoke to report `ok: true`. The probe is the SOLE exchange of
 * the captured token — it must never call the underlying
 * `IdentityAdapter.verifySignIn` before or after the service
 * call.
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
 * Per ticket #59 P1-001 the smoke is FAIL-CLOSED and consumes the
 * captured token EXACTLY ONCE. `ok: true` is only returned after
 * EVERY step succeeds:
 *   - provider health endpoint is reachable;
 *   - OTP request endpoint is reachable;
 *   - the captured verification token resolves through the
 *     application seam (`AuthenticationService.verifySignIn`)
 *     into a verified provider identity;
 *   - the verified identity resolves to a persisted UserAccount
 *     and a SoundHub session;
 *   - the SoundHub session resolves back to the same identity.
 *
 * The captured token is consumed exclusively by the session probe
 * (which uses `AuthenticationService.verifySignIn`). The smoke
 * itself does NOT call `ManagedIdentityAdapter.verifySignIn`
 * before or after the probe — doing so would mark the token
 * exchanged and the production seam would replay-reject the
 * probe's verify call. The smoke therefore performs only ONE
 * provider verification, driven by the production boundary.
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
  //
  // The probe targets a sentinel `.example` mailbox because the
  // smoke does not own a real mailbox. Delivery evidence for
  // the captured link is the captured token itself — the
  // operator received it via Supabase's email channel before
  // pasting it into BG1_SMOKE_TEST_TOKEN.
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
  // Step 3: SoundHub server-side session round-trip. Per ticket
  // #59 P1-001 the session probe is the SOLE exchange of the
  // captured token — it drives `AuthenticationService.verifySignIn`
  // with the token, the verified provider identity resolves to
  // a persisted UserAccount, a SoundHub session is established,
  // and the session is resolved back. The smoke itself NEVER
  // calls `ManagedIdentityAdapter.verifySignIn` so the captured
  // token is consumed exactly once through the production seam.
  if (
    deps.verifyToken === undefined ||
    typeof deps.verifyToken !== "string" ||
    deps.verifyToken.trim() === ""
  ) {
    // No operator-injected token. Per ticket #59 P1-001 a
    // missing token does NOT return `ok: true`. The smoke has
    // proven the request path is reachable but the
    // callback/session integration is unproven; the operator
    // MUST inject a captured token before declaring the deployed
    // managed path Golden-Slice-ready. The factory then selects
    // the deterministic fallback.
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail:
        "request path exercised but no BG1_SMOKE_TEST_TOKEN supplied; managed path is not Golden-Slice-ready",
    };
  }
  if (!deps.sessionProbe) {
    // The provider endpoint is reachable but the smoke has no
    // way to cross the application boundary; the smoke reports
    // session coverage as incomplete and the factory selects
    // the deterministic fallback.
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail:
        "verify path reachable but no SoundHub session probe was supplied; managed path is not Golden-Slice-ready",
    };
  }
  const probe = await deps.sessionProbe({ verificationToken: deps.verifyToken });
  if (!probe.ok) {
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail: `SoundHub session integration failed: ${probe.detail ?? "unknown"}; managed path is not Golden-Slice-ready`,
    };
  }
  return {
    ok: true,
    detail: `request + SoundHub session round-trip exercised against Supabase; resolved subject via sessionId=${probe.sessionId ?? "<unset>"}; userAccountId=${probe.userAccountId ?? "<unset>"}`,
  };
}
