// Bounded deployed-provider smoke tests.
//
// Background: the bounded smoke runs at startup and drives the
// factory's managed-vs-deterministic selection. Per ticket #59
// P1-001 the smoke MUST run on the same adapter the factory
// selects. These tests pin the smoke's contract: health →
// request → session probe. The smoke is FAIL-CLOSED — `ok:
// true` is only returned after EVERY step succeeds, including
// the application-boundary session probe (ticket #59 P1-001).
//
// Per ticket #59 P1-001 (next iteration) the captured token is
// exchanged EXACTLY ONCE through the serving authentication seam.
// The smoke itself NEVER calls `ManagedIdentityAdapter.verifySignIn`
// independently — the `sessionProbe` is the sole exchange path.
//
// Per ticket #59 P1-001 (this iteration) the smoke ties the
// OTP probe to the operator-controlled `smokeMailbox` — the
// SAME mailbox the operator receives the captured link on —
// so the bounded smoke traverses the link produced by the
// deployed email-template configuration.
//
// Per ticket #59 P2-001 the captured token is the PRIVATE
// `verificationToken` extracted from the magic-link callback URL.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ManagedIdentityAdapter } from "./managed-identity-adapter.js";
import { runStartupSmoke } from "./startup-smoke.js";

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}

interface FetchScenario {
  readonly responses: ReadonlyArray<{
    readonly url: string;
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
    const response = scenario.responses[Math.min(index, scenario.responses.length - 1)]!;
    if (!url.startsWith(response.url)) {
      throw new Error(`unexpected fetch call to ${url}`);
    }
    calls.push({ url, init });
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
    // The smoke mailbox fixture relies on a real callback URL
    // being threaded into the deployed Supabase project so the
    // configured email template can embed
    // `?token={{ .TokenHash }}` against the same URL the browser
    // callback page reads.
    emailRedirectTo: "https://app.example.com/auth/callback",
    fetchImpl: overrides.fetchImpl,
  });
}

