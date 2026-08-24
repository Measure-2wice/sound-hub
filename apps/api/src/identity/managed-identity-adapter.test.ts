// Managed identity adapter contract tests.
//
// Background: BG1 requires a managed adapter that implements the same
// identity/session contract as the deterministic adapter. The
// ticket also requires a "bounded deployed-provider smoke" so the
// factory can fall back to the deterministic adapter when the
// managed path is unreachable. These tests pin that contract
// independently from a real network round-trip.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ManagedIdentityAdapter, type SmokeResult } from "./managed-identity-adapter.js";
import { IdentityProviderUnavailableError } from "./identity-adapter.js";

function makeFetch(
  responses: ReadonlyArray<{
    status: number;
    body?: unknown;
  }>,
): { calls: Array<{ url: string; init?: RequestInit }>; fetchImpl: typeof fetch } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof URL ? input.toString() : (input as string);
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)]!;
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

describe("ManagedIdentityAdapter", () => {
  test("isConfigured reports whether every required env var is present", () => {
    const unconfigured = new ManagedIdentityAdapter({});
    assert.equal(unconfigured.isConfigured(), false);
    const configured = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
    });
    assert.equal(configured.isConfigured(), true);
  });

  test("the adapter's provider key is 'managed-magic-link'", () => {
    const adapter = new ManagedIdentityAdapter({});
    assert.equal(adapter.providerKey, "managed-magic-link");
  });

  test("requestSignIn throws IdentityProviderUnavailableError when not configured", async () => {
    const adapter = new ManagedIdentityAdapter({});
    await assert.rejects(
      () => adapter.requestSignIn({ email: "buyer@example.com" }),
      (err: unknown) => err instanceof IdentityProviderUnavailableError,
    );
  });

  test("verifySignIn throws IdentityProviderUnavailableError when not configured", async () => {
    const adapter = new ManagedIdentityAdapter({});
    await assert.rejects(
      () => adapter.verifySignIn({ requestId: "any-id" }),
      (err: unknown) => err instanceof IdentityProviderUnavailableError,
    );
  });

  test("a partially-configured adapter is still treated as unconfigured", () => {
    // GS 4 / ADR 0004: partial configuration must NOT enable
    // sign-in. The adapter is all-or-nothing so a missing env var
    // cannot produce a half-trusted session.
    const partial = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      // supabaseServiceRoleKey omitted on purpose
    });
    assert.equal(partial.isConfigured(), false);
  });

  test("smoke returns ok:true when the Supabase health endpoint replies 2xx", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: { status: "ok" } }]);
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl,
    });
    const result = await adapter.smoke();
    assert.deepEqual(result, { ok: true } satisfies SmokeResult);
  });

  test("smoke returns ok:false (unconfigured) when env vars are missing", async () => {
    const adapter = new ManagedIdentityAdapter({});
    const result = await adapter.smoke();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unconfigured");
  });

  test("smoke returns ok:false (non-2xx) when the Supabase health endpoint replies 5xx", async () => {
    const { fetchImpl } = makeFetch([{ status: 503, body: { error: "unavailable" } }]);
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl,
    });
    const result = await adapter.smoke();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "non-2xx");
  });

  test("smoke returns ok:false (network) when the fetch implementation throws", async () => {
    const fetchImpl: typeof fetch = () => {
      return Promise.reject(new Error("ECONNREFUSED"));
    };
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl,
    });
    const result = await adapter.smoke();
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
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl,
      smokeTimeoutMs: 25,
    });
    const result = await adapter.smoke();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network");
  });

  test("requestSignIn calls Supabase OTP with the configured credentials", async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 200, body: {} }]);
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl,
    });
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.ok(result.requestId.startsWith("managed:"));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.endsWith("/auth/v1/otp"));
    assert.equal(calls[0]!.init?.method, "POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    assert.equal(headers.apikey, "anon-key");
    assert.equal(headers.Authorization, "Bearer service-role-key");
  });

  test("verifySignIn returns null when the request id is not managed-shaped", async () => {
    const { fetchImpl } = makeFetch([{ status: 200, body: {} }]);
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl,
    });
    const verified = await adapter.verifySignIn({ requestId: "deterministic-uuid" });
    assert.equal(verified, null);
  });

  test("verifySignIn resolves a User identifier from the Supabase admin endpoint", async () => {
    const supabaseUser = {
      data: {
        user: { id: "supabase-uuid-1", email: "buyer@example.com" },
      },
    };
    const { fetchImpl } = makeFetch([{ status: 200, body: supabaseUser }]);
    const adapter = new ManagedIdentityAdapter({
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
      supabaseServiceRoleKey: "service-role-key",
      fetchImpl,
    });
    const handle = `managed:${Buffer.from("buyer@example.com").toString("base64url")}:0`;
    const verified = await adapter.verifySignIn({ requestId: handle });
    assert.ok(verified);
    assert.equal(verified.provider, "managed-magic-link");
    assert.equal(verified.subject, "supabase-uuid-1");
    assert.equal(verified.providerEmail, "buyer@example.com");
  });
});
