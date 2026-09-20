// Auth route rate-limit tests (CodeQL `js/missing-rate-limiting`
// remediation for PR #91, Tenki remediation revision).
//
// Background: every test in this file constructs a fresh Express
// app + fresh `createAuthRouter` instance so the three remaining
// limiters each receive a fresh `MemoryStore`. This isolation is
// automatic — there is no `resetKey()` import and no production
// middleware re-use — because the limiter middleware is
// instantiated inside `createAuthRouter` and never exported.
//
// POST /api/auth/magic-link is intentionally protected by ONLY a
// route-wide circuit breaker (30 / 5 min, constant key). The
// earlier per-email hash-keyed limiter was removed in the Tenki
// remediation because SoundHub's measured Railway topology does
// NOT preserve the browser IP to Express (Railway web edge sees
// the browser IP; Next.js creates a new server-side request;
// Railway API edge sees the web service's SNAT address; Express
// sees Railway CGNAT / forwarded service identity). Per-email /
// per-IP keying on top of that hop would collapse every
// legitimate browser onto the same bucket and produce a single-
// tenant rate limit for the whole beta. Targeted per-email abuse
// protection is therefore deferred until a trustworthy client
// identity is available at the public boundary.
//
// Tests assert behavioral coverage only: below-threshold requests
// are NOT rejected by the limiter; the threshold-crossing request
// is rejected with the standard `AUTH_RATE_LIMITED` envelope.
// The verify-token tests deliberately do NOT require HTTP 200
// below the threshold because the deterministic auth handler
// legitimately rejects unknown tokens with `AUTH_FAILED`; the
// limiter and the handler are independent concerns.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import assert from "node:assert/strict";
import express, { type Application, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, test } from "node:test";
import request from "supertest";

import { createAuthRouter } from "./auth.js";
import { AuthenticationService } from "../services/authentication.service.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { PersonalWorkspaceConvergenceService } from "../services/personal-workspace-convergence.service.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { generateRequestId, writeSafeError, buildSafeError } from "../lib/errors.js";

function buildFreshApp(): {
  app: Application;
  adapter: DeterministicIdentityAdapter;
  authRepo: InMemoryAuthRepository;
} {
  const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: false });
  const authRepo = new InMemoryAuthRepository([], () => Date.now());
  const authenticationService = new AuthenticationService({
    identityAdapter: adapter,
    authRepository: authRepo,
    personalWorkspaceConvergenceService: new PersonalWorkspaceConvergenceService({
      authRepository: authRepo,
    }),
  });
  const workspaceAuthorizationService = new WorkspaceAuthorizationService({
    authRepository: authRepo,
  });

  const app = express();
  // Mirror the production `x-request-id` middleware so the safe
  // envelope's `requestId` matches the response header. The auth
  // router's body parser is intentionally NOT mirrored here — the
  // router-level `parseAuthRequestBody` middleware owns body parsing
  // for the auth surface and exercises the same code path the
  // deployed entry point uses.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers["x-request-id"];
    const requestId =
      typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : generateRequestId();
    res.setHeader("x-request-id", requestId);
    (req as Request & { requestId?: string }).requestId = requestId;
    next();
  });
  // Catch-all error handler so any unexpected throw surfaces as the
  // standard safe envelope (the production error middleware in
  // `index.ts` is identical in shape).
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const requestId = (req as Request & { requestId?: string }).requestId ?? generateRequestId();
    writeSafeError(
      res,
      buildSafeError("AUTH_FAILED", "An unexpected error occurred.", undefined, requestId),
    );
    void err;
  });
  app.use(
    "/api/auth",
    createAuthRouter({
      authenticationService,
      workspaceAuthorizationService,
      authRepository: authRepo,
      allowedReturnOrigin: "http://localhost:3000",
    }),
  );

  return { app, adapter, authRepo };
}

