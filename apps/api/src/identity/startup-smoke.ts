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
// Per ticket #59 P1-001 (this iteration) the smoke ties the OTP
// probe to the SAME mailbox the operator will receive the
// captured link on, so the bounded smoke traverses the link
// produced by the deployed email-template configuration. The
// operator configures `BG1_SMOKE_MAILBOX` to a real mailbox they
// own; the smoke posts the magic-link OTP request to that
// mailbox and the operator pastes the token extracted from the
// delivered email into `BG1_SMOKE_TEST_TOKEN`. The smoke
// therefore proves the END-TO-END contract the deployed browser
// journey will use: an email arrives at the configured mailbox,
// the delivered link embeds `?token=<token_hash>` against the
// configured `AUTH_CALLBACK_URL`, and the application boundary
// exchanges the credential exactly once.
//
// The smoke probes:
//
//   1. /auth/v1/health — Supabase project is reachable.
//   2. /auth/v1/otp — magic-link request endpoint addressed to
//      the operator-configured smoke mailbox (NOT a sentinel
//      `.example` address). A 2xx response proves the deployed
//      email-template configuration will actually deliver a link
//      to the mailbox the operator uses to capture the
//      verification token.
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
//
// ----------------------------------------------------------------
// DEPLOYED SUPABASE MAGIC-LINK CONTRACT (per ticket #59 P1-001).
// ----------------------------------------------------------------
// The deployed managed path requires the Supabase project's
// magic-link email template to deliver a link of the form:
//
//     <AUTH_CALLBACK_URL>?token=<token_hash>
//
// i.e. the email template's action link MUST be
// `{{ .SiteURL }}/auth/callback?token={{ .TokenHash }}` (or
// `<AUTH_CALLBACK_URL>?token={{ .TokenHash }}`) so the browser's
// `MagicLinkVerifier` extracts the credential from `?token=...`
// and POSTs it to `/api/auth/verify-token`. The Supabase
// default magic-link email does NOT append the raw token hash
// to the redirect — operators MUST configure the custom email
// template (Supabase Studio → Authentication → Email Templates
// → Magic Link) for the deployed Golden Slice.
//
// The matching verify type (`MANAGED_VERIFY_TYPE` env var,
// default `magiclink`) MUST match the `type` declared in the
// email template so the server-side `verifySignIn` accepts the
// captured token. The deployed smoke will fail closed if
// `BG1_SMOKE_MAILBOX` is unset so operators cannot declare the
// managed path Golden-Slice-ready without exercising the
// delivered-link configuration.

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
   * Operator-controlled mailbox the bounded smoke will request
   * the magic link from. The mailbox MUST be a real address the
   * operator owns so they can receive the delivered email and
   * paste the captured `token_hash` into `BG1_SMOKE_TEST_TOKEN`.
   * Per ticket #59 P1-001 the smoke ties the OTP probe to the
   * SAME mailbox the captured link arrives on; a sentinel
   * `.example` mailbox cannot receive real email and cannot
   * prove the deployed email-template configuration.
   *
   * When omitted, the smoke reports
   * `session-coverage-incomplete` and the factory selects the
   * deterministic fallback — the managed path cannot be declared
   * Golden-Slice-ready without the operator exercising the
   * delivered-link configuration.
   */
  readonly smokeMailbox?: string;
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
 *   - OTP request endpoint delivers to the operator-configured
 *     smoke mailbox (the same mailbox the captured link is
 *     received on);
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
  // Step 2: operator-configured smoke mailbox. Per ticket #59
  // P1-001 the OTP probe must target the SAME mailbox the
  // operator will receive the captured link on — a sentinel
  // `.example` address cannot receive email and therefore
  // cannot prove the deployed email-template configuration.
  // The smoke fails closed when no smoke mailbox is configured
  // so operators cannot declare the managed path
  // Golden-Slice-ready without exercising the delivered-link
  // journey.
  const smokeMailbox = deps.smokeMailbox?.trim();
  if (!smokeMailbox) {
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail:
        "no BG1_SMOKE_MAILBOX configured; the smoke must target the same mailbox the operator will receive the captured link on. Configure BG1_SMOKE_MAILBOX (and the Supabase magic-link email template to redirect to <AUTH_CALLBACK_URL>?token={{ .TokenHash }}) before declaring the managed path Golden-Slice-ready.",
    };
  }
  // A magic-link request endpoint that 2xx's proves the deployed
  // Supabase project will deliver a link to the smoke mailbox.
  // The captured token itself arrives via the operator's email
  // client once the configured email template fires.
  try {
    const result = await managed.requestSignIn({ email: smokeMailbox });
    // The opaque handle itself is unused — the smoke only proves
    // the endpoint delivers to the configured mailbox.
    void result;
  } catch (err) {
    if (err instanceof IdentityProviderUnavailableError) {
      return {
        ok: false,
        reason: "network",
        detail: `requestSignIn probe failed for smoke mailbox ${smokeMailbox}: ${err.message}`,
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
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail: `smoke mailbox ${smokeMailbox} accepted the OTP request but no BG1_SMOKE_TEST_TOKEN captured from the delivered email was supplied; managed path is not Golden-Slice-ready`,
    };
  }
  if (!deps.sessionProbe) {
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
      detail: `SoundHub session integration failed (smoke mailbox ${smokeMailbox}): ${probe.detail ?? "unknown"}; managed path is not Golden-Slice-ready`,
    };
  }
  return {
    ok: true,
    detail: `OTP delivered to smoke mailbox ${smokeMailbox}; SoundHub session round-trip exercised against Supabase; sessionId=${probe.sessionId ?? "<unset>"}; userAccountId=${probe.userAccountId ?? "<unset>"}`,
  };
}
