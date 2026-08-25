// Bounded deployed-provider smoke tests.
//
// Background: the bounded smoke runs at startup and drives the
// factory's managed-vs-deterministic selection. These tests pin
// the smoke's three-step contract (health → request → verify)
// and verify the failure modes without a real network round-trip.

/* eslint-disable @typescript-eslint/no-floating-promises */

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

describe("runStartupSmoke", () => {
  test("returns ok:true when every step of the bounded smoke passes", async () => {
    const fetchImpl = makeFetch({
      responses: [
        // Step 1: health
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        // Step 2: OTP
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
        // Step 3: verify (bad token → 401)
        {
          url: "https://example.supabase.co/auth/v1/verify",
          status: 401,
          body: { error: { message: "Invalid token" } },
        },
      ],
    });
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, true);
  });

  test("returns ok:false (unconfigured) when env vars are missing", async () => {
    const managed = new ManagedIdentityAdapter({});
    const result = await runStartupSmoke({ managed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfigured");
  });

  test("returns ok:false when the health endpoint is non-2xx (P0-002)", async () => {
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

  test("returns ok:true when verify endpoint rejects the bad token with 4xx (expected failure mode)", async () => {
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
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, true);
  });

  test("returns ok:false when the verify endpoint returns 5xx", async () => {
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
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
  });

  test("returns ok:false (non-2xx) when the verify endpoint accepts a known-bad token", async () => {
    const fetchImpl = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
        // Supabase mistakenly accepts the bogus token — the smoke
        // flags this as a verification failure.
        {
          url: "https://example.supabase.co/auth/v1/verify",
          status: 200,
          body: { user: { id: "leaked-id", email: "leak@soundhub.example" } },
        },
      ],
    });
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "non-2xx");
  });
});
