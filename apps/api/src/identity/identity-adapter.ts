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
 * Result of `requestSignIn`. The adapter stores the opaque
 * `requestId` for later verification and (for managed providers)
 * emails a magic link containing it. The optional
 * `devVerificationUrl` is set only by the deterministic adapter to
 * enable automated tests and the approved emergency fallback path;
 * managed providers omit it so production deployments cannot leak a
 * usable verification URL.
 */
export interface SignInRequestResult {
  readonly requestId: string;
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
