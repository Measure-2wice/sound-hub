// Managed identity adapter contract tests.
//
// Background: BG1 requires a managed adapter that implements the
// same identity/session contract as the deterministic adapter.
// The ticket also requires a "bounded deployed-provider smoke"
// so the factory can fall back to the deterministic adapter when
// the managed path is unreachable. These tests pin the contract:
// every Supabase response is validated with a strict Zod schema,
// the SoundHub request handle is opaque, verify exchanges a real
// Supabase magic-link token, and a forged / replayed / malformed
// token cannot mint a session.

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
          requestId: "any-id",
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

  test("requestSignIn calls Supabase OTP and returns an opaque handle that does not carry identity", async () => {
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/otp",
      responses: [{ status: 200, body: {} }],
    });
    const adapter = configure({
      fetchImpl,
      emailRedirectTo: "http://localhost:3000/auth/callback",
    });
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    // Opaque SoundHub handle: prefixed with managed-pending- and
    // contains a UUID. It does NOT embed the email or any
    // identity claim.
    assert.match(result.requestId, /^managed-pending-[0-9a-f-]+$/);
    assert.equal(result.requestId.includes("buyer@example.com"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://example.supabase.co/auth/v1/otp");
    assert.equal(calls[0]!.init?.method, "POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.apikey, "anon-key");
    assert.equal(headers.Authorization, "Bearer service-role-key");
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}") as Record<string, unknown>;
    assert.equal(body.email, "buyer@example.com");
    assert.equal(body.create_user, true);
    assert.deepEqual(body.options, {
      emailRedirectTo: "http://localhost:3000/auth/callback",
    });
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

  test("requestSignIn fails closed when Supabase returns a malformed success payload", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/otp",
      responses: [{ status: 200, body: { unexpected: "field" } }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.requestSignIn({ email: "buyer@example.com" }),
      (err: unknown) => err instanceof Error,
    );
  });

  test("verifySignIn exchanges the Supabase token and derives identity from the verified response", async () => {
    const verifiedBody = {
      user: { id: "supabase-uuid-1", email: "buyer@example.com" },
    };
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    const token = "supabase-magic-link-token";
    const verified = await adapter.verifySignIn({ requestId: token });
    assert.ok(verified);
    assert.equal(verified.provider, "managed-magic-link");
    // The subject is the Supabase user id from the verified
    // response — NOT anything derived from the SoundHub request
    // handle.
    assert.equal(verified.subject, "supabase-uuid-1");
    assert.equal(verified.providerEmail, "buyer@example.com");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://example.supabase.co/auth/v1/verify");
    assert.equal(calls[0]!.init?.method, "POST");
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}") as Record<string, unknown>;
    assert.equal(body.token_hash, token);
    assert.equal(body.type, "magiclink");
  });

  test("verifySignIn rejects an empty request id without calling Supabase", async () => {
    const fetchImpl: typeof fetch = () => {
      throw new Error("Supabase must not be contacted for an empty request id");
    };
    const adapter = configure({ fetchImpl });
    assert.equal(await adapter.verifySignIn({ requestId: "" }), null);
    assert.equal(await adapter.verifySignIn({ requestId: "   " }), null);
  });

  test("verifySignIn rejects a fabricated token (Supabase returns 4xx)", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 401, body: { error: { message: "Invalid token" } } }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ requestId: "fabricated-token" }),
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
      () => adapter.verifySignIn({ requestId: "any-token" }),
      (err: unknown) =>
        err instanceof IdentityProviderUnavailableError && err.message.includes("Supabase is down"),
    );
  });

  test("verifySignIn rejects a token whose Supabase response is malformed", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: { user: { id: 123, email: "x@y" } } }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ requestId: "bad-response-token" }),
      (err: unknown) => err instanceof IdentityVerificationFailedError,
    );
  });

  test("verifySignIn rejects a token whose Supabase response is missing the user", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: { user: null } }],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ requestId: "null-user-token" }),
      (err: unknown) =>
        err instanceof IdentityVerificationFailedError && err.message.includes("user identifier"),
    );
  });

  test("verifySignIn rejects a token whose Supabase response has an empty user id", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: { user: { id: "", email: null } } }],
    });
    const adapter = configure({ fetchImpl });
    // An empty user id fails the schema's `min(1)` constraint,
    // so the failure mode is "response did not match the
    // expected schema" — both branches reject the token.
    await assert.rejects(
      () => adapter.verifySignIn({ requestId: "empty-id-token" }),
      (err: unknown) => err instanceof IdentityVerificationFailedError,
    );
  });

  test("verifySignIn rejects an unrelated provider response (extra fields)", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [
        {
          status: 200,
          body: {
            user: { id: "supabase-uuid-2", email: "buyer@example.com" },
            role: "service_role", // extra, non-schema field
          },
        },
      ],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ requestId: "drifted-token" }),
      (err: unknown) => err instanceof IdentityVerificationFailedError,
    );
  });

  test("verifySignIn is single-use: a successful verify rejects a replay", async () => {
    const verifiedBody = {
      user: { id: "supabase-uuid-3", email: "buyer@example.com" },
    };
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    const first = await adapter.verifySignIn({ requestId: "replay-token" });
    assert.ok(first);
    // Second verify with the same token must NOT call Supabase
    // again and must return null so a stolen token cannot mint
    // two sessions.
    const second = await adapter.verifySignIn({ requestId: "replay-token" });
    assert.equal(second, null);
    assert.equal(calls.length, 1, "Supabase must not be contacted twice for the same token");
  });

  test("verifySignIn normalizes a whitespace-padded token before exchange", async () => {
    const verifiedBody = {
      user: { id: "supabase-uuid-4", email: "buyer@example.com" },
    };
    const { fetchImpl, calls } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [{ status: 200, body: verifiedBody }],
    });
    const adapter = configure({ fetchImpl });
    const verified = await adapter.verifySignIn({ requestId: "  token-with-padding  " });
    assert.ok(verified);
    assert.equal(calls.length, 1);
    const body = JSON.parse((calls[0]!.init?.body as string) ?? "{}") as Record<string, unknown>;
    assert.equal(body.token_hash, "token-with-padding");
  });

  test("verifySignIn rejects a token whose Supabase response has an extra top-level field", async () => {
    const { fetchImpl } = makeFetch({
      url: "https://example.supabase.co/auth/v1/verify",
      responses: [
        {
          status: 200,
          body: {
            user: { id: "supabase-uuid-5", email: "buyer@example.com" },
            leaked_secret: "shhh",
          },
        },
      ],
    });
    const adapter = configure({ fetchImpl });
    await assert.rejects(
      () => adapter.verifySignIn({ requestId: "drift-token" }),
      (err: unknown) => err instanceof IdentityVerificationFailedError,
    );
  });
});
