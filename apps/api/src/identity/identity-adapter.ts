// Provider-neutral identity adapter contract.
//
// Background: BG1 requires that managed (Supabase) and deterministic
// authentication adapters map credentials to persisted SoundHub
// UserAccounts through the same application boundary. The contract
// below is the only place those adapters diverge — every other layer
// (session store, authorization service, route handler) consumes
// these shapes.
//
// Per ADR 0004 the adapter returns a provider + subject tuple, not a
// SoundHub user identifier. The application layer is responsible for
// looking up or creating the UserAccount via the durable mapping
// table; the adapter never knows about UserAccounts, Workspaces, or
// memberships. Provider metadata never crosses a public DTO.

import type { Bg1IdentityProviderV1 } from "@soundhub/types";

/**
 * Canonical identity returned by every adapter after a successful
 * magic-link verification. The provider key is the closed enum
 * declared in `@soundhub/types` so a future provider cannot be
 * introduced without extending the shared contract.
 */
export interface VerifiedIdentity {
  readonly provider: Bg1IdentityProviderV1;
  /**
   * The provider's stable, opaque identifier for the authenticated
   * human. Used to look up or create a UserAccount; never exposed in
   * any user-visible response.
   */
  readonly subject: string;
  /**
   * The provider's view of the human's email, when applicable. May be
   * `null` when the provider configuration does not surface an email
   * or when the provider does not assert an email at all.
   */
  readonly providerEmail: string | null;
}

/**
 * Result of `requestSignIn`. The adapter returns a public
 * correlation id (`requestId`) and (for the deterministic adapter)
 * an internal verify credential (`verifierToken`) and (only when
 * operator mode is enabled) a one-shot URL the operator recovery
 * flow can drive.
 *
 * The public route strips every field except `requestId` and the
 * optional `devVerificationUrl` via the BG1 strict Zod schema so
 * the verifier credential never crosses the browser boundary. The
 * browser therefore cannot claim any returned value as a verify
 * credential against `/api/auth/verify-token`. The deterministic
 * adapter stores its pending request under the verifier token, not
 * the public correlation id, so a browser that round-trips the
 * correlation id is rejected as an unknown request.
 *
 * `devVerificationUrl` is set only when the deterministic adapter
 * runs in operator mode (`BG1_DETERMINISTIC_OPERATOR_MODE=1`); the
 * managed adapter never sets it. Even in operator mode the URL is
 * emitted to the operator log sink only — the public response is
 * restricted to `{ ok, requestId }` by the schema so a deployed
 * browser can never receive a usable login credential.
 */
export interface SignInRequestResult {
  /**
   * Public correlation id. The BG1 contract returns this value to
   * the browser; it is NOT a verify credential. The deterministic
   * adapter uses it for log correlation only; the managed adapter
   * never reads it back.
   */
  readonly requestId: string;
  /**
   * Operator-only verify credential. The deterministic adapter
   * looks up its pending request by this value (not by the public
   * requestId), so the browser never has a valid value to present
   * to `/api/auth/verify-token`. The credential is exposed via
   * the adapter's return value so test harnesses can drive the
   * verify path directly; the deployed operator recovery path
   * reads it from the operator log sink.
   */
  readonly verifierToken?: string;
  /**
   * Operator-only one-shot URL. Only the deterministic adapter sets
   * it, and only when operator mode is enabled. Production
   * deployments and the deployed deterministic fallback both
   * render it absent.
   */
  readonly devVerificationUrl?: string;
}

/**
 * Thrown when the adapter is configured but the managed provider is
 * temporarily unavailable (network failure, provider outage,
 * throttling). The application surfaces this as
 * `AUTH_PROVIDER_UNAVAILABLE` and never falls through to a demo
 * identity (per the BG1 GS 4 contract).
 */
export class IdentityProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityProviderUnavailableError";
  }
}

/**
 * Thrown when the adapter receives an unknown / already-consumed
 * verification request. The application surfaces this as
 * `AUTH_FAILED` (deterministic and managed adapters converge on the
 * same single-use semantic).
 */
export class IdentityVerificationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityVerificationFailedError";
  }
}

export interface IdentityAdapter {
  readonly providerKey: Bg1IdentityProviderV1;
  /**
   * Initiate a magic-link sign-in for the given email. Returns an
   * opaque request id the browser later presents to `verifySignIn`.
   * Managed adapters send the magic link through their provider's
   * email channel; the deterministic adapter stores the request
   * locally and returns a `devVerificationUrl` the tests can use.
   */
  requestSignIn(input: { readonly email: string }): Promise<SignInRequestResult>;
  /**
   * Verify a one-time magic-link token and return the canonical
   * provider identity. Returns `null` when the request id is
   * unknown, expired, or already consumed (single-use per BG1
   * semantics).
   */
  verifySignIn(input: { readonly requestId: string }): Promise<VerifiedIdentity | null>;
}
