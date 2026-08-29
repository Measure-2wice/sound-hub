// Managed (Supabase) identity adapter.
//
// Background: BG1 prefers managed email magic-link authentication
// (Supabase Auth) behind the provider-neutral identity interface.
// This adapter exchanges Supabase-issued magic-link tokens with
// Supabase's verify endpoint and derives the durable identity only
// from the verified provider response. The user-facing product is
// still described as email magic-link authentication; the wire-
// level verify type pinned below is Supabase's current token-hash
// type, not the user-facing product name.
//
// The adapter is built around three contracts:
//
//   1. The provider-neutral `IdentityAdapter` interface — every
//      higher layer (session store, authorization service, route
//      handler) is shared between managed and deterministic
//      authentication. Provider subjects, claims, and metadata
//      never cross a public DTO (ADR 0004).
//
//   2. The deployed managed path proves the caller controlled the
//      mailbox by exchanging the Supabase magic-link token returned
//      in the email callback with Supabase's verify endpoint.
//      `requestSignIn` triggers Supabase OTP (real email delivery)
//      and returns an opaque SoundHub-side handle. `verifySignIn`
//      receives the Supabase-issued token (extracted from the
//      browser's `?token=...` URL parameter) and exchanges it with
//      Supabase. The subject and email come ONLY from the verified
//      response — the SoundHub request handle is opaque and never
//      carries user identity. Replay is rejected via single-use
//      tracking.
//
//   3. Runtime validation at the Supabase JSON boundary. Per
//      AGENTS.md and the BG1 contract, untrusted provider payloads
//      are parsed with strict Zod schemas before they enter
//      identity derivation. A drifted or malformed payload fails
//      closed.
//
// The bounded smoke probes the configured Supabase project's auth
// endpoint so the composition root can fail fast and fall back to the
// deterministic adapter without leaving an unconfigured managed
// adapter selected. The smoke is a non-destructive, non-OTP
// configuration probe; it does NOT request, consume, or revoke a
// live OTP. Per ticket #59 GS 2, "Provider unavailability never
// permits an authentication or authorization bypass."
//
// Per ticket #59 P0-001 the adapter pins the current Supabase REST
// verify contract: the token-hash verify endpoint posts
// `type: "email"` (Supabase's current wire-level type for token-hash
// verification; the user-facing product remains email magic-link
// authentication). The verify success response parses the full
// access-token/session envelope Supabase returns. Identity derivation
// only reads the allow-listed `id` and `email` fields from the parsed
// envelope so additional provider metadata never enters the SoundHub
// boundary.
//
// Per ticket #59 P1-001 the provider-response parser is
// FORWARD-COMPATIBLE with documented Supabase fields (e.g.
// `expires_at`, `expires_in` duplicates, future additions). The
// SoundHub PUBLIC contract remains strict — only the provider
// response parser tolerates documented/provider-added fields, and
// the parsed shape is discarded after identity derivation so
// additional provider metadata never crosses a SoundHub DTO.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Bg1IdentityProviderV1 } from "@soundhub/types";
import {
  IdentityProviderUnavailableError,
  IdentityVerificationFailedError,
  type IdentityAdapter,
  type SignInRequestResult,
  type VerifiedIdentity,
} from "./identity-adapter.js";

// ---------- Runtime schemas for Supabase responses ----------
//
// Per AGENTS.md, runtime validation is required at untrusted
// provider JSON boundaries. The schemas below are split between
// provider-response parsers (FORWARD-COMPATIBLE — tolerate
// documented Supabase fields like `expires_at`) and identity
// derivation (STRICT — only the allow-listed `id` and `email`
// fields are read).
//
// The provider-response parser uses `.passthrough()` so additional
// documented fields Supabase publishes (e.g. `expires_at`,
// `provider_token`, future additions) do not cause the parser to
// reject otherwise-valid responses. The PUBLIC SoundHub contract
// is unaffected: identity derivation only reads the allow-listed
// fields, and the parsed provider envelope is discarded after
// identity is established. A drifted payload that drops required
// fields still fails closed.

const supabaseUserV1Schema = z
  .object({
    id: z.string().min(1).max(128),
    email: z.string().email().nullable().optional(),
    aud: z.string().max(64).optional(),
    role: z.string().max(64).optional(),
    email_confirmed_at: z.string().max(64).nullable().optional(),
    phone: z.string().max(64).nullable().optional(),
    confirmed_at: z.string().max(64).nullable().optional(),
    last_sign_in_at: z.string().max(64).nullable().optional(),
    app_metadata: z.record(z.unknown()).optional(),
    user_metadata: z.record(z.unknown()).optional(),
    identities: z.array(z.record(z.unknown())).optional(),
    created_at: z.string().max(64).nullable().optional(),
    updated_at: z.string().max(64).nullable().optional(),
  })
  .strict();

