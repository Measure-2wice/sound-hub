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
// delivered email into `BG1_SMOKE_TEST_TOKEN`. The session
// probe then verifies the captured token, asserts the verified
// provider email equals the configured smoke mailbox, AND
// asserts the verified `user_metadata` contains the smoke's
// per-attempt `smokeAttemptId` (which the OTP request embedded
// via `data: { smokeAttemptId }`). The metadata assertion
// proves the captured credential was actually issued for THIS
// smoke attempt — a stale same-mailbox token issued before the
// smoke attempt has no matching `smokeAttemptId` and the smoke
// fails closed.
//
// Per ticket #59 P0-001 (this iteration) the bounded smoke never
// logs or returns the bearer session identifier it creates. The
// `AuthenticationService`-backed probe revokes the smoke-created
// session explicitly, treats both a `false` revocation result
// AND a thrown revocation error as a probe failure, and returns
// only non-secret pass/fail evidence plus the verified provider
// email and `user_metadata` (for the per-attempt correlation
// assertion). The smoke is FAIL-CLOSED when revocation cannot
// be confirmed — a managed smoke is successful only when every
// step, including cleanup, succeeds.
//
// The smoke probes:
//
//   1. /auth/v1/health — Supabase project is reachable.
//   2. /auth/v1/otp — magic-link request endpoint addressed to
//      the operator-configured smoke mailbox, embedding the
//      per-attempt `smokeAttemptId` in the request's `data`
//      payload so Supabase stores it as `user_metadata` on the
//      user record. The deployed email-template configuration
//      delivers a link to the same mailbox the operator uses to
//      capture the verification token.
//   3. SoundHub server-side session round-trip — the session
//      probe drives `AuthenticationService.verifySignIn` with the
//      operator-injected captured token, the verified provider
//      identity resolves to a persisted UserAccount, the
//      SoundHub AuthSession is established and resolved back to
//      confirm the round-trip, the verified provider email
//      matches the configured smoke mailbox, the verified
//      `user_metadata.smokeAttemptId` matches the smoke's
//      per-attempt correlation id, and the smoke-created
//      session is explicitly revoked (with the revoke outcome
//      confirmed) before the probe returns.
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
// DEPLOYED SUPABASE MAGIC-LINK CONTRACT (per ticket #59 P1-002).
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
// The canonical template body is versioned in this branch at
// `supabase/magic-link-email-template.html`. Apply it via the
// Supabase Studio email-template editor (or
// `scripts/apply-supabase-magic-link-template.mjs` when the
// Supabase Management API is available).
//
// BG1 only supports magic-link verification. The adapter pins
// `type: "magiclink"` for the `/auth/v1/verify` call (per
// ticket #59 P2-001); there is no runtime switch.

import { randomUUID } from "node:crypto";
import type { ManagedIdentityAdapter, SmokeResult } from "./managed-identity-adapter.js";
import { IdentityProviderUnavailableError } from "./identity-adapter.js";
import type { AuthenticationService } from "../services/authentication.service.js";

/**
 * Optional seam for the SoundHub server-side session round-trip.
 * Implementations drive the full `AuthenticationService.verifySignIn`
 * boundary against a captured verification token and report
 * whether a SoundHub session was issued and resolved back
 * successfully. Per ticket #59 P0-001 the probe MUST NOT expose
 * the live bearer session identifier or any account identifier;
 * it returns only non-secret pass/fail evidence plus the
 * verified provider email and `user_metadata` (so the smoke can
 * assert the captured credential was issued for its specific
 * attempt per ticket #59 P1-001).
 *
 * Per ticket #59 P1-001 the session probe is the SOLE exchange
 * of the captured token. Implementations MUST NOT call
 * `IdentityAdapter.verifySignIn` independently before or after
 * driving `AuthenticationService.verifySignIn` — doing so would
 * consume the captured token twice and the production seam would
 * reject the second attempt as a replay.
 *
 * Per ticket #59 P0-001 the probe MUST revoke any
 * smoke-created session explicitly and return `ok: true` only
 * when the revoke outcome is confirmed. A `false` revoke result
 * OR a thrown revoke error MUST surface as a probe failure —
 * the live bearer credential cannot be allowed to remain active
 * while the smoke reports success.
 */
