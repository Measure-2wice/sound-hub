// Managed identity adapter contract tests.
//
// Background: BG1 requires a managed adapter that implements the
// same identity/session contract as the deterministic adapter.
// The ticket also requires a "bounded deployed-provider smoke"
// so the factory can fall back to the deterministic adapter when
// the managed path is unreachable. These tests pin the contract:
// every Supabase response is validated with a forward-compatible
// Zod schema, the SoundHub request handle is opaque, verify
// exchanges a real Supabase magic-link token, and a forged /
// replayed / malformed token cannot mint a session.
//
// Per ticket #59 P0-002 the adapter pins the official Supabase
// REST contract:
//   - the magic-link OTP request uses `redirect_to` as a query
//     parameter on the URL (not a body field);
//   - the verify request posts `type: "email"` (the type Supabase
//     publishes for current token-hash verification);
//   - the verify success response parses the real access-token /
//     session envelope Supabase returns, with only the allow-listed
//     `id` and `email` extracted into SoundHub identity.
//
// Per ticket #59 P1-001 the provider-response parser is
// FORWARD-COMPATIBLE with documented Supabase fields (e.g.
// `expires_at`, `provider_token`, future additions). The PUBLIC
// SoundHub contract remains strict — only identity derivation
// reads the allow-listed fields and the parsed provider envelope
// is discarded after identity is established.
//
// Per ticket #59 P2-001 `verifySignIn` accepts the PRIVATE
// one-time `verificationToken` (the value the browser extracted
// from the magic-link callback URL). The PUBLIC correlation id
// returned by `requestSignIn` is NOT accepted here.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ManagedIdentityAdapter, type SmokeResult } from "./managed-identity-adapter.js";
import {
  IdentityProviderUnavailableError,
  IdentityVerificationFailedError,
} from "./identity-adapter.js";

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}

interface FetchScenario {
  readonly url: string;
  readonly responses: ReadonlyArray<{
    readonly status: number;
    readonly body?: unknown;
  }>;
}

function makeFetch(scenario: FetchScenario): {
  readonly calls: FetchCall[];
  readonly fetchImpl: typeof fetch;
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (!url.startsWith(scenario.url)) {
      throw new Error(`unexpected fetch call to ${url}`);
    }
    calls.push({ url, init });
    const response = scenario.responses[Math.min(index, scenario.responses.length - 1)]!;
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(response.body ?? {}), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return { calls, fetchImpl };
}

function configure(
  overrides: Partial<ConstructorParameters<typeof ManagedIdentityAdapter>[0]> = {},
) {
  return new ManagedIdentityAdapter({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon-key",
    supabaseServiceRoleKey: "service-role-key",
    ...overrides,
  });
}

/**
 * A realistic Supabase `/auth/v1/verify` success envelope. Per
 * ticket #59 P1-001 the fixture mirrors the fields Supabase
 * publishes (including documented extras like `expires_at`,
 * `provider_token`, `provider_refresh_token`) so the parser is
 * exercised against the contract the deployed environment will
 * return. Identity derivation only reads `id` and `email` from
 * the parsed user — every other field is discarded after
 * identity is established.
 */
function supabaseVerifyEnvelope(overrides: {
  readonly id: string;
  readonly email: string | null;
}): Record<string, unknown> {
  return {
    access_token: "access-token-fixture",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "refresh-token-fixture",
    provider_token: "provider-access-token-fixture",
    provider_refresh_token: "provider-refresh-token-fixture",
    user: {
      id: overrides.id,
      aud: "authenticated",
      role: "authenticated",
      email: overrides.email,
      email_confirmed_at: "2025-01-01T00:00:00.000Z",
      phone: "",
      confirmed_at: "2025-01-01T00:00:00.000Z",
      last_sign_in_at: "2025-01-01T00:00:00.000Z",
      app_metadata: { provider: "email" },
      user_metadata: {},
      identities: [],
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    },
  };
}

