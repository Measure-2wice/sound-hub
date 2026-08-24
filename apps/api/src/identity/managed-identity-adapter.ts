// Managed (Supabase) identity adapter stub.
//
// Background: BG1 prefers managed email magic-link authentication
// (Supabase Auth) behind the provider-neutral identity interface.
// This file declares the adapter that will call the Supabase Auth
// REST API when configured. In the current environment we cannot
// reach a deployed Supabase project, so the adapter is implemented
// as a deliberate stub that:
//
//   - Honours the `IdentityAdapter` contract so the focused contract
//     tests can verify shape.
//   - Throws `IdentityProviderUnavailableError` on every call when
//     the required environment variables are absent.
//   - Documents the planned real implementation so future tickets
//     can fill in the body without redesigning the seam.
//
// Per ADR 0004 the adapter never owns SoundHub identity. It returns
// only the provider's subject, the provider's email, and the
// provider key; everything else (UserAccount, Workspace, membership)
// is owned by `PrismaAuthRepository`.

import type { Bg1IdentityProviderV1 } from "@soundhub/types";
import {
  IdentityProviderUnavailableError,
  type IdentityAdapter,
  type SignInRequestResult,
  type VerifiedIdentity,
} from "./identity-adapter.js";

export interface ManagedIdentityAdapterOptions {
  readonly supabaseUrl?: string;
  readonly supabaseAnonKey?: string;
  readonly supabaseServiceRoleKey?: string;
}

/**
 * The managed adapter is the deployed primary path. It exists today
 * as a shape-only stub because the BG1 ticket requires that the
 * managed and deterministic adapters implement the same contract,
 * but the production managed environment is not reachable from the
 * buildathon environment. Every method explicitly throws
 * `IdentityProviderUnavailableError` when the required configuration
 * is absent so the application layer never falls through to a demo
 * identity (per the GS 4 contract: "Provider unavailability never
 * permits an authentication or authorization bypass").
 */
export class ManagedIdentityAdapter implements IdentityAdapter {
  readonly providerKey: Bg1IdentityProviderV1 = "managed-magic-link";

  constructor(private readonly options: ManagedIdentityAdapterOptions = {}) {}

  /**
   * True when the managed adapter has enough configuration to call
   * Supabase Auth in production. Focused tests use this to skip the
   * smoke against unconfigured environments; the adapter still
   * throws when called without configuration so production never
   * silently no-ops.
   */
  isConfigured(): boolean {
    return Boolean(
      this.options.supabaseUrl &&
        this.options.supabaseAnonKey &&
        this.options.supabaseServiceRoleKey,
    );
  }

  async requestSignIn(input: { readonly email: string }): Promise<SignInRequestResult> {
    await this.assertConfigured();
    // Real implementation (deferred): POST {supabaseUrl}/auth/v1/otp
    // with the service-role bearer token and the buyer-supplied email.
    // The returned request id is the magic-link token Supabase embeds
    // in the email; on the callback path `verifySignIn` exchanges it
    // for a server-validated session through Supabase's verify
    // endpoint. This stub never receives a configured environment, so
    // the body is intentionally absent — the assertion below is the
    // only code path that runs.
    void input;
    throw new IdentityProviderUnavailableError(
      "Managed magic-link adapter is not configured in this environment.",
    );
  }

  async verifySignIn(input: { readonly requestId: string }): Promise<VerifiedIdentity | null> {
    await this.assertConfigured();
    void input;
    throw new IdentityProviderUnavailableError(
      "Managed magic-link adapter is not configured in this environment.",
    );
  }

  private async assertConfigured(): Promise<void> {
    if (!this.isConfigured()) {
      throw new IdentityProviderUnavailableError(
        "Managed magic-link adapter requires SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    await Promise.resolve();
  }
}