// Supabase OTP success body is documented as either an empty `{}`
// envelope or `{ data: {} }`. Per ticket #59 P1-001 the parser
// tolerates additional documented Supabase response fields so a
// future Supabase response shape is not silently rejected. We
// require the body to be either an object or null (the documented
// shapes) and tolerate any documented extras; a non-object
// payload still fails closed.
const supabaseOtpSuccessV1Schema = z.union([z.record(z.unknown()), z.null()]).nullable();

// Supabase OTP error body is `{ error: { message, ... } }`. The
// `message` field is required (the safe envelope surfaces it to
// the caller); additional documented Supabase fields are
// tolerated via `.passthrough()`.
const supabaseOtpErrorV1Schema = z
  .object({
    error: z
      .object({
        message: z.string().min(1).max(1000),
      })
      .passthrough(),
  })
  .passthrough();

// Supabase verify response shape (current OpenAPI). The envelope is
// the access-token/session shape. The parser is FORWARD-COMPATIBLE
// at the top level: additional documented Supabase fields (e.g.
// `expires_at`, `provider_token`, `provider_refresh_token`) are
// tolerated so a future Supabase response shape does not cause the
// bounded smoke to reject a valid provider. The PUBLIC SoundHub
// contract remains strict — identity derivation only reads the
// allow-listed `id` and `email` from the parsed user object, and
// every other parsed field is discarded.
//
// The `user` field is `.strict()` so unknown inner fields do not
// silently enter the SoundHub boundary; identity derivation only
// reads `id` and `email` from it.
const supabaseVerifySuccessV1Schema = z
  .object({
    access_token: z.string().min(1).max(8192),
    token_type: z.string().min(1).max(64),
    expires_in: z.number().int().nonnegative(),
    refresh_token: z.string().min(1).max(8192),
    user: supabaseUserV1Schema.nullable(),
  })
  .passthrough();

const supabaseVerifyErrorV1Schema = z
  .object({
    error: z
      .object({
        message: z.string().min(1).max(1000),
      })
      .passthrough(),
  })
  .passthrough();

// ---------- Adapter options ----------

export interface ManagedIdentityAdapterOptions {
  readonly supabaseUrl?: string;
  readonly supabaseAnonKey?: string;
  readonly supabaseServiceRoleKey?: string;
  /**
   * Optional HTTP fetch implementation. Tests pass a stub.
   * Defaults to the global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional timeout for the bounded smoke. Defaults to 5 seconds.
   * The smoke must be fast: per the ticket the bounded provider
   * smoke is "not a second product journey".
   */
  readonly smokeTimeoutMs?: number;
  /**
   * Optional callback URL the magic-link email redirects to. The
   * Supabase-issued token is appended to this URL by Supabase; the
   * browser extracts it from the `?token=...` query string and
   * POSTs it to `/api/auth/verify-token` as `verificationToken`.
   * Per the Supabase REST contract the value is passed as the
   * `redirect_to` query parameter on `POST /auth/v1/otp`, not as a
   * body field.
   */
  readonly emailRedirectTo?: string;
  /**
   * Optional clock for tests; defaults to `Date.now`. Used by the
   * single-use token tracker to bound in-memory growth.
   */
  readonly now?: () => number;
}

export interface SmokeResult {
  readonly ok: boolean;
  readonly reason?: "unconfigured" | "non-2xx" | "network" | "timeout";
  readonly detail?: string;
}

const DEFAULT_SMOKE_TIMEOUT_MS = 5_000;
// Supabase's current wire-level type for token-hash verification is
// `"email"` (per ticket #59 P0-001); the user-facing product is
// email magic-link authentication, but the verify endpoint pins
// `type: "email"` as the wire-level discriminator. There is no
// runtime switch — BG1 only supports this verification type.
const VERIFY_TYPE = "email" as const;
const SINGLE_USE_TTL_MS = 15 * 60 * 1000; // matches Supabase OTP TTL

/**
 * The managed adapter is the deployed primary path. It honours the
 * `IdentityAdapter` contract and exposes a `smoke()` method that
 * the factory uses to decide between managed and deterministic
 * modes at startup. Without configuration OR with a failing smoke,
 * every request throws `IdentityProviderUnavailableError`; the
 * composition root then routes through the deterministic adapter.
 */
export class ManagedIdentityAdapter implements IdentityAdapter {
  readonly providerKey: Bg1IdentityProviderV1 = "managed-magic-link";

  private readonly options: ManagedIdentityAdapterOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly smokeTimeoutMs: number;
  private readonly now: () => number;
  /**
   * Single-use tracking for exchanged Supabase tokens. Once a
   * token is exchanged with Supabase, subsequent attempts return
   * null so a stolen token cannot mint two sessions. Tokens are
   * evicted after {@link SINGLE_USE_TTL_MS} to bound memory.
   */
  private readonly exchangedTokens = new Map<string, number>();

  constructor(options: ManagedIdentityAdapterOptions = {}) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.smokeTimeoutMs = options.smokeTimeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * True when the adapter has every required environment variable
   * to call Supabase Auth in production. Used by the factory and
   * the smoke to decide whether the managed path is selectable.
   */
  isConfigured(): boolean {
    return Boolean(
      this.options.supabaseUrl &&
        this.options.supabaseAnonKey &&
        this.options.supabaseServiceRoleKey,
    );
  }

  /**
   * Bounded deployed-provider smoke. The ticket requires that the
   * managed authentication path "receive a bounded
   * deployed-environment smoke" so the composition root can fail
   * fast and fall back to the deterministic adapter when managed
   * is unreachable. The smoke is a non-destructive probe of the
   * configured Supabase project's Auth endpoint: a short-timeout
   * HEAD on `${SUPABASE_URL}/auth/v1/health`. Any non-2xx response,
   * network failure, or timeout causes the smoke to return
   * `{ ok: false, reason }` so the factory can record the
   * fallback selection explicitly.
   *
   * Per ticket #59 the smoke does NOT request, consume, or revoke
   * a live Supabase OTP. End-to-end managed email verification is
   * validated by an explicit bounded operational smoke procedure
   * (see `docs/deployment/managed-provider-smoke.md`), not by an
   * application-startup health check. This keeps normal
   * application startup limited to validating managed-auth
   * configuration and constructing the managed adapter.
   *
   * Tests pass a `fetchImpl` stub to assert the smoke's contract
   * independently from the network.
   */
  async smoke(): Promise<SmokeResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        reason: "unconfigured",
        detail: "SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set",
      };
    }
    const url = `${this.options.supabaseUrl}/auth/v1/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.smokeTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          apikey: this.options.supabaseAnonKey ?? "",
          Authorization: `Bearer ${this.options.supabaseServiceRoleKey ?? ""}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          reason: "non-2xx",
          detail: `Supabase health returned ${response.status}`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: "network",
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Begin a managed magic-link sign-in. Calls Supabase OTP to
   * trigger real email delivery; the Supabase-issued token is
   * delivered in the email link (we never see it server-side
   * until the browser posts it back). Returns an OPAQUE SoundHub
   * handle used only for logging — the handle contains no user
   * identity and is not safe to authorize a session.
   *
   * Per ticket #59 the public correlation id and the private
   * one-time verification credential are returned under distinct
   * field names so the provider-neutral seam cannot accidentally
   * substitute one for the other. The managed path does NOT return
   * a `verificationToken`: Supabase owns the one-time credential
   * and surfaces it in the magic-link callback URL the browser
   * extracts; the managed adapter never holds a verifier
   * credential.
   *
   * Per ticket #59 the request honours the official Supabase REST
   * contract: the body carries only `email` and `create_user`; the
   * optional email-redirect URL is passed as the `redirect_to`
   * query parameter on the URL (NOT as a body field).
   */
  async requestSignIn(input: { readonly email: string }): Promise<SignInRequestResult> {
    this.assertConfigured();
    let url = `${this.options.supabaseUrl}/auth/v1/otp`;
    if (this.options.emailRedirectTo) {
      // Supabase expects `redirect_to` as a query parameter.
      // encodeURIComponent keeps reserved characters from
      // breaking the URL.
      url = `${url}?redirect_to=${encodeURIComponent(this.options.emailRedirectTo)}`;
    }
    const body: Record<string, unknown> = {
      email: input.email,
      create_user: true,
    };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.options.supabaseAnonKey ?? "",
          Authorization: `Bearer ${this.options.supabaseServiceRoleKey ?? ""}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network failure or abort is provider unavailability — the
      // managed path is unreachable and the application must
      // surface AUTH_PROVIDER_UNAVAILABLE rather than pretend the
      // request succeeded.
      throw new IdentityProviderUnavailableError(err instanceof Error ? err.message : String(err));
    }
    const raw: unknown = await response.json().catch(() => null);
    // Parse with the forward-compatible schema so a drifted
    // payload fails closed before we trust the email delivery.
    // The parsed payload itself is unused (Supabase's OTP success
    // body is empty); we only need it to fail loudly on drift.
    if (!response.ok) {
      const errParsed = supabaseOtpErrorV1Schema.safeParse(raw);
      const detail = errParsed.success
        ? errParsed.data.error.message
        : `Supabase OTP request returned ${response.status}`;
      // 5xx is provider unavailability; 4xx is a request
      // rejection. Both surface to the caller as
      // `IdentityProviderUnavailableError` because the magic-link
      // flow is blocked end-to-end regardless of cause.
      throw new IdentityProviderUnavailableError(detail);
    }
    supabaseOtpSuccessV1Schema.parse(raw);
    return {
      // Public correlation id (per ticket #59). The managed
      // adapter never reads it back; the `verificationToken` the
      // browser eventually sends to `/api/auth/verify-token` is
      // the Supabase-issued token from the email link, not this
      // handle.
      correlationId: `managed-pending-${randomUUID()}`,
    };
  }

  /**
   * Exchange a Supabase-issued magic-link verification credential
   * with Supabase's verify endpoint and derive the canonical
   * identity from the verified response. The browser extracts the
   * Supabase token from the email callback URL (typically
   * `?token=<token>`) and POSTs it to `/api/auth/verify-token` as
   * `verificationToken`. Per ticket #59 the input field is named
   * `verificationToken` so the provider-neutral seam cannot
   * accidentally accept the public correlation id in its place.
   *
   * Per ticket #59 P0-001 the request body pins Supabase's current
   * token-hash verify contract: `token_hash` + `type: "email"`.
   * (The user-facing product remains email magic-link
   * authentication; `type: "email"` is Supabase's wire-level
   * discriminator for the token-hash verification endpoint.)
   * The success response is parsed against the full access-token
   * / session envelope (access_token, token_type, expires_in,
   * refresh_token, user). The parser is FORWARD-COMPATIBLE with
   * documented Supabase fields (e.g. `expires_at`, future
   * additions) so a normal provider response is not rejected; the
   * SoundHub PUBLIC contract remains strict — identity derivation
   * only reads the allow-listed `id` and `email` from the parsed
   * user.
   *
   * Returns `null` for replayed, expired, or invalid tokens.
   */
  async verifySignIn(input: {
    readonly verificationToken: string;
  }): Promise<VerifiedIdentity | null> {
    this.assertConfigured();
    const token = input.verificationToken;
    if (typeof token !== "string") return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    // Replay protection: a Supabase token already exchanged cannot
    // mint a second SoundHub session. The token TTL is bounded so
    // the cache cannot grow without limit.
    this.gcExchangedTokens();
    if (this.exchangedTokens.has(trimmed)) return null;

    const url = `${this.options.supabaseUrl}/auth/v1/verify`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.options.supabaseAnonKey ?? "",
          Authorization: `Bearer ${this.options.supabaseServiceRoleKey ?? ""}`,
        },
        body: JSON.stringify({ token_hash: trimmed, type: VERIFY_TYPE }),
      });
    } catch (err) {
      // Network failure or abort is provider unavailability —
      // the managed verify endpoint is unreachable, so a session
      // cannot be issued regardless of token validity.
      throw new IdentityProviderUnavailableError(err instanceof Error ? err.message : String(err));
    }
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const errParsed = supabaseVerifyErrorV1Schema.safeParse(raw);
      const detail = errParsed.success
        ? errParsed.data.error.message
        : `Supabase verify returned ${response.status}`;
      // 5xx is provider unavailability; 4xx is a token-level
      // rejection. The two failure modes need different
      // classification so the bounded smoke can distinguish
      // reachable-but-rejecting from unreachable.
      if (response.status >= 500) {
        throw new IdentityProviderUnavailableError(detail);
      }
      throw new IdentityVerificationFailedError(detail);
    }
    let parsed: {
      user: {
        id: string;
        email?: string | null | undefined;
      } | null;
    };
    try {
      parsed = supabaseVerifySuccessV1Schema.parse(raw);
    } catch {
      // A success-status response that doesn't match the strict
      // schema is treated as a verification failure — the provider
      // is misbehaving and SoundHub refuses to invent identity.
      throw new IdentityVerificationFailedError(
        "Supabase verify response did not match the expected schema",
      );
    }
    if (!parsed.user || !parsed.user.id) {
      throw new IdentityVerificationFailedError("Supabase verify did not return a user identifier");
    }
    this.exchangedTokens.set(trimmed, this.now());
    const user = {
      id: parsed.user.id,
      email: parsed.user.email ?? null,
    };
    return {
      provider: this.providerKey,
      // The subject is the Supabase user id; it is opaque SoundHub
      // credential material and never crosses a public DTO.
      subject: user.id,
      providerEmail: user.email,
    };
  }

  private gcExchangedTokens(): void {
    const cutoff = this.now() - SINGLE_USE_TTL_MS;
    for (const [token, at] of this.exchangedTokens.entries()) {
      if (at < cutoff) this.exchangedTokens.delete(token);
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new IdentityProviderUnavailableError(
        "Managed magic-link adapter requires SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
  }
}
