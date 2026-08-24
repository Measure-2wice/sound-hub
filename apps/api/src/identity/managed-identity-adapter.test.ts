// Managed identity adapter contract tests.
//
// Background: BG1 requires a managed adapter that implements the same
// identity/session contract as the deterministic adapter. In this
// buildathon environment we cannot reach a real Supabase project,
// so the managed adapter is a deliberate stub: it implements the
// shape and rejects with the safe envelope code when called without
// configuration. These tests pin that contract — proving the
// adapter never silently falls through to a demo identity (GS 4 /
// ADR 0004 invariant).

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ManagedIdentityAdapter } from "./managed-identity-adapter.js";
import { IdentityProviderUnavailableError } from "./identity-adapter.js";

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

  test("the adapter's provider key is 'managed-magic-link'", () => {
    const adapter = new ManagedIdentityAdapter({});
    assert.equal(adapter.providerKey, "managed-magic-link");
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
});