describe("ManagedIdentityAdapter", () => {
  test("isConfigured reports whether every required env var is present", () => {
    assert.equal(new ManagedIdentityAdapter({}).isConfigured(), false);
    assert.equal(configure({ supabaseUrl: undefined }).isConfigured(), false);
    assert.equal(configure().isConfigured(), true);
  });

  test("the adapter's provider key is 'managed-magic-link'", () => {
    assert.equal(configure().providerKey, "managed-magic-link");
  });

  test("a partially-configured adapter is still treated as unconfigured", () => {
    const partial = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
    });
    assert.equal(partial.isConfigured(), false);
  });

  test("requestSignIn throws IdentityProviderUnavailableError when not configured", async () => {
    await assert.rejects(
      () => new ManagedIdentityAdapter({}).requestSignIn({ email: "buyer@example.com" }),
      (err: unknown) => err instanceof IdentityProviderUnavailableError,
    );
  });

  test("verifySignIn throws IdentityProviderUnavailableError when not configured", async () => {
    await assert.rejects(
      () =>
        new ManagedIdentityAdapter({}).verifySignIn({
          verificationToken: "any-token",
        }),
      (err: unknown) => err instanceof IdentityProviderUnavailableError,
    );
  });

  test("smoke returns ok:true when the Supabase health endpoint replies 2xx", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/health",
      responses: [{ status: 200, body: { status: "ok" } }],
    });
    const adapter = configure({ fetchImpl });
    const result = await adapter.smoke();
    assert.deepEqual(result, { ok: true } satisfies SmokeResult);
  });

  test("smoke returns ok:false (unconfigured) when env vars are missing", async () => {
    const result = await new ManagedIdentityAdapter({}).smoke();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfigured");
  });

  test("smoke returns ok:false (non-2xx) when the Supabase health endpoint replies 5xx", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/health",
      responses: [{ status: 503, body: { error: "unavailable" } }],
    });
    const result = await configure({ fetchImpl }).smoke();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "non-2xx");
  });

  test("smoke returns ok:false (network) when the fetch implementation throws", async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const result = await configure({ fetchImpl }).smoke();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
    assert.ok(result.detail?.includes("ECONNREFUSED"));
  });

  test("smoke is bounded by the timeout configuration", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const result = await configure({ fetchImpl, smokeTimeoutMs: 25 }).smoke();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
  });

  test("requestSignIn returns a public correlationId under the documented field name (P2-001)", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/otp",
      responses: [{ status: 200, body: {} }],
    });
    const adapter = configure({ fetchImpl });
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    // Per P2-001 the adapter returns a `correlationId` field
    // (public, observability-only). The managed adapter never
    // returns a `verificationToken` — Supabase owns the one-time
    // credential and surfaces it in the magic-link callback URL
    // the browser extracts.
    assert.match(result.correlationId, /^managed-pending-[0-9a-f-]+$/);
    assert.equal(result.correlationId.includes("buyer@example.com"), false);
    assert.equal(result.verificationToken, undefined);
  });

  test("requestSignIn sends the OTP body with `redirect_to` as a query parameter (P0-002)", async () => {
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/otp",
      responses: [{ status: 200, body: {} }],
    });
    const adapter = configure({
      fetchImpl,
      emailRedirectTo: "http://localhost:3000/auth/callback",
    });
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.match(result.correlationId, /^managed-pending-[0-9a-f-]+$/);
    assert.equal(result.correlationId.includes("buyer@example.com"), false);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      "https://example.supabase.co/auth/v1/otp?redirect_to=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback",
    );
    assert.equal(calls[0]!.init?.method, "POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.apikey, "anon-key");
    assert.equal(headers.Authorization, "Bearer service-role-key");
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}") as Record<string, unknown>;
    // Body shape per Supabase REST: only email + create_user.
    assert.equal(body.email, "buyer@example.com");
    assert.equal(body.create_user, true);
    assert.equal("options" in body, false, "redirect must NOT be a body field");
    assert.equal("redirect_to" in body, false, "redirect must NOT be a body field");
  });

  test("requestSignIn omits the redirect_to query when no emailRedirectTo is configured", async () => {
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/otp",
      responses: [{ status: 200, body: {} }],
    });
    const adapter = configure({ fetchImpl });
    await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://example.supabase.co/auth/v1/otp");
  });

  test("requestSignIn surfaces Supabase's error message on non-2xx", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/otp",
      responses: [{ status: 422, body: { error: { message: "Email rate limit exceeded" } } }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.requestSignIn({ email: "buyer@example.com" }),
      (err: unknown) =>
        err instanceof IdentityProviderUnavailableError && err.message.includes("rate limit"),
    );
  });

  test("requestSignIn fails closed when Supabase returns a non-object success payload", async () => {
    // Per P1-001 the parser tolerates documented extra top-level
    // fields (e.g. `expires_at`); a clearly malformed payload
    // (non-object / non-null, like a bare string or array) still
    // fails closed so a drifted Supabase contract does not silently
    // mint a session.
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/otp",
      responses: [
        {
          status: 200,
          body: "not-an-object",
        },
      ],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.requestSignIn({ email: "buyer@example.com" }),
      (err: unknown) => err instanceof Error,
    );
  });

  test("requestSignIn tolerates documented extra top-level fields in the success payload (P1-001)", async () => {
    // The forward-compatible parser must accept Supabase success
    // bodies that carry documented extras (e.g. a future
    // `expires_at` at the top level) so a normal provider
    // response is not silently rejected.
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/otp",
      responses: [
        {
          status: 200,
          body: { data: {}, user: null },
        },
      ],
    });
    const adapter = configure({ fetchImpl });
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.match(result.correlationId, /^managed-pending-[0-9a-f-]+$/);
  });

  test('verifySignIn exchanges the Supabase token with type:"email" and parses the real envelope (P0-002)', async () => {
    const verifiedBody = supabaseVerifyEnvelope({
      id: "supabase-uuid-1",
      email: "buyer@example.com",
    });
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    const token = "supabase-magic-link-token";
    const verified = await adapter.verifySignIn({ verificationToken: token });
    assert.ok(verified);
    assert.equal(verified.provider, "managed-magic-link");
    assert.equal(verified.subject, "supabase-uuid-1");
    assert.equal(verified.providerEmail, "buyer@example.com");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://example.supabase.co/auth/v1/verify");
    assert.equal(calls[0]!.init?.method, "POST");
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}") as Record<string, unknown>;
    assert.equal(body.token_hash, token);
    assert.equal(body.type, "email", "current Supabase verify uses type:email");
  });

  test("verifyType is parameterized for future Supabase OpenAPI drift (P0-002)", async () => {
    const verifiedBody = supabaseVerifyEnvelope({
      id: "supabase-uuid-2",
      email: "buyer@example.com",
    });
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl,
      verifyType: "magiclink",
    });
    await adapter.verifySignIn({ verificationToken: "legacy-token" });
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}") as Record<string, unknown>;
    assert.equal(body.type, "magiclink");
  });

  test("verifySignIn tolerates documented Supabase response fields like expires_at (P1-001)", async () => {
    // Per ticket #59 P1-001 the parser must be
    // FORWARD-COMPATIBLE with documented Supabase response
    // fields. The fixture mirrors the realistic shape the
    // deployed environment will return (including `expires_at`,
    // `provider_token`, `provider_refresh_token`); the parser
    // accepts the envelope and identity derivation only reads
    // the allow-listed `id` and `email`.
    const verifiedBody = supabaseVerifyEnvelope({
      id: "supabase-uuid-forward-compatible",
      email: "buyer@example.com",
    });
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    const verified = await adapter.verifySignIn({ verificationToken: "captured-token" });
    assert.ok(verified);
    assert.equal(verified.subject, "supabase-uuid-forward-compatible");
    assert.equal(verified.providerEmail, "buyer@example.com");
  });

  test("verifySignIn rejects an empty verification token without calling Supabase", async () => {
    const fetchImpl: typeof fetch = () => {
      throw new Error("Supabase must not be contacted for an empty verification token");
    };
    const adapter = configure({ fetchImpl });
    assert.equal(await adapter.verifySignIn({ verificationToken: "" }), null);
    assert.equal(await adapter.verifySignIn({ verificationToken: "   " }), null);
  });

  test("verifySignIn rejects a fabricated token (Supabase returns 4xx)", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 401, body: { error: { message: "Invalid token" } } }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ verificationToken: "fabricated-token" }),
      (err: unknown) =>
        err instanceof IdentityVerificationFailedError && err.message.includes("Invalid token"),
    );
  });

  test("verifySignIn classifies a 5xx response as provider unavailability (P0-002)", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 503, body: { error: { message: "Supabase is down" } } }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ verificationToken: "any-token" }),
      (err: unknown) =>
        err instanceof IdentityProviderUnavailableError && err.message.includes("Supabase is down"),
    );
  });

  test("verifySignIn fails closed when Supabase returns the reduced legacy shape (P0-002)", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      // Missing required access_token / token_type / refresh_token
      // fields — even with the forward-compatible parser, a
      // response that lacks the documented envelope fields is
      // rejected.
      responses: [{ status: 200, body: { user: { id: "x", email: "y@z" } } }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ verificationToken: "legacy-shape-token" }),
      (err: unknown) => err instanceof IdentityVerificationFailedError,
    );
  });

  test("verifySignIn rejects a token whose Supabase response is missing the user", async () => {
    const verifiedBody = supabaseVerifyEnvelope({ id: "supabase-uuid-3", email: "x@y" });
    verifiedBody.user = null;
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ verificationToken: "null-user-token" }),
      (err: unknown) =>
        err instanceof IdentityVerificationFailedError && err.message.includes("user identifier"),
    );
  });

  test("verifySignIn rejects a token whose Supabase response has an empty user id", async () => {
    const verifiedBody = supabaseVerifyEnvelope({ id: "supabase-uuid-4", email: null });
    verifiedBody.user = { id: "", email: null };
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ verificationToken: "empty-id-token" }),
      (err: unknown) => err instanceof IdentityVerificationFailedError,
    );
  });

  test("verifySignIn rejects an extra field inside the user object (P0-002 strict user parser)", async () => {
    const verifiedBody = supabaseVerifyEnvelope({
      id: "supabase-uuid-6",
      email: "buyer@example.com",
    });
    // The user-shape schema is `.strict()` so unknown inner
    // fields are rejected (the public SoundHub contract must
    // not silently accept arbitrary provider claims).
    (verifiedBody.user as Record<string, unknown>).custom_provider_claim = "service_role";
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ verificationToken: "drifted-token" }),
      (err: unknown) => err instanceof IdentityVerificationFailedError,
    );
  });

  test("verifySignIn is single-use: a successful verify rejects a replay", async () => {
    const verifiedBody = supabaseVerifyEnvelope({
      id: "supabase-uuid-7",
      email: "buyer@example.com",
    });
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    const first = await adapter.verifySignIn({ verificationToken: "replay-token" });
    assert.ok(first);
    const second = await adapter.verifySignIn({ verificationToken: "replay-token" });
    assert.equal(second, null);
    assert.equal(calls.length, 1, "Supabase must not be contacted twice for the same token");
  });

  test("verifySignIn normalizes a whitespace-padded token before exchange", async () => {
    const verifiedBody = supabaseVerifyEnvelope({
      id: "supabase-uuid-8",
      email: "buyer@example.com",
    });
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    const verified = await adapter.verifySignIn({ verificationToken: "  token-with-padding  " });
    assert.ok(verified);
    assert.equal(calls.length, 1);
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}") as Record<string, unknown>;
    assert.equal(body.token_hash, "token-with-padding");
  });
});
