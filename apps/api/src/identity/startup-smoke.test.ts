// Bounded deployed-provider smoke tests.
//
// Background: the bounded smoke runs at startup and drives the
// factory's managed-vs-deterministic selection. Per ticket #59
// P1-001 the smoke MUST run on the same adapter the factory
// selects. These tests pin the smoke's contract: health →
// request → verify with operator-injected captured token →
// SoundHub server-side session round-trip. The smoke is
// FAIL-CLOSED — `ok: true` is only returned after EVERY step
// succeeds, including the application-boundary session probe
// (ticket #59 P1-001).
//
// Per ticket #59 P2-001 the captured token is the PRIVATE
// `verificationToken` extracted from the magic-link callback URL.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ManagedIdentityAdapter } from "./managed-identity-adapter.js";
import { runStartupSmoke } from "./startup-smoke.js";

interface FetchScenario {
  readonly responses: ReadonlyArray<{
    readonly url: string;
    readonly status: number;
    readonly body?: unknown;
  }>;
}

function makeFetch(scenario: FetchScenario): typeof fetch {
  let index = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const response = scenario.responses[Math.min(index, scenario.responses.length - 1)]!;
    if (!url.startsWith(response.url)) {
      throw new Error(`unexpected fetch call to ${url}`);
    }
    index += 1;
    void init;
    return Promise.resolve(
      new Response(JSON.stringify(response.body ?? {}), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  return fetchImpl;
}

function configure(overrides: { fetchImpl?: typeof fetch } = {}) {
  return new ManagedIdentityAdapter({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon-key",
    supabaseServiceRoleKey: "service-role-key",
    fetchImpl: overrides.fetchImpl,
  });
}

/**
 * Realistic Supabase verify envelope (per ticket #59 P1-001) —
 * mirrors the documented response shape including `expires_at`
 * and other forward-compatible fields.
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
    user: { id: overrides.id, email: overrides.email },
  };
}

describe("runStartupSmoke", () => {
  test("returns ok:true only when every step (health, otp, verify, session probe) succeeds (P1-001)", async () => {
    const fetchImpl = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
        {
          url: "https://example.supabase.co/auth/v1/verify",
          status: 200,
          body: supabaseVerifyEnvelope({
            id: "captured-user-id",
            email: "buyer@soundhub.example",
          }),
        },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      verifyToken: "captured-verification-token",
      sessionProbe: async () => ({ ok: true, userAccountId: "ua-1", sessionId: "sess-1" }),
    });
    assert.equal(result.ok, true);
    assert.ok(result.detail?.includes("captured-user-id"));
    assert.ok(result.detail?.includes("sess-1"));
  });

  test("returns ok:false (unconfigured) when env vars are missing", async () => {
    const managed = new ManagedIdentityAdapter({});
    const result = await runStartupSmoke({ managed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfigured");
  });

  test("returns ok:false when the health endpoint is non-2xx", async () => {
    const fetchImpl = makeFetch({
      responses: [
        {
          url: "https://example.supabase.co/auth/v1/health",
          status: 503,
          body: { error: "down" },
        },
      ],
    });
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "non-2xx");
  });

  test("returns ok:false when the OTP endpoint network fails", async () => {
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.endsWith("/auth/v1/health")) {
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.reject(new Error("ECONNREFUSED"));
    };
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
    assert.ok(result.detail?.includes("ECONNREFUSED"));
  });

  test("returns ok:false when the OTP endpoint returns 5xx", async () => {
    const fetchImpl = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        {
          url: "https://example.supabase.co/auth/v1/otp",
          status: 500,
          body: { error: { message: "Internal error" } },
        },
      ],
    });
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
  });

  test("returns ok:false (session-coverage-incomplete) when no operator token is supplied (P1-001)", async () => {
    // Per ticket #59 P1-001 the smoke is FAIL-CLOSED. Without an
    // operator-supplied captured verification token the smoke
    // cannot prove the callback / session integration and the
    // factory must select the deterministic fallback. A
    // successful magic-link request alone is NOT enough.
    const fetchImpl = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("BG1_SMOKE_TEST_TOKEN"));
  });

  test("returns ok:false (session-coverage-incomplete) when the session probe is missing (P1-001)", async () => {
    // The verify step succeeded with the operator-injected token
    // but no session probe was supplied — the smoke cannot prove
    // the SoundHub server-side session issuance and the factory
    // must select the deterministic fallback.
    const fetchImpl = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
        {
          url: "https://example.supabase.co/auth/v1/verify",
          status: 200,
          body: supabaseVerifyEnvelope({ id: "u", email: "buyer@soundhub.example" }),
        },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      verifyToken: "captured-verification-token",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
  });

  test("returns ok:false (session-coverage-incomplete) when the session probe reports failure (P1-001)", async () => {
    const fetchImpl = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
        {
          url: "https://example.supabase.co/auth/v1/verify",
          status: 200,
          body: supabaseVerifyEnvelope({ id: "u", email: "buyer@soundhub.example" }),
        },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      verifyToken: "captured-verification-token",
      sessionProbe: async () => ({ ok: false, detail: "resolveSession returned null" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("resolveSession"));
  });

  test("returns ok:false (non-2xx) when Supabase rejects the operator-injected captured token (P1-001)", async () => {
    const fetchImpl = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
        {
          url: "https://example.supabase.co/auth/v1/verify",
          status: 401,
          body: { error: { message: "Token has expired or is invalid" } },
        },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      verifyToken: "stale-captured-token",
      sessionProbe: async () => ({ ok: true }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "non-2xx");
  });

  test("returns ok:false (network) when the verify endpoint returns 5xx with an operator token (P1-001)", async () => {
    const fetchImpl = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
        {
          url: "https://example.supabase.co/auth/v1/verify",
          status: 500,
          body: { error: { message: "Internal error" } },
        },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      verifyToken: "captured-token",
      sessionProbe: async () => ({ ok: true }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
  });

  test("returns ok:false when the captured token resolves to a non-envelope response (P0-002 strict parser)", async () => {
    const fetchImpl = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
        // Supabase replies with a reduced shape that lacks the
        // documented access-token / session envelope fields —
        // the parser rejects it.
        {
          url: "https://example.supabase.co/auth/v1/verify",
          status: 200,
          body: { user: { id: "leaked-id", email: "leak@soundhub.example" } },
        },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      verifyToken: "captured-token",
      sessionProbe: async () => ({ ok: true }),
    });
    assert.equal(result.ok, false);
  });
});
