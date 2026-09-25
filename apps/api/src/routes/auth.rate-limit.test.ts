// Auth route rate-limit tests (CodeQL `js/missing-rate-limiting`
// remediation for PR #91, Tenki remediation revision).
//
// Background: every test in this file constructs a fresh Express
// app + fresh `createAuthRouter` instance so the per-token
// `MemoryStore` on `/verify-token` is fresh for each `describe`.
// This isolation is automatic — there is no `resetKey()` import and
// no production middleware re-use — because the limiter middleware
// is instantiated inside `createAuthRouter` and never exported.
//
// `POST /api/auth/magic-link` mounts NO SoundHub-side rate
// limiter. SoundHub's measured Railway topology does NOT preserve
// the browser IP to Express (Railway web edge → Next.js → Railway
// API edge → Express sees CGNAT / forwarded service identity),
// so per-email or per-IP keying would collapse every legitimate
// browser onto the same bucket and produce a single-tenant rate
// limit for the whole beta. A route-wide constant-key circuit
// breaker (the earlier 30/5 min cap) was rated High by Tenki
// because any unauthenticated client could exhaust the shared
// bucket and deny authentication to all users. Targeted per-client
// abuse protection is deferred to the future public-boundary
// security ticket — see the limiter construction comment in
// `auth.ts` for the full reasoning.
//
// `POST /api/auth/verify-token` retains the SHA-256 per-token
// limiter (3 / 60 s) attached directly to the route middleware
// chain. The per-token bucket is keyed by the PRIVATE
// verificationToken the browser extracted from the magic-link
// callback URL (canonicalized by `.min(1).max(512)`) so it never
// retains a plaintext token and bounded-retry is preserved.
// Distinct tokens are independent — there is NO global circuit
// breaker on this route.
//
// Tests assert behavioral coverage only: below-threshold requests
// are NOT rejected by the limiter; the threshold-crossing request
// is rejected with the standard `AUTH_RATE_LIMITED` envelope. The
// verify-token tests deliberately do NOT require HTTP 200 below
// the threshold because the deterministic auth handler legitimately
// rejects unknown tokens with `AUTH_FAILED`; the limiter and the
// handler are independent concerns.

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
import { writeSafeError, buildSafeError } from "../lib/errors.js";
import { getRequestId, storeRequestId, type RequestWithRequestId } from "../lib/request-id.js";

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
  //
  // The canonical request-id writer/reader pair from
  // `apps/api/src/lib/request-id.ts` is used here so the test app
  // applies the same `SAFE_REQUEST_ID_PATTERN` allow-list as
  // production. Reading `req.headers["x-request-id"]` directly with
  // a length-only check would let an unsafe header reach the
  // response header / envelope surfaces (the original CodeQL
  // "externally-controlled format string" finding on this file).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = storeRequestId(req);
    res.setHeader("x-request-id", requestId);
    next();
  });
  // Catch-all error handler so any unexpected throw surfaces as the
  // standard safe envelope (the production error middleware in
  // `index.ts` is identical in shape).
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const requestId = getRequestId(req as RequestWithRequestId);
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

describe("POST /api/auth/magic-link — no SoundHub-side rate limiter (Tenki remediation)", () => {
  let app: Application;

  beforeEach(() => {
    ({ app } = buildFreshApp());
  });

  test("repeated same email: no SoundHub-side 429 across many requests (no per-email bucket)", async () => {
    // Tenki remediation: there is intentionally NO SoundHub-side
    // rate limiter on /magic-link. Per-email keying would collapse
    // every legitimate browser onto the same bucket under the
    // current Railway topology, and a route-wide constant-key
    // circuit breaker would create a shared bucket that any
    // unauthenticated client could exhaust to deny authentication
    // to all users. The route therefore accepts every well-formed
    // request through the limiter, leaving application-level
    // per-client abuse protection for the future public-boundary
    // security ticket.
    for (let i = 0; i < 50; i += 1) {
      const response = await request(app)
        .post("/api/auth/magic-link")
        .send({ email: "buyer@example.com" })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429, `request #${i + 1} must not be rate-limited`);
    }
  });

  test("repeated same email with case + surrounding whitespace variation: still no SoundHub-side 429", async () => {
    // Belt-and-braces companion: even when the caller varies case
    // + whitespace (which a single human might genuinely do), the
    // route MUST NOT introduce a SoundHub-side email-specific
    // bucket.
    const variants = [
      "buyer@example.com",
      "Buyer@Example.com",
      "  buyer@example.com  ",
      "BUYER@example.com",
      "buyer@EXAMPLE.com",
    ];
    for (let i = 0; i < 50; i += 1) {
      const response = await request(app)
        .post("/api/auth/magic-link")
        .send({ email: variants[i % variants.length] })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429, `request #${i + 1} must not be rate-limited`);
    }
  });

  test("distinct emails are all accepted — no global circuit breaker", async () => {
    // Independent bucket proof from the email side: distinct
    // emails each pass independently. Send 50 distinct-email
    // requests; all 50 pass. There is no global cap that could
    // be tripped by total request count.
    for (let i = 0; i < 50; i += 1) {
      const response = await request(app)
        .post("/api/auth/magic-link")
        .send({ email: `distinct-${i}@example.com` })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429);
    }
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

  test("distinct tokens are independent — no global circuit breaker", async () => {
    // Two distinct tokens, each hit once: both pass the limiter.
    // Distinct tokens share no bucket; there is no global cap on
    // /verify-token.
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

  test("many distinct tokens are all accepted — no global circuit breaker", async () => {
    // Independent bucket proof from the token side: distinct
    // tokens each pass independently. Send 50 distinct-token
    // requests; all 50 pass. There is no global cap that could
    // be tripped by total request count.
    for (let i = 0; i < 50; i += 1) {
      const response = await request(app)
        .post("/api/auth/verify-token")
        .send({ verificationToken: `tok-${i}-${randomUUID()}` })
        .set("Content-Type", "application/json");
      assert.notEqual(response.status, 429);
    }
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

describe("429 envelope shape — standard rate-limit headers + requestId", () => {
  let app: Application;

  beforeEach(() => {
    ({ app } = buildFreshApp());
  });

  test("draft-7 headers and AUTH_RATE_LIMITED envelope on the verify-token per-token bucket", async () => {
    // Drive the per-token bucket to exhaustion by submitting the
    // same token 4 times, then inspect the 4th response — the
    // only limiter on /verify-token is the per-token bucket, so
    // this is the cleanest way to observe the envelope.
    const token = `envelope-tok-${randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post("/api/auth/verify-token")
        .send({ verificationToken: token })
        .set("Content-Type", "application/json");
    }
    const limited = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: token })
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
});

describe("OPTIONS preflight is unaffected by the rate limiter", () => {
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
