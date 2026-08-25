// Bounded deployed-provider smoke tests.
//
// Background: the bounded smoke runs at startup and drives the
// factory's managed-vs-deterministic selection. Per ticket #59
// P1-001 the smoke MUST run on the same adapter the factory
// selects. These tests pin the smoke's contract: health →
// request → session probe. The smoke is FAIL-CLOSED — `ok:
// true` is only returned after EVERY step succeeds, including
// the application-boundary session probe (ticket #59 P1-001)
// AND the explicit session revocation (ticket #59 P0-001).
//
// Per ticket #59 P1-001 (next iteration) the captured token is
// exchanged EXACTLY ONCE through the serving authentication seam.
// The smoke itself NEVER calls `ManagedIdentityAdapter.verifySignIn`
// independently — the `sessionProbe` is the sole exchange path.
//
// Per ticket #59 P1-001 (this iteration) the smoke ties the
// OTP probe to the operator-controlled `smokeMailbox` AND
// embeds a per-attempt `smokeAttemptId` correlation marker in
// the OTP request. The bounded smoke therefore traverses the
// link produced by the deployed email-template configuration
// for THIS specific smoke attempt — a stale same-mailbox
// token issued before the smoke attempt has no matching
// `smokeAttemptId` in `user_metadata` and fails closed.
//
// Per ticket #59 P0-001 (this iteration) the smoke never logs
// bearer session identifiers or account identifiers; the
// session probe revokes the smoke-created session explicitly
// and a `false` revoke result OR a thrown revoke error
// surfaces as a probe failure. The smoke is FAIL-CLOSED when
// revocation cannot be confirmed.
//
// Per ticket #59 P2-001 BG1 only supports magic-link
// verification; the serving adapter pins `type: "magiclink"`
// for the `/auth/v1/verify` call (no runtime switch).
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
 * mirrors the documented response shape including `expires_at`,
 * `provider_token`, and other forward-compatible fields. The
 * `user_metadata` payload is the channel the bounded smoke uses
 * to assert the captured token was issued for its specific
 * attempt (per ticket #59 P1-001).
 */
function supabaseVerifyEnvelope(overrides: {
  readonly id: string;
  readonly email: string | null;
  readonly userMetadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    access_token: "access-token-fixture",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "refresh-token-fixture",
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
      user_metadata: overrides.userMetadata ?? {},
      identities: [],
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    },
  };
}

const SMOKE_MAILBOX = "bg1-smoke@soundhub.example";
const STALE_TOKEN_MAILBOX = "stale-attacker@soundhub.example";
const SMOKE_ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