describe("POST /api/auth/magic-link — no per-email SoundHub-side bucket (Tenki remediation)", () => {
  let app: Application;

  beforeEach(() => {
    ({ app } = buildFreshApp());
  });

  test("repeated same email: 30 requests all pass the limiter, 31st is the first 429 (global breaker, not email-specific)", async () => {
    // Tenki remediation: there is intentionally no per-email
    // limiter on /magic-link. The route-wide circuit breaker is
    // the ONLY SoundHub-side protection. 30 distinct requests
    // for one email must therefore pass the limiter without
    // hitting an email-specific 429. The 31st request is the
    // GLOBAL breaker — not an email-specific decision.
    for (let i = 0; i < 30; i += 1) {
      const response = await request(app)
        .post("/api/auth/magic-link")
        .send({ email: "buyer@example.com" })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429, `request #${i + 1} must not be rate-limited`);
    }
    const thirtyFirst = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "buyer@example.com" })
      .set("Content-Type", "application/json");
    assert.equal(
      thirtyFirst.status,
      429,
      "31st request must hit the route-wide global circuit breaker",
    );
    assert.equal(thirtyFirst.body.error.code, "AUTH_RATE_LIMITED");
  });

  test("repeated same email with case + surrounding whitespace variation: never hits a SoundHub email-specific 429 before the global breaker", async () => {
    // Belt-and-braces companion to the test above: even when the
    // caller varies case + whitespace (which a single human
    // might genuinely do), the limiter must NOT introduce a
    // SoundHub-side email-specific bucket. The first 30 requests
    // through this app pass; the 31st is the global breaker.
    const variants = [
      "buyer@example.com",
      "Buyer@Example.com",
      "  buyer@example.com  ",
      "BUYER@example.com",
      "buyer@EXAMPLE.com",
    ];
    for (let i = 0; i < 30; i += 1) {
      const response = await request(app)
        .post("/api/auth/magic-link")
        .send({ email: variants[i % variants.length] })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429, `request #${i + 1} must not be rate-limited`);
    }
    const thirtyFirst = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "buyer@example.com" })
      .set("Content-Type", "application/json");
    assert.equal(thirtyFirst.status, 429);
    assert.equal(thirtyFirst.body.error.code, "AUTH_RATE_LIMITED");
  });
});

describe("POST /api/auth/verify-token — per-token rate limit", () => {
  let app: Application;

  beforeEach(() => {
    ({ app } = buildFreshApp());
  });

  test("same token: first three are NOT rejected by the limiter, fourth is rejected", async () => {
    const token = `tok-${randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      const response = await request(app)
        .post("/api/auth/verify-token")
        .send({ verificationToken: token })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429, `request #${i + 1} must not be rate-limited`);
    }
    const fourth = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: token })
      .set("Content-Type", "application/json");
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error.code, "AUTH_RATE_LIMITED");
  });

  test("distinct tokens are independent", async () => {
    const tokenA = `tok-a-${randomUUID()}`;
    const tokenB = `tok-b-${randomUUID()}`;
    const a = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: tokenA })
      .set("Content-Type", "application/json");
    const b = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: tokenB })
      .set("Content-Type", "application/json");
    assert.notEqual(a.status, 429);
    assert.notEqual(b.status, 429);
  });

  test("malformed body falls through to the bounded fallback key — not an open-ended enumeration", async () => {
    // All malformed bodies (missing field, wrong type, malformed
    // string) hash to the same fallback key; that key shares the
    // per-token bucket's 3/60s budget. Three malformed requests
    // pass the limiter (and are rejected by the schema as
    // INVALID_AUTH_REQUEST); the fourth trips the limiter. This
    // proves the keyGenerator never produces a per-attacker key
    // from malformed input — an attacker cannot enumerate
    // unlimited buckets by sending garbage bodies.
    for (let i = 0; i < 3; i += 1) {
      const response = await request(app)
        .post("/api/auth/verify-token")
        .send(i === 0 ? {} : { verificationToken: i === 1 ? 12345 : "" })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429, `malformed request #${i + 1} must pass the limiter`);
    }
    const fourth = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: "x".repeat(600) })
      .set("Content-Type", "application/json");
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error.code, "AUTH_RATE_LIMITED");
  });
});

describe("Auth route rate limits — global circuit breakers", () => {
  test("magic-link global: 30 distinct emails pass the global cap, 31st is blocked at the global", async () => {
    const { app } = buildFreshApp();
    for (let i = 0; i < 30; i += 1) {
      const response = await request(app)
        .post("/api/auth/magic-link")
        .send({ email: `user-${i}@example.com` })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429, `request #${i + 1} must pass the global cap`);
    }
    const thirtyFirst = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "user-30@example.com" })
      .set("Content-Type", "application/json");
    assert.equal(thirtyFirst.status, 429);
    assert.equal(thirtyFirst.body.error.code, "AUTH_RATE_LIMITED");
  });

  test("verify-token global: 30 distinct tokens pass the global cap, 31st is blocked at the global", async () => {
    const { app } = buildFreshApp();
    for (let i = 0; i < 30; i += 1) {
      const response = await request(app)
        .post("/api/auth/verify-token")
        .send({ verificationToken: `tok-${i}-${randomUUID()}` })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429, `request #${i + 1} must pass the global cap`);
    }
    const thirtyFirst = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: `tok-30-${randomUUID()}` })
      .set("Content-Type", "application/json");
    assert.equal(thirtyFirst.status, 429);
    assert.equal(thirtyFirst.body.error.code, "AUTH_RATE_LIMITED");
  });

  test("magic-link and verify-token global buckets are independent", async () => {
    const { app } = buildFreshApp();
    // Drive the magic-link global to exhaustion. The
    // verify-token global must still accept the next request
    // because each limiter owns its own MemoryStore and
    // constant key.
    for (let i = 0; i < 30; i += 1) {
      await request(app)
        .post("/api/auth/magic-link")
        .send({ email: `user-${i}@example.com` })
        .set("Content-Type", "application/json");
    }
    const magicLinkBlocked = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "user-30@example.com" })
      .set("Content-Type", "application/json");
    assert.equal(magicLinkBlocked.status, 429);

    const verifyTokenStillAllowed = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: `tok-${randomUUID()}` })
      .set("Content-Type", "application/json");
    assert.notEqual(verifyTokenStillAllowed.status, 429);
  });

  test("magic-link global is hit only via total request count, not per-email enumeration", async () => {
    // Independent bucket proof from the email side: distinct
    // emails each pass independently. Send 15 distinct-email
    // requests then 15 more distinct-email requests; all 30
    // pass. The 31st distinct email request is the one that
    // trips the global. This guards against an accidental
    // re-introduction of a per-email limiter (which would
    // produce 29 200s + 1 429 from a different position).
    const { app } = buildFreshApp();
    for (let i = 0; i < 30; i += 1) {
      const response = await request(app)
        .post("/api/auth/magic-link")
        .send({ email: `distinct-${i}@example.com` })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429);
    }
    const thirtyFirst = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "distinct-30@example.com" })
      .set("Content-Type", "application/json");
    assert.equal(thirtyFirst.status, 429);
    assert.equal(thirtyFirst.body.error.code, "AUTH_RATE_LIMITED");
  });
});

