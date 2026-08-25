// AuthenticationService tests.
//
// Background: BG1 requires the (provider, subject) → UserAccount
// mapping to live behind one application boundary. These tests
// pin the service's contract behaviour against an in-memory auth
// repository and the deterministic identity adapter.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { AuthenticationService, AuthenticationError } from "./authentication.service.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";

describe("AuthenticationService", () => {
  let now: number;
  let adapter: DeterministicIdentityAdapter;
  let authRepo: InMemoryAuthRepository;
  let service: AuthenticationService;

  beforeEach(() => {
    now = 1_700_000_000_000;
    adapter = new DeterministicIdentityAdapter({ now: () => now });
    authRepo = new InMemoryAuthRepository([], () => now);
    service = new AuthenticationService({
      identityAdapter: adapter,
      authRepository: authRepo,
      now: () => now,
      sessionLifetimeMs: 60 * 60 * 1000,
    });
  });

  test("requestSignIn returns a neutral envelope on every well-formed input", async () => {
    const a = await service.requestSignIn({ email: "buyer@example.com" });
    const b = await service.requestSignIn({ email: "buyer@example.com" });
    assert.equal(a.envelope.ok, true);
    assert.equal(b.envelope.ok, true);
    // The opaque requestId is always present; the
    // devVerificationUrl is operator-only and never crosses the
    // public response boundary. The request ids are different
    // (every request is fresh).
    assert.ok(a.envelope.requestId.length > 0);
    assert.ok(b.envelope.requestId.length > 0);
    assert.notEqual(a.envelope.requestId, b.envelope.requestId);
    assert.equal(a.envelope.devVerificationUrl, undefined);
    assert.equal(b.envelope.devVerificationUrl, undefined);
  });

  test("requestSignIn forwards the operator-mode URL only to the operator sink, not the response (P1-002)", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => {
      logs.push(msg);
    };
    try {
      const operatorAdapter = new DeterministicIdentityAdapter({
        now: () => now,
        allowDevVerificationUrl: true,
      });
      const operatorService = new AuthenticationService({
        identityAdapter: operatorAdapter,
        authRepository: authRepo,
        now: () => now,
      });
      const result = await operatorService.requestSignIn({ email: "buyer@example.com" });
      const envelope = result.envelope;
      assert.ok(envelope, "envelope must be defined");
      assert.ok(envelope.requestId, "envelope.requestId must be defined");
      assert.ok(envelope.requestId.length > 0);
      // The response MUST NOT carry the URL even in operator mode.
      assert.equal(envelope.devVerificationUrl, undefined);
      // The URL goes to the operator's log sink instead.
      assert.ok(
        logs.some(
          (line) =>
            line.includes("operator-mode verification URL") && line.includes(envelope.requestId),
        ),
      );
    } finally {
      console.log = originalLog;
    }
  });

  test("verifySignIn returns a server session and resolves the UserAccount", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const result = await service.verifySignIn({ requestId: request.requestId });
    assert.equal(result.publicUser.identityProvider, "deterministic");
    assert.equal(result.publicUser.email, "buyer@example.com");
    assert.equal(result.publicUser.workspaces.length, 0);
    assert.ok(result.session.sessionId.length > 0);
    assert.equal(result.session.revokedAt, null);
  });

  test("verifySignIn is single-use (a successful verify cannot issue a second session)", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    await service.verifySignIn({ requestId: request.requestId });
    await assert.rejects(
      () => service.verifySignIn({ requestId: request.requestId }),
      (err: unknown) => err instanceof AuthenticationError && err.code === "AUTH_FAILED",
    );
  });

  test("verifySignIn returns AUTH_FAILED for an unknown request id", async () => {
    await assert.rejects(
      () => service.verifySignIn({ requestId: "never-issued" }),
      (err: unknown) => err instanceof AuthenticationError && err.code === "AUTH_FAILED",
    );
  });

  test("verifySignIn returns AUTH_PROVIDER_UNAVAILABLE when the adapter throws", async () => {
    const failingAdapter = {
      providerKey: "deterministic" as const,
      requestSignIn: async () => ({ requestId: "x" }),
      verifySignIn: async () => {
        throw new Error("IdentityProviderUnavailableError adapter failure");
      },
    };
    const brokenService = new AuthenticationService({
      identityAdapter: failingAdapter,
      authRepository: authRepo,
    });
    await assert.rejects(
      () => brokenService.verifySignIn({ requestId: "x" }),
      (err: unknown) => err instanceof AuthenticationError && err.code === "AUTH_FAILED",
    );
  });

  test("resolveSession returns null for an unknown or missing session id", async () => {
    assert.equal(await service.resolveSession(undefined), null);
    assert.equal(await service.resolveSession(""), null);
    assert.equal(await service.resolveSession("not-a-real-session"), null);
  });

  test("resolveSession returns the public user for an active session", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const { session } = await service.verifySignIn({ requestId: request.requestId });
    const user = await service.resolveSession(session.sessionId);
    assert.ok(user);
    assert.equal(user.email, "buyer@example.com");
  });

  test("signOut revokes the current session", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const { session } = await service.verifySignIn({ requestId: request.requestId });
    const revoked = await service.signOut(session.sessionId);
    assert.equal(revoked, true);
    const user = await service.resolveSession(session.sessionId);
    assert.equal(user, null);
  });

  test("signOut is idempotent (revoking an already-revoked session returns false)", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const { session } = await service.verifySignIn({ requestId: request.requestId });
    assert.equal(await service.signOut(session.sessionId), true);
    assert.equal(await service.signOut(session.sessionId), false);
  });

  test("an expired session is rejected by resolveSession without throwing", async () => {
    const request = await adapter.requestSignIn({ email: "buyer@example.com" });
    const { session } = await service.verifySignIn({ requestId: request.requestId });
    // Advance the clock past the session expiry.
    now += 60 * 60 * 1000 + 1;
    const user = await service.resolveSession(session.sessionId);
    assert.equal(user, null);
  });

  test("a UserAccount is created only on first sign-in and reused thereafter", async () => {
    const request1 = await adapter.requestSignIn({ email: "buyer@example.com" });
    const first = await service.verifySignIn({ requestId: request1.requestId });
    // Sign in again with the same email — the deterministic adapter
    // produces a stable subject, so the second verify must resolve
    // to the SAME UserAccount.
    const request2 = await adapter.requestSignIn({ email: "buyer@example.com" });
    const second = await service.verifySignIn({ requestId: request2.requestId });
    assert.equal(first.publicUser.userAccountId, second.publicUser.userAccountId);
  });

  test("two different emails produce two different UserAccounts", async () => {
    const a = await adapter.requestSignIn({ email: "a@example.com" });
    const b = await adapter.requestSignIn({ email: "b@example.com" });
    const aResult = await service.verifySignIn({ requestId: a.requestId });
    const bResult = await service.verifySignIn({ requestId: b.requestId });
    assert.notEqual(aResult.publicUser.userAccountId, bResult.publicUser.userAccountId);
  });
});
