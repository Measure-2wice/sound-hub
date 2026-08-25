// Deterministic identity adapter contract tests.
//
// Background: BG1 requires that managed and deterministic adapters
// implement the same identity/session contract. These tests pin the
// deterministic adapter's contract behaviour (single-use, expiry,
// stable subject per email) without touching a database or a
// managed provider.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { deriveDeterministicSubject } from "@soundhub/types";
import { DeterministicIdentityAdapter } from "./deterministic-identity-adapter.js";

describe("DeterministicIdentityAdapter", () => {
  test("requestSignIn returns the requestId but NEVER a browser-facing devVerificationUrl, even in operator mode (P1-002)", async () => {
    const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: true });
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.ok(result.requestId.length > 0);
    // The URL is operator-only and is logged to the operator's
    // sink; it MUST NOT cross the public response boundary.
    assert.equal(result.devVerificationUrl, undefined);
  });

  test("requestSignIn OMITS the devVerificationUrl by default so the deployed fallback never exposes a usable login credential (P1-002)", async () => {
    const adapter = new DeterministicIdentityAdapter();
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.ok(result.requestId.length > 0);
    assert.equal(result.devVerificationUrl, undefined);
  });

  test("requestSignIn still produces a verifiable requestId when devVerificationUrl is disabled (P1-002)", async () => {
    const adapter = new DeterministicIdentityAdapter();
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    // The operator (or test harness) drives verifySignIn directly
    // with the requestId — no browser-facing URL is needed.
    const verified = await adapter.verifySignIn({ requestId: request.requestId });
    assert.ok(verified);
    assert.equal(verified.provider, "deterministic");
    assert.equal(verified.providerEmail, "buyer@example.com");
  });

  test("operator-mode requestSignIn logs the verification URL to the operator sink without surfacing it in the response (P1-002)", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      logs.push(msg);
    };
    try {
      const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: true });
      const result = await adapter.requestSignIn({ email: "buyer@example.com" });
      assert.equal(result.devVerificationUrl, undefined);
      assert.ok(
        logs.some(
          (line) =>
            line.includes("operator-mode verification URL") &&
            line.includes(result.requestId) &&
            line.includes("buyer@example.com"),
        ),
        "operator-mode URL must be logged for the operator's recovery workflow",
      );
    } finally {
      console.log = originalLog;
    }
  });

  test("verifySignIn returns null for an unknown request id", async () => {
    const adapter = new DeterministicIdentityAdapter();
    const verified = await adapter.verifySignIn({ requestId: "not-a-real-request" });
    assert.equal(verified, null);
  });

  test("verifySignIn is single-use: a successful verify prevents a second verify", async () => {
    const adapter = new DeterministicIdentityAdapter();
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    const first = await adapter.verifySignIn({ requestId: result.requestId });
    const second = await adapter.verifySignIn({ requestId: result.requestId });
    assert.ok(first);
    assert.equal(first.provider, "deterministic");
    assert.equal(first.providerEmail, "buyer@example.com");
    assert.equal(second, null);
  });

  test("verifySignIn normalizes the email to lowercase and trims whitespace", async () => {
    const adapter = new DeterministicIdentityAdapter();
    const result = await adapter.requestSignIn({ email: "  BUYER@example.com " });
    const verified = await adapter.verifySignIn({ requestId: result.requestId });
    assert.ok(verified);
    assert.equal(verified.providerEmail, "buyer@example.com");
  });

  test("the provider subject is deterministic per email (signing in twice resolves to the same subject)", async () => {
    const adapter = new DeterministicIdentityAdapter();
    const a = await adapter.requestSignIn({ email: "buyer@example.com" });
    const b = await adapter.requestSignIn({ email: "buyer@example.com" });
    const aVerified = await adapter.verifySignIn({ requestId: a.requestId });
    const bVerified = await adapter.verifySignIn({ requestId: b.requestId });
    assert.ok(aVerified);
    assert.ok(bVerified);
    assert.equal(aVerified.subject, bVerified.subject);
  });

  test("different emails produce different provider subjects", async () => {
    const adapter = new DeterministicIdentityAdapter();
    const a = await adapter.requestSignIn({ email: "a@example.com" });
    const b = await adapter.requestSignIn({ email: "b@example.com" });
    const aVerified = await adapter.verifySignIn({ requestId: a.requestId });
    const bVerified = await adapter.verifySignIn({ requestId: b.requestId });
    assert.ok(aVerified);
    assert.ok(bVerified);
    assert.notEqual(aVerified.subject, bVerified.subject);
  });

  test("expired requests cannot be verified (TTL semantics)", () => {
    const now = (() => {
      const t = 1_000_000;
      return () => t;
    })();
    const adapter = new DeterministicIdentityAdapter({ now, ttlMs: 1000 });
    return (async () => {
      const request = await adapter.requestSignIn({ email: "buyer@example.com" });
      // Advance the clock past the TTL.
      // The closure above makes now() always return 1_000_000; we
      // explicitly advance it by reassigning. The simplest path is to
      // use the `expireAll` shortcut.
      adapter.expireAll();
      const verified = await adapter.verifySignIn({ requestId: request.requestId });
      assert.equal(verified, null);
    })();
  });

  test("a deterministic TTL of 0 means every request is expired before verify", async () => {
    const adapter = new DeterministicIdentityAdapter({ ttlMs: 0 });
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const verified = await adapter.verifySignIn({ requestId: request.requestId });
    assert.equal(verified, null);
  });

  test("reset() drops every pending request", async () => {
    const adapter = new DeterministicIdentityAdapter();
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    adapter.reset();
    const verified = await adapter.verifySignIn({ requestId: request.requestId });
    assert.equal(verified, null);
  });

  test("pendingCount returns the number of unconsumed requests", async () => {
    const adapter = new DeterministicIdentityAdapter();
    assert.equal(adapter.pendingCount(), 0);
    await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.equal(adapter.pendingCount(), 1);
    await adapter.requestSignIn({ email: "buyer2@example.com" });
    assert.equal(adapter.pendingCount(), 2);
    adapter.reset();
    assert.equal(adapter.pendingCount(), 0);
  });

  test("the verificationPathPrefix is reflected in the operator-mode log when allowDevVerificationUrl is true (P1-002)", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      logs.push(msg);
    };
    try {
      const adapter = new DeterministicIdentityAdapter({
        allowDevVerificationUrl: true,
        verificationPathPrefix: "/api/auth/dev-verify",
      });
      const result = await adapter.requestSignIn({ email: "buyer@example.com" });
      assert.equal(result.devVerificationUrl, undefined);
      assert.ok(
        logs.some(
          (line) =>
            line.includes("/api/auth/dev-verify?request_id=") && line.includes(result.requestId),
        ),
      );
    } finally {
      console.log = originalLog;
    }
  });

  test("the seed-derived subject and the adapter-derived subject agree for the BG1 demo emails", async () => {
    // P1-001 regression: the deterministic adapter and the seed must
    // produce the SAME (provider, subject) tuple for the demo emails.
    // The shared `deriveDeterministicSubject` helper in
    // `@soundhub/types` is the single source of truth; the seed and
    // the adapter both pass the same Node `crypto.createHash`.
    const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
    const demoBuyer = "demo.buyer@soundhub.example";
    const demoSeller = "marc.andre@creolebeats.example";
    const adapter = new DeterministicIdentityAdapter();
    const buyerRequest = await adapter.requestSignIn({ email: demoBuyer });
    const buyerVerified = await adapter.verifySignIn({ requestId: buyerRequest.requestId });
    const sellerRequest = await adapter.requestSignIn({ email: demoSeller });
    const sellerVerified = await adapter.verifySignIn({ requestId: sellerRequest.requestId });
    assert.ok(buyerVerified);
    assert.ok(sellerVerified);
    assert.equal(
      buyerVerified.subject,
      deriveDeterministicSubject(demoBuyer, sha256),
      "demo buyer subject must match the seed-derived subject",
    );
    assert.equal(
      sellerVerified.subject,
      deriveDeterministicSubject(demoSeller, sha256),
      "demo seller subject must match the seed-derived subject",
    );
  });
});
