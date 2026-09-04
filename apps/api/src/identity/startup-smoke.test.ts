// Bounded deployed-provider configuration smoke tests.
//
// Background: the bounded smoke runs at startup and drives the
// factory's managed-vs-deterministic selection. Per ticket #59
// the smoke is a bounded, non-destructive configuration probe —
// it does NOT request, consume, or revoke a live Supabase OTP.
// End-to-end managed email verification is validated by the
// bounded operational smoke procedure documented at
// `docs/deployment/managed-provider-smoke.md`, not by
// application startup.
//
// Per ticket #59 the smoke MUST run on the same adapter the
// factory selects. These tests pin the smoke's contract: the
// smoke is FAIL-CLOSED — `ok: true` is only returned when the
// configured Supabase project's `/auth/v1/health` endpoint
// responds 2xx within the bounded timeout, and the smoke
// itself never contacts the OTP or verify endpoints.

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

function makeFetch(scenario: FetchScenario): {
  readonly calls: string[];
  readonly fetchImpl: typeof fetch;
} {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const response = scenario.responses[Math.min(index, scenario.responses.length - 1)]!;
    if (!url.startsWith(response.url)) {
      throw new Error(`unexpected fetch call to ${url}`);
    }
    calls.push(url);
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

function configure(overrides: { fetchImpl?: typeof fetch } = {}) {
  return new ManagedIdentityAdapter({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "anon-key",
    supabaseServiceRoleKey: "service-role-key",
    emailRedirectTo: "https://app.example.com/auth/callback",
    fetchImpl: overrides.fetchImpl,
  });
}

describe("runStartupSmoke", () => {
  test("returns ok:true when the Supabase health endpoint replies 2xx", async () => {
    const { fetchImpl, calls } = makeFetch({
      responses: [{ url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} }],
    });
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, true);
    assert.ok(
      calls.every((url) => url.endsWith("/auth/v1/health")),
      "smoke must not call /auth/v1/otp or /auth/v1/verify",
    );
  });

  test("returns ok:false (unconfigured) when env vars are missing", async () => {
    const managed = new ManagedIdentityAdapter({});
    const result = await runStartupSmoke({ managed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfigured");
  });

  test("returns ok:false (non-2xx) when the health endpoint is unavailable", async () => {
    const { fetchImpl } = makeFetch({
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

  test("returns ok:false (network) when the health endpoint network fails", async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
    assert.ok(result.detail?.includes("ECONNREFUSED"));
  });

  test("the smoke never contacts the OTP or verify endpoints", async () => {
    // Per ticket #59 the bounded configuration smoke MUST NOT
    // request, consume, or revoke a live Supabase OTP. Any
    // contact with the OTP or verify endpoints during startup
    // smoke is a regression. The smoke also MUST NOT log
    // bearer session identifiers, access tokens, refresh
    // tokens, OTPs, token hashes, or verification credentials.
    const capturedLogs: string[] = [];
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;
    console.error = (...args: unknown[]) => {
      capturedLogs.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    };
    console.log = (...args: unknown[]) => {
      capturedLogs.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    };
    const { fetchImpl, calls } = makeFetch({
      responses: [{ url: "https://example.supabase.co/auth/v1/health", status: 500, body: {} }],
    });
    try {
      const result = await runStartupSmoke({ managed: configure({ fetchImpl }) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "non-2xx");
      assert.ok(
        calls.every((url) => url.endsWith("/auth/v1/health")),
        "smoke must not call /auth/v1/otp or /auth/v1/verify",
      );
      // Per ticket #59 P0-002 cleanup/auth failures may log only
      // safe correlation identifiers (e.g. provider name, reason
      // classification); they MUST NOT log bearer session ids,
      // access tokens, refresh tokens, OTPs, token hashes, or
      // verification credentials.
      const combinedLogs = capturedLogs.join("\n");
      assert.equal(
        combinedLogs.includes("sess-"),
        false,
        "smoke logs must not embed bearer session identifiers",
      );
      assert.equal(
        combinedLogs.includes("access-token-fixture"),
        false,
        "smoke logs must not embed access tokens",
      );
      assert.equal(
        combinedLogs.includes("refresh-token-fixture"),
        false,
        "smoke logs must not embed refresh tokens",
      );
      assert.equal(
        combinedLogs.includes("verificationToken"),
        false,
        "smoke logs must not embed verification credentials",
      );
    } finally {
      console.error = originalConsoleError;
      console.log = originalConsoleLog;
    }
  });
});
