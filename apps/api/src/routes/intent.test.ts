// Intent route tests (M2 #83).
//
// HTTP contract tests for `POST /api/workspaces/:workspaceId/intent`.
// Coverage:
//
//   - Happy path: schema-validated request returns the updated
//     user payload + validated `returnTo`.
//   - `returnTo` validation: malformed or cross-origin paths are
//     silently dropped; the response echoes `null`.
//   - `INTENT_INVALID`: malformed body.
//   - `INTENT_FORBIDDEN`: not a current member of the target
//     Workspace.
//   - `SESSION_INVALID`: missing or invalid session cookie.
//
// The tests run against the in-memory AuthRepository +
// WorkspaceAuthorizationService. The intent service provisions
// capability only — no `sellerAcceptance` field is required.

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/consistent-type-imports */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import type { Request } from "express";
import request from "supertest";
import { buildApp } from "../index.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { IntentService } from "../services/intent.service.js";
import { PersonalWorkspaceConvergenceService } from "../services/personal-workspace-convergence.service.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { AuthenticationService } from "../services/authentication.service.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";
import { resolveRequestId } from "./intent.js";

const USER_ID = "user-intent-route-test";
const WS_ID = "ws-intent-route-test-personal";
const EMAIL = "intent-route@example.com";
const SUBJECT = `deterministic|${EMAIL}`;

const stubPrisma = new Proxy({} as never, {
  get() {
    throw new Error(
      "Prisma client was invoked; the route tests must use the in-memory repository.",
    );
  },
});

