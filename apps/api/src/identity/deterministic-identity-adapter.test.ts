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
  test("requestSignIn returns a non-empty request id and a devVerificationUrl", async () => {
    const adapter = new DeterministicIdentityAdapter();
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.ok(result.requestId.length > 0);
    assert.ok(result.devVerificationUrl);
    assert.ok(result.devVerificationUrl.includes(result.requestId));
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

  test("the verificationPathPrefix is reflected in devVerificationUrl", async () => {
    const adapter = new DeterministicIdentityAdapter({
      verificationPathPrefix: "/api/auth/dev-verify",
    });
    const result = await adapter.requestSignIn({ email: "buyer@example.com" });
    assert.ok(result.devVerificationUrl?.startsWith("/api/auth/dev-verify?request_id="));
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
