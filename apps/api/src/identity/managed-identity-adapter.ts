// Managed (Supabase) identity adapter.
//
// Background: BG1 prefers managed email magic-link authentication
// (Supabase Auth) behind the provider-neutral identity interface.
// This adapter exchanges Supabase-issued magic-link tokens with
// Supabase's verify endpoint and derives the durable identity only
// from the verified provider response.
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
//      receives the Supabase-issued token (passed through the
//      browser's `?request_id=...` URL parameter) and exchanges it
//      with Supabase. The subject and email come ONLY from the
//      verified response — the SoundHub request handle is opaque
//      and never carries user identity. Replay is rejected via
//      single-use tracking.
//
//   3. Runtime validation at the Supabase JSON boundary. Per
//      AGENTS.md and the BG1 contract, untrusted provider payloads
//      are parsed with strict Zod schemas before they enter
//      identity derivation. A drifted or malformed payload fails
//      closed.
//
// The bounded smoke probes the configured Supabase project's auth
// endpoint so the composition root can fail fast and fall back to
// the deterministic adapter without leaving an unconfigured managed
// adapter selected. Per the ticket: "Provider unavailability never
// permits an authentication or authorization bypass."

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
// provider JSON boundaries. The schemas below are intentionally
// strict (extra fields rejected) so a drifted Supabase payload
// cannot enter identity derivation. Unknown success shapes and
// error shapes are both validated.

const supabaseUserV1Schema = z
  .object({
    id: z.string().min(1).max(128),
    email: z.string().email().nullable().optional(),
  })
  .strict();

const supabaseOtpSuccessV1Schema = z.union([
  z.object({}).strict(),
  z.object({ data: z.object({}).strict() }).strict(),
  z.null(),
]);

const supabaseOtpErrorV1Schema = z
  .object({
    error: z
      .object({
        message: z.string().min(1).max(1000),
      })
      .strict(),
  })
  .strict();

const supabaseVerifySuccessV1Schema = z
  .object({
    user: supabaseUserV1Schema.nullable(),
  })
  .strict();

const supabaseVerifyErrorV1Schema = z
  .object({
    error: z
      .object({
        message: z.string().min(1).max(1000),
      })
      .strict(),
  })
  .strict();

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
   * browser extracts it from the `?request_id=...` query string
   * and POSTs it to `/api/auth/verify-token`.
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
   */
  async requestSignIn(input: { readonly email: string }): Promise<SignInRequestResult> {
    this.assertConfigured();
    const url = `${this.options.supabaseUrl}/auth/v1/otp`;
    const body: Record<string, unknown> = {
      email: input.email,
      create_user: true,
    };
    if (this.options.emailRedirectTo) {
      body.options = { emailRedirectTo: this.options.emailRedirectTo };
    }
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
    // Parse with the strict schema so a drifted payload fails
    // closed before we trust the email delivery. The parsed
    // payload itself is unused (Supabase's OTP success body is
    // empty); we only need it to fail loudly on drift.
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
      requestId: `managed-pending-${randomUUID()}`,
    };
  }

  /**
   * Exchange a Supabase-issued magic-link token with Supabase's
   * verify endpoint and derive the canonical identity from the
   * verified response. The browser extracts the Supabase token
   * from the email callback URL (typically `?request_id=<token>`)
   * and POSTs it to `/api/auth/verify-token` as `requestId`. The
   * token is treated as a Supabase credential — never as a
   * SoundHub-side authorization handle.
   *
   * Returns `null` for replayed, expired, or invalid tokens. The
   * SoundHub request id format is intentionally irrelevant here;
   * we forward whatever the browser sent to Supabase's verify
   * endpoint, and Supabase's response is the only source of
   * identity.
   */
  async verifySignIn(input: { readonly requestId: string }): Promise<VerifiedIdentity | null> {
    this.assertConfigured();
    const token = input.requestId.trim();
    if (!token) return null;
    // Replay protection: a Supabase token already exchanged cannot
    // mint a second SoundHub session. The token TTL is bounded so
    // the cache cannot grow without limit.
    this.gcExchangedTokens();
    if (this.exchangedTokens.has(token)) return null;

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
        body: JSON.stringify({ token_hash: token, type: "magiclink" }),
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
    let parsed: { user: { id: string; email?: string | null | undefined } | null };
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
    this.exchangedTokens.set(token, this.now());
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