describe("Intent route (in-memory)", () => {
  const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: true });

  let authRepo: InMemoryAuthRepository;
  let authenticationService: AuthenticationService;
  let workspaceAuthorizationService: WorkspaceAuthorizationService;
  let intentService: IntentService;
  let personalWorkspaceConvergenceService: PersonalWorkspaceConvergenceService;
  let app: import("express").Application;

  beforeEach(() => {
    authRepo = new InMemoryAuthRepository([
      {
        userAccountId: USER_ID,
        email: EMAIL,
        identityProvider: "deterministic",
        identitySubject: SUBJECT,
        memberships: [
          {
            workspaceId: WS_ID,
            slug: "intent-route-personal",
            name: "Intent Route Personal",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
        ],
      },
    ]);
    personalWorkspaceConvergenceService = new PersonalWorkspaceConvergenceService({
      authRepository: authRepo,
    });
    authenticationService = new AuthenticationService({
      identityAdapter: adapter,
      authRepository: authRepo,
      personalWorkspaceConvergenceService,
    });
    workspaceAuthorizationService = new WorkspaceAuthorizationService({
      authRepository: authRepo,
    });
    intentService = new IntentService({
      authRepository: authRepo,
      workspaceAuthorizationService,
    });
    app = buildApp({
      authenticationService,
      workspaceAuthorizationService,
      authRepository: authRepo,
      identityAdapter: adapter,
      intentService,
      personalWorkspaceConvergenceService,
      prismaClient: stubPrisma,
    }).app;
  });

  // Helper: sign in via the deterministic adapter's dev URL,
  // returning the session cookie value.
  async function signIn(): Promise<string> {
    const magic = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: EMAIL })
      .set("Content-Type", "application/json");
    assert.equal(magic.status, 200);
    const verifyUrl: string = magic.body.devVerificationUrl;
    const token = new URL(verifyUrl, "http://localhost").searchParams.get("token");
    assert.ok(token, "verification token missing");
    const verify = await request(app)
      .post("/api/auth/verify-token")
      .send({ verificationToken: token })
      .set("Content-Type", "application/json");
    assert.equal(verify.status, 200);
    const setCookie = verify.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? "");
    const m = /soundhub_session=([^;]+)/.exec(cookieStr);
    assert.ok(m, "session cookie missing");
    return `soundhub_session=${m[1]}`;
  }

  test("Hire provisions Buyer capability without sellerAcceptance", async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.returnTo, null);
    const ws = response.body.user.workspaces[0];
    assert.deepEqual(ws.capabilities, ["Buyer"]);
  });

  test("Offer provisions Seller capability without sellerAcceptance", async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Offer", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    const ws = response.body.user.workspaces[0];
    assert.deepEqual(ws.capabilities, ["Seller"]);
  });

  test("Both provisions Buyer + Seller atomically without sellerAcceptance", async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Both", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    const ws = response.body.user.workspaces[0];
    assert.deepEqual(ws.capabilities, ["Buyer", "Seller"]);
  });

  test("Later-add Offer with expectedCapabilities=[Buyer] provisions Seller on top of Buyer", async () => {
    const cookie = await signIn();
    // Initial Hire -> Buyer.
    const hire = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(hire.status, 200);
    assert.deepEqual(hire.body.user.workspaces[0].capabilities, ["Buyer"]);
    // Later-add Offer: UI observed Buyer; the command adds
    // Seller. Final state = Buyer+Seller.
    const offer = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Offer", expectedCapabilities: ["Buyer"] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(offer.status, 200);
    assert.deepEqual(offer.body.user.workspaces[0].capabilities, ["Buyer", "Seller"]);
  });

  test("Organization inverse authorization: POST /api/workspaces/<orgId>/intent returns 403 with INTENT_FORBIDDEN; zero mutation", async () => {
    const ORG_ID = "ws-intent-route-org";
    authRepo = new InMemoryAuthRepository([
      {
        userAccountId: USER_ID,
        email: EMAIL,
        identityProvider: "deterministic",
        identitySubject: SUBJECT,
        memberships: [
          {
            workspaceId: WS_ID,
            slug: "intent-route-personal",
            name: "Intent Route Personal",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
          {
            workspaceId: ORG_ID,
            slug: "intent-route-org",
            name: "Intent Route Organization",
            workspaceType: "Organization",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
        ],
      },
    ]);
    personalWorkspaceConvergenceService = new PersonalWorkspaceConvergenceService({
      authRepository: authRepo,
    });
    authenticationService = new AuthenticationService({
      identityAdapter: adapter,
      authRepository: authRepo,
      personalWorkspaceConvergenceService,
    });
    workspaceAuthorizationService = new WorkspaceAuthorizationService({
      authRepository: authRepo,
    });
    intentService = new IntentService({
      authRepository: authRepo,
      workspaceAuthorizationService,
    });
    app = buildApp({
      authenticationService,
      workspaceAuthorizationService,
      authRepository: authRepo,
      identityAdapter: adapter,
      intentService,
      personalWorkspaceConvergenceService,
      prismaClient: stubPrisma,
    }).app;

    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${ORG_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "INTENT_FORBIDDEN");

    const view = await authRepo.getPublicUser(USER_ID);
    const org = view!.workspaces.find((w) => w.workspaceId === ORG_ID);
    assert.deepEqual(org?.capabilities, []);
    const personal = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(personal?.capabilities, []);
  });

  test("Not a current member returns INTENT_FORBIDDEN (translated from AuthorizationError)", async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/ws-not-a-member/intent`)
      .send({ intent: "Hire", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "INTENT_FORBIDDEN");
  });

  test("Missing session returns SESSION_INVALID", async () => {
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [] })
      .set("Content-Type", "application/json");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "SESSION_INVALID");
  });

  test("Malformed body returns INTENT_INVALID", async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ not: "an intent request" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INTENT_INVALID");
  });

  test("Missing expectedCapabilities returns INTENT_INVALID (strict schema)", async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INTENT_INVALID");
  });

  // P2-001: `expectedCapabilities` is a SET, not an array. The
  // closed domain contains only Buyer and Seller so the maximum
  // unique size is two, and duplicates must be rejected at the
  // schema boundary so the comparison against the persisted set
  // never produces a false conflict.
  test("P2-001: duplicate expectedCapabilities ([Buyer, Buyer]) returns INTENT_INVALID", async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: ["Buyer", "Buyer"] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INTENT_INVALID");
  });

  test("P2-001: more than two expectedCapabilities returns INTENT_INVALID", async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({
        intent: "Both",
        // The closed domain has only Buyer and Seller; anything
        // beyond the two members is rejected at the schema
        // boundary so a junk value cannot reach the
        // transaction-bound comparison.
        expectedCapabilities: ["Buyer", "Seller", "Buyer"],
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INTENT_INVALID");
  });

  test("P2-001: each valid capability set is accepted (canonical order-independent)", async () => {
    // The schema must accept `[]`, each singleton, and the
    // pair in either order — all are valid capability sets.
    const cookie = await signIn();
    const variants: ReadonlyArray<readonly string[]> = [
      [],
      ["Buyer"],
      ["Seller"],
      ["Buyer", "Seller"],
      ["Seller", "Buyer"],
    ];
    for (const expected of variants) {
      const response = await request(app)
        .post(`/api/workspaces/${WS_ID}/intent`)
        .send({ intent: "Both", expectedCapabilities: expected })
        .set("Content-Type", "application/json")
        .set("Cookie", cookie);
      assert.notEqual(
        response.status,
        400,
        `expected capability set ${JSON.stringify(expected)} to pass schema validation`,
      );
    }
  });

  test("Validated returnTo is echoed in the response; malformed values are silently dropped to null", async () => {
    const cookie = await signIn();
    const okResponse = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [], returnTo: "/dashboard" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(okResponse.status, 200);
    assert.equal(okResponse.body.returnTo, "/dashboard");

    const badResponse = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [], returnTo: "https://evil.example/x" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(badResponse.status, 200);
    assert.equal(badResponse.body.returnTo, null);
  });

  test("Legacy sellerAcceptance field is rejected as INTENT_INVALID", async () => {
    // Defensive: even though #83 carries no `sellerAcceptance` field
    // on the intent surface, a client that submits one (e.g. a stale
    // UI) is rejected at schema validation. Confirms the contract is
    // strict.
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({
        intent: "Offer",
        expectedCapabilities: [],
        sellerAcceptance: {
          termsVersion: "1.0.0",
          termsContentHash: "a".repeat(64),
        },
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INTENT_INVALID");
  });

  // Stale-precondition conflict at the route boundary: the
  // customer's UI observed an empty capability set; the persisted
  // Workspace has Buyer (a concurrent submission, a stale tab,
  // or an out-of-order refresh). The customer submits `Offer`
  // with `expectedCapabilities: []` — the atomic primitive
  // detects the precondition mismatch and the route returns the
  // distinct `INTENT_CONFLICT` envelope carrying
  // `freshCapabilities` so the UI can recover. The persisted
  // state is unchanged.
  test("Conflicting stale precondition (persisted=Buyer + Offer with expected=[]) returns INTENT_CONFLICT with freshCapabilities; zero writes", async () => {
    const cookie = await signIn();
    const hire = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(hire.status, 200);
    assert.deepEqual(hire.body.user.workspaces[0].capabilities, ["Buyer"]);

    const offer = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Offer", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(offer.status, 409);
    assert.equal(offer.body.error.code, "INTENT_CONFLICT");
    assert.deepEqual(offer.body.error.freshCapabilities, ["Buyer"]);
    assert.ok(typeof offer.body.error.requestId === "string");

    const view = await authRepo.getPublicUser(USER_ID);
    const personal = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(personal?.capabilities, ["Buyer"], "no silent merge into Both");
  });

  // Idempotent stale-precondition: persisted state is Both; the
  // customer submits `Hire` with `expectedCapabilities: []`
  // (chosen set already covered). The command is a no-op
  // success; the route returns 200, NOT 409.
  test("Idempotent stale precondition (persisted=Both + Hire with expected=[]) succeeds as no-op", async () => {
    const cookie = await signIn();
    const both = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Both", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(both.status, 200);
    assert.deepEqual(both.body.user.workspaces[0].capabilities, ["Buyer", "Seller"]);

    const hire = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(hire.status, 200);
    assert.deepEqual(hire.body.user.workspaces[0].capabilities, ["Buyer", "Seller"]);
  });

  // Later-add path through the route: the explicit
  // `[Buyer] + Offer -> Both` shape. Confirms the route
  // accepts the same primitive for both initial selection and
  // later-add; the request body distinguishes them via
  // `expectedCapabilities`.
  test("Later-add Hire with expectedCapabilities=[Seller] provisions Buyer on top of Seller", async () => {
    const cookie = await signIn();
    const offer = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Offer", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(offer.status, 200);
    assert.deepEqual(offer.body.user.workspaces[0].capabilities, ["Seller"]);

    const hire = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: ["Seller"] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(hire.status, 200);
    assert.deepEqual(hire.body.user.workspaces[0].capabilities, ["Buyer", "Seller"]);
  });

  // Canonical Personal Workspace enforcement at the route
  // boundary: a non-canonical accessible Personal Workspace (the
  // user can access TWO Personal Workspaces, and the convergence
  // pointer picks the canonical one) must not receive capability
  // writes when the path id targets the non-canonical
  // alternative.
  test("Canonical Personal Workspace enforcement: non-canonical Personal Workspace id returns INTENT_FORBIDDEN; zero mutation", async () => {
    const NON_CANONICAL_PERSONAL = "ws-intent-route-personal-2";
    authRepo = new InMemoryAuthRepository([
      {
        userAccountId: USER_ID,
        email: EMAIL,
        identityProvider: "deterministic",
        identitySubject: SUBJECT,
        memberships: [
          {
            workspaceId: WS_ID,
            slug: "intent-route-personal",
            name: "Intent Route Personal",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
          {
            workspaceId: NON_CANONICAL_PERSONAL,
            slug: "intent-route-personal-2",
            name: "Intent Route Personal 2 (non-canonical)",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
        ],
      },
    ]);
    personalWorkspaceConvergenceService = new PersonalWorkspaceConvergenceService({
      authRepository: authRepo,
    });
    authenticationService = new AuthenticationService({
      identityAdapter: adapter,
      authRepository: authRepo,
      personalWorkspaceConvergenceService,
    });
    workspaceAuthorizationService = new WorkspaceAuthorizationService({
      authRepository: authRepo,
    });
    intentService = new IntentService({
      authRepository: authRepo,
      workspaceAuthorizationService,
    });
    app = buildApp({
      authenticationService,
      workspaceAuthorizationService,
      authRepository: authRepo,
      identityAdapter: adapter,
      intentService,
      personalWorkspaceConvergenceService,
      prismaClient: stubPrisma,
    }).app;

    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${NON_CANONICAL_PERSONAL}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [] })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "INTENT_FORBIDDEN");

    const view = await authRepo.getPublicUser(USER_ID);
    const canonical = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    const nonCanonical = view!.workspaces.find((w) => w.workspaceId === NON_CANONICAL_PERSONAL);
    assert.deepEqual(canonical?.capabilities, []);
    assert.deepEqual(nonCanonical?.capabilities, []);
  });

  // B4: with more than one accessible Personal Workspace, the route
  // MUST resolve `safeReturnTo` against the canonical Personal
  // Workspace the intent command was just validated against — the
  // path `workspaceId`. Re-deriving "first Personal" from
  // `result.user.workspaces[]` is unsafe because that ordering is
  // not authoritative; the canonical pointer is the convergence
  // pointer, which equals the validated path id.
  //
  // The fixture has two accessible Personal Workspaces:
  //   - WS_ID: Owner role, convergence pointer (canonical).
  //   - SECOND_PERSONAL: Admin role, inserted FIRST so the
  //     insertion-order iteration of `membershipsById.values()`
  //     surfaces it ahead of WS_ID.
  // After `Hire`, WS_ID holds Buyer capability; SECOND_PERSONAL
  // holds none. With the fix, the route uses WS_ID (the path
  // workspaceId) as the `actingWorkspaceId` for the post-command
  // resolver; the `/deals` capability gate (Buyer | Seller) is
  // satisfied and `safeReturnTo === "/deals"`. Without the fix,
  // the route re-derives the first Personal — which is
  // SECOND_PERSONAL — and the gate fails, dropping to the safe
  // fallback `/dashboard`.
  test("B4: with more than one accessible Personal Workspace, safeReturnTo resolves against the canonical (path) workspaceId", async () => {
    const SECOND_PERSONAL = "ws-intent-route-personal-second";
    authRepo = new InMemoryAuthRepository([
      {
        userAccountId: USER_ID,
        email: EMAIL,
        identityProvider: "deterministic",
        identitySubject: SUBJECT,
        memberships: [
          // INSERTED FIRST so the iteration over
          // `membershipsById.values()` puts this Personal
          // ahead of WS_ID in `result.user.workspaces`. The
          // canonical pointer is still WS_ID; this row exists
          // only to exercise the "first Personal is not
          // canonical" branch that motivated the fix.
          {
            workspaceId: SECOND_PERSONAL,
            slug: "intent-route-personal-second",
            name: "Intent Route Personal (second, non-canonical)",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Admin",
            capabilities: [],
          },
          {
            workspaceId: WS_ID,
            slug: "intent-route-personal",
            name: "Intent Route Personal",
            workspaceType: "Personal",
            workspaceStatus: "Active",
            role: "Owner",
            capabilities: [],
          },
        ],
      },
    ]);
    personalWorkspaceConvergenceService = new PersonalWorkspaceConvergenceService({
      authRepository: authRepo,
    });
    authenticationService = new AuthenticationService({
      identityAdapter: adapter,
      authRepository: authRepo,
      personalWorkspaceConvergenceService,
    });
    workspaceAuthorizationService = new WorkspaceAuthorizationService({
      authRepository: authRepo,
    });
    intentService = new IntentService({
      authRepository: authRepo,
      workspaceAuthorizationService,
    });
    app = buildApp({
      authenticationService,
      workspaceAuthorizationService,
      authRepository: authRepo,
      identityAdapter: adapter,
      intentService,
      personalWorkspaceConvergenceService,
      prismaClient: stubPrisma,
    }).app;

    const cookie = await signIn();
    // Submit Hire against the CANONICAL path id (WS_ID). The
    // intent service validates the canonical pointer, then
    // provisions Buyer capability on WS_ID. The non-canonical
    // Admin Personal (SECOND_PERSONAL) receives no capability.
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", expectedCapabilities: [], returnTo: "/deals" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 200);

    // The post-command destination resolver evaluates the
    // capability gate against the FRESH user payload using the
    // path `workspaceId` as `actingWorkspaceId`. WS_ID now
    // holds Buyer capability; the `/deals` gate is satisfied
    // and `safeReturnTo` echoes the validated returnTo.
    assert.equal(
      response.body.safeReturnTo,
      "/deals",
      "safeReturnTo MUST resolve against the canonical Personal Workspace id (the validated path workspaceId), not a re-derived 'first Personal'",
    );

    // Sanity: the persisted state matches expectations.
    const view = await authRepo.getPublicUser(USER_ID);
    const canonical = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    const nonCanonical = view!.workspaces.find((w) => w.workspaceId === SECOND_PERSONAL);
    assert.deepEqual(canonical?.capabilities, ["Buyer"]);
    assert.deepEqual(nonCanonical?.capabilities, []);
  });

  // ---------- request-id sanitization (M2 #83 CodeQL hardening) ----------
  //
  // The intent route's `resolveRequestId` enforces a conservative
  // character allow-list (`[A-Za-z0-9._-]`, max 128 chars) on the
  // `x-request-id` header. The hardening closes:
  //
  //   1. The CodeQL "Use of externally-controlled format string"
  //      alert. Node's `console.error` passes its first argument
  //      through `util.format`, which interprets `%s`, `%d`,
  //      `%o`, `%j`, etc. as format specifiers. The character-set
  //      allow-list rejects any value containing those specifier
  //      characters BEFORE the value can reach the log statement
  //      (and the log statement itself uses a literal-constant
  //      format string with the requestId as a substitution).
  //
  //   2. The broader log-forging / header-hygiene gap: control
  //      bytes, whitespace, over-length, or out-of-allow-list
  //      characters fall back to a freshly generated UUID.
  //
  // Tests below exercise the live route (a 401 path is
  // sufficient — every error response sets the `x-request-id`
  // header, so cookie setup is not required for hardening
  // verification).
  describe("request-id sanitization (M2 #83 CodeQL hardening)", () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Direct unit tests on the exported helper. These
    // exercise the function-level allow-list independently of
    // HTTP transport behavior, so they pin the boundary
    // semantics — including inputs that Node's HTTP client
    // (`ClientRequest.setHeader`) refuses to send on the wire
    // (CR, LF, NUL — they throw `ERR_INVALID_CHAR` at the
    // outgoing boundary before the request ever reaches the
    // server). The corresponding supertest cases for "safe"
    // inputs below confirm the same allow-list end-to-end
    // through the live route.
    function fakeRequest(headerValue: unknown): Request {
      // The helper only reads `req.headers["x-request-id"]` —
      // everything else on the express `Request` type is unused.
      return {
        headers: { "x-request-id": headerValue as string | string[] | undefined },
      } as unknown as Request;
    }

    function expectFreshUuid(value: string, label: string): void {
      assert.match(value, UUID_RE, `${label}: fallback MUST be a freshly generated UUID`);
    }

    async function postIntent(headerValue: string) {
      return request(app)
        .post(`/api/workspaces/${WS_ID}/intent`)
        .send({ intent: "Hire", expectedCapabilities: [], returnTo: "/deals" })
        .set("Content-Type", "application/json")
        .set("x-request-id", headerValue);
    }

    function expectEqual(actual: string | undefined, expected: string, label: string): void {
      assert.ok(
        typeof actual === "string",
        `${label}: x-request-id response header MUST be set to a string`,
      );
      assert.equal(actual, expected, label);
    }

    function expectNotEqual(actual: string | undefined, forbidden: string, label: string): void {
      assert.ok(
        typeof actual === "string",
        `${label}: x-request-id response header MUST be set to a string`,
      );
      assert.notEqual(actual, forbidden, label);
    }

    // ---------- direct unit tests on the exported helper ----------

    test("resolveRequestId: normal UUID passes through unchanged", () => {
      const result = resolveRequestId(fakeRequest("550e8400-e29b-41d4-a716-446655440000"));
      assert.equal(
        result,
        "550e8400-e29b-41d4-a716-446655440000",
        "a UUID MUST pass through the allow-list unchanged (correlation invariant)",
      );
    });

    test("resolveRequestId: ULID-shape uppercase passes through unchanged", () => {
      const result = resolveRequestId(fakeRequest("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
      assert.equal(
        result,
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "ULID-shape uppercase MUST pass through ([A-Za-z] half of the allow-list covers it)",
      );
    });

    test("resolveRequestId: '%s' format specifier is rejected and falls back to UUID", () => {
      const result = resolveRequestId(fakeRequest("evil%s-formatted-injection"));
      expectFreshUuid(
        result,
        "an x-request-id with '%s' MUST be sanitized to a UUID (util.format interprets '%' as format specifiers)",
      );
    });

    test("resolveRequestId: '%o', '%j', '%d' format specifiers are rejected and fall back to UUID", () => {
      for (const malicious of ["evil%o-object", "evil%j-serialized", "evil%d-number"]) {
        const result = resolveRequestId(fakeRequest(malicious));
        expectFreshUuid(result, `'${malicious}' MUST be sanitized to a UUID`);
      }
    });

    test("resolveRequestId: '%%' (literal percent escape) is rejected and falls back to UUID", () => {
      const result = resolveRequestId(fakeRequest("evil%%"));
      expectFreshUuid(result, "even literal '%%' MUST be sanitized — no percent at all is allowed");
    });

    test("resolveRequestId: CR (\\r) byte is rejected (Node's HTTP transport also rejects — this is the function-level belt)", () => {
      const result = resolveRequestId(fakeRequest("evil\rSPOOFED"));
      expectFreshUuid(
        result,
        "an x-request-id containing CR MUST be sanitized (this is the function-level defense; the HTTP transport separately blocks CR at setHeader time)",
      );
    });

    test("resolveRequestId: LF (\\n) byte is rejected (Node's HTTP transport also rejects — function-level belt)", () => {
      const result = resolveRequestId(fakeRequest("evil\nSPOOFED LOG LINE"));
      expectFreshUuid(
        result,
        "an x-request-id containing LF MUST be sanitized (function-level defense; HTTP transport separately blocks LF)",
      );
    });

    test("resolveRequestId: CRLF pair is rejected", () => {
      const result = resolveRequestId(fakeRequest("evil\r\nSPOOFED"));
      expectFreshUuid(result, "CRLF injection MUST be sanitized at the function level");
    });

    test("resolveRequestId: horizontal tab is rejected", () => {
      const result = resolveRequestId(fakeRequest("evil\tTAB"));
      expectFreshUuid(
        result,
        "an x-request-id containing TAB MUST be sanitized (tab is outside [A-Za-z0-9._-] and is a log-forging vector)",
      );
    });

    test("resolveRequestId: NUL byte is rejected", () => {
      const result = resolveRequestId(fakeRequest("evil\x00NULL"));
      expectFreshUuid(result, "an x-request-id containing a NUL byte MUST be sanitized");
    });

    test("resolveRequestId: ANSI escape sequence is rejected", () => {
      // \x1b is the ESC byte — terminals interpret it as the
      // start of an ANSI escape, which can clear logs or
      // re-color output. The allow-list disallows ALL bytes
      // outside [A-Za-z0-9._-].
      const result = resolveRequestId(fakeRequest("evil\x1b[31mRED"));
      expectFreshUuid(result, "an x-request-id starting an ANSI escape sequence MUST be sanitized");
    });

    test("resolveRequestId: non-ASCII unicode is rejected", () => {
      const result = resolveRequestId(fakeRequest("héllo"));
      expectFreshUuid(result, "non-ASCII unicode MUST be sanitized (allow-list is ASCII-only)");
    });

    test("resolveRequestId: emoji is rejected", () => {
      const result = resolveRequestId(fakeRequest("evil😈"));
      expectFreshUuid(result, "emoji MUST be sanitized (non-ASCII)");
    });

    test("resolveRequestId: over-length (>128 chars) is rejected", () => {
      const result = resolveRequestId(fakeRequest("a".repeat(129)));
      expectFreshUuid(result, "an over-length value MUST be sanitized");
    });

    test("resolveRequestId: exactly 128 chars at the inclusive boundary passes through", () => {
      const value = "a".repeat(128);
      const result = resolveRequestId(fakeRequest(value));
      assert.equal(
        result,
        value,
        "a 128-char boundary value MUST pass through (the cap is inclusive)",
      );
    });

    test("resolveRequestId: empty string falls back to UUID", () => {
      const result = resolveRequestId(fakeRequest(""));
      expectFreshUuid(result, "empty x-request-id MUST fall back to a generated UUID");
    });

    test("resolveRequestId: whitespace (space) is rejected", () => {
      const result = resolveRequestId(fakeRequest("has space"));
      expectFreshUuid(result, "an x-request-id with whitespace MUST be sanitized");
    });

    test("resolveRequestId: non-string array-valued header falls back to UUID", () => {
      // Per Node's HTTP types, header values MAY be string[]. The
      // hardened helper treats a non-string value (including an
      // array) as "no usable id" and falls back.
      const result = resolveRequestId(fakeRequest(["first", "second"]));
      expectFreshUuid(
        result,
        "an array-valued x-request-id MUST be sanitized (the helper expects a single string)",
      );
    });

    test("resolveRequestId: undefined header falls back to UUID", () => {
      const result = resolveRequestId(fakeRequest(undefined));
      expectFreshUuid(result, "a missing x-request-id MUST fall back to a generated UUID");
    });

    // ---------- end-to-end supertest cases for "transport-passable" inputs ----------

    test("normal UUID request-id is preserved end-to-end (response correlates)", async () => {
      // The primary invariant: legitimate clients can correlate
      // request and response via the x-request-id header.
      const safe = "550e8400-e29b-41d4-a716-446655440000";
      const response = await postIntent(safe);
      expectEqual(
        response.headers["x-request-id"],
        safe,
        "a UUID-shaped x-request-id MUST round-trip through resolveRequestId unchanged (correlation invariant)",
      );
    });

    test("ULID-shape uppercase Crockford-base32 request-id is preserved", async () => {
      const safe = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
      const response = await postIntent(safe);
      expectEqual(
        response.headers["x-request-id"],
        safe,
        "ULID-shape uppercase MUST round-trip (allow-list covers [A-Za-z])",
      );
    });

    test("request-id containing '%s' format specifier falls back to a generated UUID", async () => {
      const malicious = "evil%s-formatted-injection";
      const response = await postIntent(malicious);
      expectNotEqual(
        response.headers["x-request-id"],
        malicious,
        "an x-request-id containing the util.format '%s' specifier MUST NOT pass through",
      );
      expectFreshUuid(response.headers["x-request-id"]!, "post-sanitization header");
    });

    test("request-id containing '%o', '%j', '%d' format specifiers fall back to generated UUIDs", async () => {
      for (const malicious of ["evil%o-object", "evil%j-serialized", "evil%d-number"]) {
        const response = await postIntent(malicious);
        expectNotEqual(
          response.headers["x-request-id"],
          malicious,
          `x-request-id='${malicious}' MUST NOT pass through (util.format interprets ${malicious})`,
        );
        expectFreshUuid(response.headers["x-request-id"]!, `post-sanitization for '${malicious}'`);
      }
    });

    test("tab / control-byte request-id (transport-passable) falls back to a generated UUID", async () => {
      // Tab (\t) is one of the few control bytes that Node's
      // HTTP transport allows through (CR/LF/NUL are blocked
      // at setHeader). The function-level allow-list still
      // rejects it. End-to-end through the live route.
      const malicious = "evil\tTAB-CHAR";
      const response = await postIntent(malicious);
      expectNotEqual(
        response.headers["x-request-id"],
        malicious,
        "an x-request-id with embedded control byte MUST NOT pass through",
      );
      expectFreshUuid(response.headers["x-request-id"]!, "post-sanitization header");
    });

    test("over-length request-id (>128 chars) falls back to a generated UUID", async () => {
      const malicious = "a".repeat(129);
      const response = await postIntent(malicious);
      expectNotEqual(
        response.headers["x-request-id"],
        malicious,
        "an x-request-id over the 128-char cap MUST NOT pass through unchanged",
      );
      expectFreshUuid(response.headers["x-request-id"]!, "post-sanitization header");
    });

    test("exactly-128-char ASCII request-id at the boundary is preserved (inclusive cap)", async () => {
      const safe = "a".repeat(128);
      const response = await postIntent(safe);
      expectEqual(
        response.headers["x-request-id"],
        safe,
        "a 128-char boundary value MUST be preserved (the cap is inclusive)",
      );
    });

    test("empty-string request-id falls back to a generated UUID", async () => {
      const response = await postIntent("");
      expectFreshUuid(
        response.headers["x-request-id"]!,
        "an empty header MUST fall back to a generated UUID (not the empty string)",
      );
    });

    test("disallowed-character (whitespace) request-id falls back to a generated UUID", async () => {
      const malicious = "has space";
      const response = await postIntent(malicious);
      expectNotEqual(
        response.headers["x-request-id"],
        malicious,
        "an x-request-id with disallowed whitespace MUST NOT pass through",
      );
      expectFreshUuid(response.headers["x-request-id"]!, "post-sanitization header");
    });

    // CR / LF / NUL / ANSI / CRLF: rejected at Node's HTTP
    // client (`ClientRequest.setHeader` throws ERR_INVALID_CHAR)
    // BEFORE the request is sent. The function-level defense
    // is covered by the direct `resolveRequestId(...)` unit
    // tests above. We intentionally do NOT replicate them as
    // supertest cases because the HTTP transport never reaches
    // the route handler.
  });
});