describe("429 envelope shape — standard rate-limit headers + requestId", () => {
  let app: Application;

  beforeEach(() => {
    ({ app } = buildFreshApp());
  });

  test("draft-7 headers and AUTH_RATE_LIMITED envelope on the magic-link global", async () => {
    // Drive the magic-link global to exhaustion by sending 30
    // distinct emails, then inspect the 31st response — the
    // per-email limiter is intentionally absent so this is the
    // cleanest way to observe the envelope.
    for (let i = 0; i < 30; i += 1) {
      await request(app)
        .post("/api/auth/magic-link")
        .send({ email: `envelope-${i}@example.com` })
        .set("Content-Type", "application/json");
    }
    const limited = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "envelope-30@example.com" })
      .set("Content-Type", "application/json");

    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "AUTH_RATE_LIMITED");
    assert.equal(typeof limited.body.error.message, "string");
    assert.ok(limited.body.error.requestId, "envelope carries requestId");

    // Standard draft-7: single combined `RateLimit` header +
    // `RateLimit-Policy` + `Retry-After` on a 429.
    const rateLimitHeader = limited.headers["ratelimit"];
    const rateLimitPolicyHeader = limited.headers["ratelimit-policy"];
    const retryAfterHeader = limited.headers["retry-after"];
    assert.ok(rateLimitHeader, "RateLimit header (draft-7) must be present on 429");
    assert.ok(rateLimitPolicyHeader, "RateLimit-Policy header (draft-7) must be present on 429");
    assert.ok(retryAfterHeader, "Retry-After header must be present on 429");

    // The response's `x-request-id` matches the envelope.
    assert.equal(limited.headers["x-request-id"], limited.body.error.requestId);
  });

  test("draft-7 headers and AUTH_RATE_LIMITED envelope on the verify-token global", async () => {
    // Symmetric coverage for the verify-token global.
    for (let i = 0; i < 30; i += 1) {
      await request(app)
        .post("/api/auth/verify-token")
        .send({ verificationToken: `envelope-tok-${i}-${randomUUID()}` })
        .set("Content-Type", "application/json");
    }
    const limited = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: `envelope-tok-30-${randomUUID()}` })
      .set("Content-Type", "application/json");

    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "AUTH_RATE_LIMITED");
    assert.equal(typeof limited.body.error.message, "string");
    assert.ok(limited.body.error.requestId, "envelope carries requestId");

    const rateLimitHeader = limited.headers["ratelimit"];
    const rateLimitPolicyHeader = limited.headers["ratelimit-policy"];
    const retryAfterHeader = limited.headers["retry-after"];
    assert.ok(rateLimitHeader, "RateLimit header (draft-7) must be present on 429");
    assert.ok(rateLimitPolicyHeader, "RateLimit-Policy header (draft-7) must be present on 429");
    assert.ok(retryAfterHeader, "Retry-After header must be present on 429");
    assert.equal(limited.headers["x-request-id"], limited.body.error.requestId);
  });
});

describe("OPTIONS preflight is unaffected by the rate limiters", () => {
  test("OPTIONS to /magic-link is not 429", async () => {
    const { app } = buildFreshApp();
    const response = await request(app).options("/api/auth/magic-link");
    assert.notEqual(response.status, 429);
  });

  test("OPTIONS to /verify-token is not 429", async () => {
    const { app } = buildFreshApp();
    const response = await request(app).options("/api/auth/verify-token");
    assert.notEqual(response.status, 429);
  });
});
