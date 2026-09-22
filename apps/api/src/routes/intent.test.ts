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
import request from "supertest";
import { buildApp } from "../index.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { IntentService } from "../services/intent.service.js";
import { PersonalWorkspaceConvergenceService } from "../services/personal-workspace-convergence.service.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { AuthenticationService } from "../services/authentication.service.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";

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
});