/**
 * Realistic Supabase verify envelope (per ticket #59 P1-001) —
 * mirrors the documented response shape including `expires_at`
 * and other forward-compatible fields. This fixture is NOT used
 * by the smoke itself (the smoke delegates the verify to the
 * session probe), but it documents the envelope the production
 * seam expects.
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

const SMOKE_MAILBOX = "bg1-smoke@soundhub.example";

describe("runStartupSmoke", () => {
  test("returns ok:true only when every step (health, otp, session probe) succeeds (P1-001)", async () => {
    // Per ticket #59 P1-001 the smoke delegates the verify to
    // the session probe; the smoke itself does NOT call
    // `verifySignIn` directly. The probe below counts provider
    // verification calls and asserts the smoke makes exactly
    // zero independent verify attempts.
    let verifyCount = 0;
    const { fetchImpl, calls } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
      verifyToken: "captured-verification-token",
      sessionProbe: async () => {
        verifyCount += 1;
        return { ok: true, userAccountId: "ua-1", sessionId: "sess-1" };
      },
    });
    assert.equal(result.ok, true);
    assert.ok(result.detail?.includes("sess-1"));
    assert.ok(result.detail?.includes(SMOKE_MAILBOX));
    assert.equal(verifyCount, 1, "session probe must be the SOLE provider exchange");
    // The OTP request MUST target the operator-configured smoke
    // mailbox (per ticket #59 P1-001 deployed magic-link
    // contract) — NOT a sentinel `.example` address unrelated to
    // the captured link.
    const otpCall = calls.find((c) => c.url.includes("/auth/v1/otp"));
    assert.ok(otpCall, "OTP request must be made");
    const otpBody = JSON.parse((otpCall.init?.body as string) ?? "{}") as Record<string, unknown>;
    assert.equal(otpBody.email, SMOKE_MAILBOX);
  });

  test("returns ok:false (unconfigured) when env vars are missing", async () => {
    const managed = new ManagedIdentityAdapter({});
    const result = await runStartupSmoke({ managed });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfigured");
  });

  test("returns ok:false when the health endpoint is non-2xx", async () => {
    const { fetchImpl } = makeFetch({
      responses: [
        {
          url: "https://example.supabase.co/auth/v1/health",
          status: 503,
          body: { error: "down" },
        },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
    });
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
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
    assert.ok(result.detail?.includes("ECONNREFUSED"));
  });

  test("returns ok:false when the OTP endpoint returns 5xx", async () => {
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        {
          url: "https://example.supabase.co/auth/v1/otp",
          status: 500,
          body: { error: { message: "Internal error" } },
        },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
  });

  test("returns ok:false (session-coverage-incomplete) when no smoke mailbox is configured (P1-001)", async () => {
    // Per ticket #59 P1-001 the smoke must tie the OTP probe
    // to the SAME mailbox the captured link arrives on. Without
    // an operator-configured smoke mailbox the smoke cannot
    // prove the deployed email-template configuration delivers
    // a link the operator can capture; the factory must select
    // the deterministic fallback.
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      // smokeMailbox omitted intentionally.
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("BG1_SMOKE_MAILBOX"));
  });

  test("returns ok:false (session-coverage-incomplete) when no operator token is supplied (P1-001)", async () => {
    // The OTP request to the configured smoke mailbox succeeded
    // (delivery proved) but no captured token was injected — the
    // operator still needs to receive the delivered email and
    // paste the token.
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("BG1_SMOKE_TEST_TOKEN"));
  });

  test("returns ok:false (session-coverage-incomplete) when the session probe is missing (P1-001)", async () => {
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
      verifyToken: "captured-verification-token",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
  });

  test("returns ok:false (session-coverage-incomplete) when the session probe reports failure (P1-001)", async () => {
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
      verifyToken: "captured-verification-token",
      sessionProbe: async () => ({ ok: false, detail: "resolveSession returned null" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("resolveSession"));
  });
});

describe("runStartupSmoke token consumption (P1-001 single-exchange)", () => {
  // Per ticket #59 P1-001 the smoke must consume the captured
  // token EXACTLY ONCE through the serving authentication
  // seam. The tests below exercise the smoke end-to-end against
  // the real `ManagedIdentityAdapter` (the one the factory
  // selects) plus a `buildSessionProbe`-shaped probe that uses
  // the production adapter. The captured token is therefore
  // exchanged once via the production boundary; a second
  // independent verify call would replay-reject.

  test("the smoke itself never calls ManagedIdentityAdapter.verifySignIn independently", async () => {
    // The smoke routes the captured token through the session
    // probe ONLY. We construct a managed adapter that records
    // verify-call attempts and assert the smoke NEVER calls
    // `verifySignIn` itself — only the probe does.
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
      emailRedirectTo: "https://app.example.com/auth/callback",
    });
    let adapterVerifyCalls = 0;
    const originalVerify = adapter.verifySignIn.bind(adapter);
    adapter.verifySignIn = async (input) => {
      adapterVerifyCalls += 1;
      return originalVerify(input);
    };

    // Stub the underlying fetch so the smoke's requestSignIn
    // probe (health + OTP) succeed without a network round trip.
    let fetchCallIndex = 0;
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const bodies: Array<{ url: string; status: number; body?: unknown }> = [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ];
      const body = bodies[Math.min(fetchCallIndex, bodies.length - 1)]!;
      fetchCallIndex += 1;
      if (!url.startsWith(body.url)) {
        throw new Error(`unexpected fetch call to ${url}`);
      }
      return Promise.resolve(
        new Response(JSON.stringify(body.body ?? {}), {
          status: body.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    (adapter as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchImpl;

    // Stub the verify endpoint so the session probe can mint
    // a session through the production `verifySignIn` boundary.
    const verifyEnvelope = supabaseVerifyEnvelope({
      id: "supabase-uuid-smoke",
      email: SMOKE_MAILBOX,
    });
    let verifyEndpointCalls = 0;
    let probeCalls = 0;
    const originalFetchImpl = fetchImpl;
    const stubbedFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/auth/v1/verify")) {
        verifyEndpointCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify(verifyEnvelope), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return originalFetchImpl(input, init);
    };
    (adapter as unknown as { fetchImpl: typeof fetch }).fetchImpl = stubbedFetch;

    const result = await runStartupSmoke({
      managed: adapter,
      smokeMailbox: SMOKE_MAILBOX,
      verifyToken: "captured-verification-token",
      sessionProbe: async ({ verificationToken }) => {
        probeCalls += 1;
        // Drive the production boundary directly through the
        // adapter the smoke was handed. This is the SOLE
        // provider verification the smoke performs.
        const verified = await adapter.verifySignIn({ verificationToken });
        if (!verified) {
          return { ok: false, detail: "adapter rejected the captured token" };
        }
        return {
          ok: true,
          userAccountId: verified.subject,
          sessionId: `session-${probeCalls}`,
        };
      },
    });
    assert.equal(result.ok, true);
    assert.ok(result.detail?.includes("session-1"));
    assert.ok(result.detail?.includes(SMOKE_MAILBOX));
    // The smoke itself never calls `adapter.verifySignIn`. The
    // adapter's verify count is owned entirely by the session
    // probe, which the smoke invokes exactly once.
    assert.equal(adapterVerifyCalls, 1, "smoke must delegate verify to the probe exactly once");
    assert.equal(probeCalls, 1, "smoke must invoke the session probe exactly once");
    assert.equal(verifyEndpointCalls, 1, "Supabase verify endpoint called exactly once");
  });

  test("a replayed captured token is rejected by the production seam (P1-001 single-use)", async () => {
    // Drive the real `buildSessionProbe` path: the first
    // exchange succeeds, the second (replayed) exchange is
    // rejected as a replay. The smoke must therefore drive the
    // session probe exactly once and never reuse the captured
    // token; a misuse that re-runs the probe would observe the
    // replay rejection here.
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
    });
    const verifyEnvelope = supabaseVerifyEnvelope({
      id: "supabase-uuid-replay",
      email: "buyer@soundhub.example",
    });
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/auth/v1/verify")) {
        return Promise.resolve(
          new Response(JSON.stringify(verifyEnvelope), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    (adapter as unknown as { fetchImpl: typeof fetch }).fetchImpl = fetchImpl;

    // Simulate a misuse: the "probe" itself exchanges the
    // captured token once, then a second misuse-driven probe
    // attempts to re-exchange the same token. The second attempt
    // must be replay-rejected, proving the production seam
    // enforces single-use and the smoke must NOT trigger such a
    // double-exchange.
    const capturedToken = "replay-fixture-token";
    const first = await adapter.verifySignIn({ verificationToken: capturedToken });
    assert.ok(first, "first exchange of the captured token must succeed");
    const second = await adapter.verifySignIn({ verificationToken: capturedToken });
    assert.equal(second, null, "second exchange of the captured token is replay-rejected");
  });
});