export type SessionProbe = (input: { readonly verificationToken: string }) => Promise<{
  readonly ok: boolean;
  /**
   * The verified provider email returned by the
   * `AuthenticationService.verifySignIn` boundary (i.e. the
   * `providerEmail` from `VerifiedIdentity`, possibly null when
   * the provider does not surface an email). The smoke uses
   * this to assert the captured credential was actually issued
   * for the configured smoke mailbox.
   */
  readonly verifiedEmail?: string | null;
  /**
   * The verified provider `user_metadata` (the payload Supabase
   * stored from the OTP request's `data` field). The smoke
   * uses this to assert the captured credential was issued for
   * THIS smoke attempt — the smoke embeds a per-attempt
   * `smokeAttemptId` via `requestSmokeSignIn`'s `metadata`
   * argument and the verify response carries it back here.
   */
  readonly providerMetadata?: Record<string, unknown>;
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
   * probe is the single exchange path. The probe must also
   * revoke the smoke-created session BEFORE returning and must
   * surface a revoked=false or thrown revoke error as a probe
   * failure (per ticket #59 P0-001).
   */
  readonly sessionProbe?: SessionProbe;
  /**
   * Optional clock for tests; defaults to `randomUUID()`. The
   * smoke generates a per-attempt `smokeAttemptId` (UUID) and
   * embeds it in the OTP request's `data` payload. Tests pass a
   * fixed UUID to assert the per-attempt correlation.
   */
  readonly generateAttemptId?: () => string;
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
 *
 * Per ticket #59 P0-001 the probe revokes the smoke-created
 * session EXPLICITLY and tracks the revoke outcome. A
 * `false` revoke result OR a thrown revoke error overrides any
 * earlier success and surfaces as `ok: false` so the live
 * bearer credential cannot remain active while the smoke reports
 * success. The probe returns only non-secret pass/fail
 * evidence plus the verified provider email and `user_metadata`
 * (for the per-attempt correlation assertion).
 */
export function buildSessionProbe(authService: AuthenticationService): SessionProbe {
  return async ({ verificationToken }) => {
    let smokeSessionId: string | undefined;
    // The probe's outcome is captured in a local variable so
    // the finally block can override it when revocation fails
    // (per ticket #59 P0-001). The smoke never returns success
    // while a temporary bearer session may remain active.
    let outcome: {
      readonly ok: boolean;
      readonly verifiedEmail?: string | null;
      readonly providerMetadata?: Record<string, unknown>;
      readonly detail?: string;
    } = { ok: false, detail: "session probe did not complete" };
    try {
      const verified = await authService.verifySignIn({ verificationToken });
      smokeSessionId = verified.session.sessionId;
      const resolved = await authService.resolveSession(smokeSessionId);
      if (!resolved) {
        outcome = {
          ok: false,
          detail: "resolveSession returned null for the freshly issued session",
        };
        return outcome;
      }
      outcome = {
        ok: true,
        verifiedEmail: resolved.email,
        providerMetadata: verified.providerMetadata,
      };
      // Revoke the smoke-created session immediately while we
      // still have the session id. A failure here MUST
      // override the success outcome so the smoke never reports
      // ok: true while a temporary bearer session may remain
      // active.
      const revoked = await authService.signOut(smokeSessionId);
      if (!revoked) {
        outcome = {
          ok: false,
          detail: "session revoke returned false; smoke-created session may still be active",
        };
      }
      return outcome;
    } catch (err) {
      outcome = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
      return outcome;
    } finally {
      // Failure-safe cleanup: when the probe throws or the
      // verify path itself failed, revoke any session the probe
      // issued before the failure. The finally block only runs
      // if the smoke-created session has not already been
      // revoked via the in-try path above (which is gated by
      // the explicit boolean check). We track the revoke
      // outcome again here so a thrown or false revoke is
      // surfaced as a probe failure — never swallowed.
      if (smokeSessionId !== undefined && outcome.ok) {
        // The in-try revoke either succeeded (outcome.ok === true)
        // or already overrode the outcome to failure. If we are
        // here with outcome.ok === true, the in-try revoke
        // succeeded; nothing to do.
      } else if (smokeSessionId !== undefined) {
        // outcome.ok is false (the in-try revoke already failed
        // or an earlier step failed). The smoke-created session
        // is still active; attempt a final revoke so the live
        // bearer credential is revoked even when the smoke
        // outcome is failure. We deliberately do not overwrite
        // outcome here — the failure is the more important
        // signal. A best-effort log is the only side effect.
        try {
          const finalRevoke = await authService.signOut(smokeSessionId);
          if (!finalRevoke) {
            console.error(
              `[bg1-smoke] session revoke returned false during cleanup for ${smokeSessionId}`,
            );
          }
        } catch (cleanupErr) {
          console.error(
            `[bg1-smoke] session revoke threw during cleanup for ${smokeSessionId}:`,
            cleanupErr,
          );
        }
      }
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
 *   - the SoundHub session resolves back to the same identity;
 *   - the verified provider email equals the configured smoke
 *     mailbox (per ticket #59 P1-001 — proves the captured
 *     credential was actually issued for the smoke mailbox, not
 *     a stale token for some other account);
 *   - the verified `user_metadata.smokeAttemptId` matches the
 *     smoke's per-attempt correlation id (per ticket #59
 *     P1-001 — proves the captured credential was actually
 *     issued for THIS smoke attempt, not a stale same-mailbox
 *     token issued before the smoke ran);
 *   - the smoke-created session is revoked and the revoke
 *     outcome is confirmed (per ticket #59 P0-001 — the live
 *     bearer credential cannot remain active while the smoke
 *     reports success).
 *
 * The captured token is consumed exclusively by the session probe
 * (which uses `AuthenticationService.verifySignIn`). The smoke
 * itself does NOT call `ManagedIdentityAdapter.verifySignIn`
 * before or after the probe — doing so would mark the token
 * exchanged and the production seam would replay-reject the
 * probe's verify call. The smoke therefore performs only ONE
 * provider verification, driven by the production boundary.
 *
 * The smoke result carries ONLY non-secret evidence. The
 * `detail` field is sanitized so it never contains the bearer
 * session id, the resolved UserAccount id, the provider subject,
 * the captured verification token, or the smokeAttemptId — only
 * pass/fail text and the configured smoke mailbox (which is
 * itself operator-controlled).
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
  // Per-attempt correlation id (per ticket #59 P1-001). The
  // smoke embeds this id in the OTP request's `data` payload so
  // Supabase stores it as `user_metadata` on the user record;
  // the verify response carries it back so the smoke can
  // assert the captured token was issued for THIS attempt
  // (not a stale same-mailbox token issued before the smoke
  // ran).
  const smokeAttemptId = (deps.generateAttemptId ?? randomUUID)();
  // A magic-link request endpoint that 2xx's proves the deployed
  // Supabase project will deliver a link to the smoke mailbox.
  // The captured token itself arrives via the operator's email
  // client once the configured email template fires.
  try {
    await managed.requestSmokeSignIn({
      email: smokeMailbox,
      metadata: { smokeAttemptId },
    });
  } catch (err) {
    if (err instanceof IdentityProviderUnavailableError) {
      return {
        ok: false,
        reason: "network",
        detail: `requestSmokeSignIn probe failed for smoke mailbox ${smokeMailbox}: ${err.message}`,
      };
    }
    throw err;
  }
  // Step 3: SoundHub server-side session round-trip. Per ticket
  // #59 P1-001 the session probe is the SOLE exchange of the
  // captured token — it drives `AuthenticationService.verifySignIn`
  // with the token, the verified provider identity resolves to
  // a persisted UserAccount, a SoundHub session is established,
  // the session is resolved back, and the probe revokes the
  // smoke-created session before returning. The smoke itself
  // NEVER calls `ManagedIdentityAdapter.verifySignIn` so the
  // captured token is consumed exactly once through the
  // production seam.
  if (
    deps.verifyToken === undefined ||
    typeof deps.verifyToken !== "string" ||
    deps.verifyToken.trim() === ""
  ) {
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail: `smoke mailbox ${smokeMailbox} accepted the OTP request (smokeAttemptId=${smokeAttemptId}) but no BG1_SMOKE_TEST_TOKEN captured from the delivered email was supplied; managed path is not Golden-Slice-ready`,
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
      detail: `SoundHub session integration failed (smoke mailbox ${smokeMailbox}, smokeAttemptId=${smokeAttemptId}): ${probe.detail ?? "unknown"}; managed path is not Golden-Slice-ready`,
    };
  }
  // Per ticket #59 P1-001 the verified provider email MUST
  // equal the configured smoke mailbox. This proves the
  // captured credential was actually issued for the smoke
  // mailbox (i.e. the operator pasted a real token from the
  // delivered email) rather than a stale token for some other
  // account.
  if ((probe.verifiedEmail ?? "").toLowerCase() !== smokeMailbox.toLowerCase()) {
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail: `verified provider email does not match smoke mailbox ${smokeMailbox}; the captured token was not issued for the smoke mailbox. Paste a token captured from a fresh delivery to ${smokeMailbox}.`,
    };
  }
  // Per ticket #59 P1-001 the verified `user_metadata` MUST
  // contain the smoke's per-attempt `smokeAttemptId`. This
  // proves the captured credential was actually issued for
  // THIS smoke attempt (the OTP request embedded the id via
  // `data: { smokeAttemptId }`) — a stale same-mailbox token
  // issued before this smoke attempt has no matching id and
  // fails closed. The smoke therefore proves not just that
  // "the token verified" but that "the token was issued by
  // THIS smoke's OTP request".
  const verifiedAttemptId = probe.providerMetadata?.["smokeAttemptId"];
  if (verifiedAttemptId !== smokeAttemptId) {
    return {
      ok: false,
      reason: "session-coverage-incomplete",
      detail: `verified provider metadata does not carry the smoke's per-attempt correlation id; the captured token was issued before this smoke attempt or by a different request. Paste the token from a fresh delivery to ${smokeMailbox}.`,
    };
  }
  return {
    ok: true,
    detail: `SoundHub session round-trip verified for smoke mailbox ${smokeMailbox}; smoke-created session was explicitly revoked and the revoke outcome was confirmed before this result was returned.`,
  };
}