describe("runStartupSmoke", () => {
  test("returns ok:true only when every step succeeds (P0-001, P1-001)", async () => {
    let verifyCount = 0;
    let revokeCalls = 0;
    let revokedSessionId: string | undefined;
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
      generateAttemptId: () => SMOKE_ATTEMPT_ID,
      sessionProbe: async () => {
        verifyCount += 1;
        // Mirror the production `buildSessionProbe` revocation
        // path so we can assert the smoke never returns ok:true
        // while a bearer session may remain active.
        revokedSessionId = `sess-${verifyCount}`;
        revokeCalls += 1;
        return {
          ok: true,
          verifiedEmail: SMOKE_MAILBOX,
          providerMetadata: { smokeAttemptId: SMOKE_ATTEMPT_ID },
        };
      },
    });
    assert.equal(result.ok, true);
    assert.ok(result.detail?.includes(SMOKE_MAILBOX));
    // Per ticket #59 P0-001 the smoke detail carries NO bearer
    // session id or account identifier — the live credential
    // cannot leak through the smoke detail, the factory log, or
    // any error envelope.
    assert.equal(
      result.detail?.includes("sess-"),
      false,
      "smoke detail MUST NOT embed the live bearer session id",
    );
    assert.equal(
      result.detail?.includes("ua-"),
      false,
      "smoke detail MUST NOT embed account identifiers",
    );
    assert.equal(verifyCount, 1, "session probe must be the SOLE provider exchange");
    assert.equal(revokeCalls, 1, "smoke-created session MUST be explicitly revoked");
    assert.equal(revokedSessionId, "sess-1");
    // Per ticket #59 P1-001 the OTP probe MUST embed the
    // smoke's per-attempt correlation id in the request's
    // `data` payload so Supabase stores it as `user_metadata`
    // on the user record. The verify response carries the
    // metadata back; the smoke asserts the captured token was
    // issued by THIS smoke attempt.
    const otpCall = calls.find((c) => c.url.includes("/auth/v1/otp"));
    assert.ok(otpCall, "OTP request must be made");
    const otpBody = JSON.parse((otpCall.init?.body as string) ?? "{}") as Record<string, unknown>;
    assert.equal(otpBody.email, SMOKE_MAILBOX);
    const data = otpBody.data as Record<string, unknown>;
    assert.ok(data, "data payload must be threaded to Supabase");
    assert.equal(data.smokeAttemptId, SMOKE_ATTEMPT_ID);
  });

  test("returns ok:false (session-coverage-incomplete) when the verified email does not match the smoke mailbox (P1-001 stale mailbox)", async () => {
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
      verifyToken: "stale-token-from-different-mailbox",
      generateAttemptId: () => SMOKE_ATTEMPT_ID,
      sessionProbe: async () => ({
        ok: true,
        verifiedEmail: STALE_TOKEN_MAILBOX,
        providerMetadata: { smokeAttemptId: SMOKE_ATTEMPT_ID },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("does not match smoke mailbox"));
    assert.ok(result.detail?.includes(SMOKE_MAILBOX));
    // The detail MUST NOT embed account identifiers from the
    // verified (stale) identity even when reporting the mismatch.
    assert.equal(
      result.detail?.includes(STALE_TOKEN_MAILBOX),
      false,
      "smoke detail MUST NOT embed the stale-attacker mailbox",
    );
  });

  test("returns ok:false (session-coverage-incomplete) when the verified metadata smokeAttemptId does not match the smoke attempt (P1-001 stale same-mailbox token)", async () => {
    // A prior still-valid token for the same smoke mailbox would
    // verify successfully and report the correct verified email,
    // but the `user_metadata` payload would NOT carry THIS
    // smoke attempt's `smokeAttemptId` (Supabase stored the
    // metadata at the time the OTP request was made). The smoke
    // therefore fails closed when the verified
    // `user_metadata.smokeAttemptId` does not match the
    // per-attempt correlation id, proving the captured
    // credential was actually issued for this smoke attempt.
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
      verifyToken: "stale-same-mailbox-token-from-prior-request",
      generateAttemptId: () => SMOKE_ATTEMPT_ID,
      sessionProbe: async () => ({
        ok: true,
        // The same mailbox passes the email-correlation check,
        // but the user_metadata carries the OLD attempt id (from
        // a prior smoke run). The smoke must reject this token.
        verifiedEmail: SMOKE_MAILBOX,
        providerMetadata: { smokeAttemptId: "old-attempt-id-from-prior-request" },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("does not carry the smoke's per-attempt correlation id"));
    // The detail MUST NOT embed the smokeAttemptId (private
    // credential material) even when reporting the mismatch.
    assert.equal(
      result.detail?.includes(SMOKE_ATTEMPT_ID),
      false,
      "smoke detail MUST NOT embed the smokeAttemptId",
    );
    assert.equal(
      result.detail?.includes("old-attempt-id-from-prior-request"),
      false,
      "smoke detail MUST NOT embed the verified user_metadata",
    );
  });

  test("returns ok:false (session-coverage-incomplete) when the verified metadata omits the smokeAttemptId (P1-001)", async () => {
    // The Supabase verify response omits the smokeAttemptId in
    // `user_metadata` (e.g. the provider returned no metadata,
    // or the metadata does not carry our correlation id). The
    // smoke must fail closed — the captured token cannot be
    // proven to belong to this smoke attempt.
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
      verifyToken: "no-metadata-token",
      generateAttemptId: () => SMOKE_ATTEMPT_ID,
      sessionProbe: async () => ({
        ok: true,
        verifiedEmail: SMOKE_MAILBOX,
        providerMetadata: {},
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("does not carry the smoke's per-attempt correlation id"));
  });

  test("returns ok:false (session-coverage-incomplete) when signOut returns false (P0-001)", async () => {
    // Per ticket #59 P0-001 the probe MUST track the revoke
    // outcome explicitly. A `false` revoke result overrides any
    // earlier success and surfaces as a probe failure so the
    // live bearer credential cannot remain active while the
    // smoke reports success.
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
      verifyToken: "captured-token",
      generateAttemptId: () => SMOKE_ATTEMPT_ID,
      sessionProbe: async () => ({
        ok: false,
        verifiedEmail: SMOKE_MAILBOX,
        providerMetadata: { smokeAttemptId: SMOKE_ATTEMPT_ID },
        detail: "session revoke returned false; smoke-created session may still be active",
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("session revoke returned false"));
  });

  test("returns ok:false (session-coverage-incomplete) when signOut throws (P0-001)", async () => {
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
      smokeMailbox: SMOKE_MAILBOX,
      verifyToken: "captured-token",
      generateAttemptId: () => SMOKE_ATTEMPT_ID,
      sessionProbe: async () => ({
        ok: false,
        verifiedEmail: SMOKE_MAILBOX,
        providerMetadata: { smokeAttemptId: SMOKE_ATTEMPT_ID },
        detail: "signed out failed: ECONNRESET",
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("ECONNRESET"));
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
    const { fetchImpl } = makeFetch({
      responses: [
        { url: "https://example.supabase.co/auth/v1/health", status: 200, body: {} },
        { url: "https://example.supabase.co/auth/v1/otp", status: 200, body: {} },
      ],
    });
    const result = await runStartupSmoke({
      managed: configure({ fetchImpl }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "session-coverage-incomplete");
    assert.ok(result.detail?.includes("BG1_SMOKE_MAILBOX"));
  });

  test("returns ok:false (session-coverage-incomplete) when no operator token is supplied (P1-001)", async () => {
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

describe("runStartupSmoke token consumption (P0-001 single-exchange + revocation)", () => {
  test("the smoke itself never calls ManagedIdentityAdapter.verifySignIn independently", async () => {
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

    const verifyEnvelope = supabaseVerifyEnvelope({
      id: "supabase-uuid-smoke",
      email: SMOKE_MAILBOX,
      userMetadata: { smokeAttemptId: SMOKE_ATTEMPT_ID },
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
      generateAttemptId: () => SMOKE_ATTEMPT_ID,
      sessionProbe: async ({ verificationToken }) => {
        probeCalls += 1;
        const verified = await adapter.verifySignIn({ verificationToken });
        if (!verified) {
          return { ok: false, detail: "adapter rejected the captured token" };
        }
        return {
          ok: true,
          verifiedEmail: verified.providerEmail,
          providerMetadata: verified.providerMetadata,
        };
      },
    });
    assert.equal(result.ok, true);
    assert.ok(result.detail?.includes(SMOKE_MAILBOX));
    assert.equal(adapterVerifyCalls, 1, "smoke must delegate verify to the probe exactly once");
    assert.equal(probeCalls, 1, "smoke must invoke the session probe exactly once");
    assert.equal(verifyEndpointCalls, 1, "Supabase verify endpoint called exactly once");
    assert.equal(
      result.detail?.includes("supabase-uuid-smoke"),
      false,
      "smoke detail MUST NOT embed the provider subject",
    );
  });

  test("a replayed captured token is rejected by the production seam (P1-001 single-use)", async () => {
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

    const capturedToken = "replay-fixture-token";
    const first = await adapter.verifySignIn({ verificationToken: capturedToken });
    assert.ok(first, "first exchange of the captured token must succeed");
    const second = await adapter.verifySignIn({ verificationToken: capturedToken });
    assert.equal(second, null, "second exchange of the captured token is replay-rejected");
  });
});
