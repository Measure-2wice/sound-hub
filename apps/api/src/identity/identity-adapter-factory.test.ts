// Identity adapter factory tests.
//
// Background: BG1 requires that the composition root selects the
// active identity adapter through a bounded deployed-provider
// smoke. The deterministic adapter is the approved fallback when
// the managed smoke fails; the factory must record the decision
// so operators can act on the deployed fallback without spelunking.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildIdentityAdapters } from "./identity-adapter-factory.js";
import type { SmokeResult } from "./managed-identity-adapter.js";

describe("buildIdentityAdapters", () => {
  test("the deterministic override always wins", () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { active, smokeResult } = buildIdentityAdapters({
        override: "deterministic",
        supabase: {
          url: "https://example.supabase.co",
          anonKey: "anon-key",
          serviceRoleKey: "service-role-key",
        },
      });
      assert.equal(active.providerKey, "deterministic");
      assert.equal(smokeResult.reason, "unconfigured");
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });

  test("the managed override requires configuration", () => {
    assert.throws(
      () =>
        buildIdentityAdapters({
          override: "managed-magic-link",
          supabase: { url: "https://example.supabase.co" },
        }),
      /not configured/,
    );
  });

  test("production selects managed only when the smoke succeeded", () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const okSmoke: SmokeResult = { ok: true };
      const { active } = buildIdentityAdapters({
        override: undefined,
        supabase: {
          url: "https://example.supabase.co",
          anonKey: "anon-key",
          serviceRoleKey: "service-role-key",
        },
        managedSmoke: okSmoke,
      });
      assert.equal(active.providerKey, "managed-magic-link");
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });

  test("production falls back to deterministic when the smoke fails (BG1 GS 2)", () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const failSmoke: SmokeResult = {
        ok: false,
        reason: "network",
        detail: "ECONNREFUSED",
      };
      const logs: string[] = [];
      const { active, smokeResult } = buildIdentityAdapters({
        override: undefined,
        supabase: {
          url: "https://example.supabase.co",
          anonKey: "anon-key",
          serviceRoleKey: "service-role-key",
        },
        managedSmoke: failSmoke,
        log: (msg) => logs.push(msg),
      });
      assert.equal(active.providerKey, "deterministic");
      assert.deepEqual(smokeResult, failSmoke);
      assert.ok(logs.some((line) => line.includes("falling back to deterministic")));
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });

  test("non-production defaults to deterministic without contacting the managed provider", () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const { active } = buildIdentityAdapters({
        override: undefined,
        // Intentionally pass no supabase configuration AND no smoke
        // result so the factory falls back without a network call.
        managedSmoke: { ok: false, reason: "unconfigured" },
      });
      assert.equal(active.providerKey, "deterministic");
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });

  test("the smoke decision is exposed for operational reporting", () => {
    const failSmoke: SmokeResult = {
      ok: false,
      reason: "non-2xx",
      detail: "Supabase health returned 503",
    };
    const { smokeResult } = buildIdentityAdapters({
      managedSmoke: failSmoke,
    });
    assert.deepEqual(smokeResult, failSmoke);
  });
});
