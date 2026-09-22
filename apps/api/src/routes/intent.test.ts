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
      .send({ intent: "Hire" })
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
      .send({ intent: "Offer" })
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
      .send({ intent: "Both" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    const ws = response.body.user.workspaces[0];
    assert.deepEqual(ws.capabilities, ["Buyer", "Seller"]);
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
      .send({ intent: "Hire" })
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
      .send({ intent: "Hire" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "INTENT_FORBIDDEN");
  });

  test("Missing session returns SESSION_INVALID", async () => {
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire" })
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

  test("Validated returnTo is echoed in the response; malformed values are silently dropped to null", async () => {
    const cookie = await signIn();
    const okResponse = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", returnTo: "/dashboard" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(okResponse.status, 200);
    assert.equal(okResponse.body.returnTo, "/dashboard");

    const badResponse = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", returnTo: "https://evil.example/x" })
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

  // Conflicting intent retry at the route boundary: a second
  // `Offer` retry after a successful `Hire` would silently merge
  // into Buyer+Seller=Both. The route must reject with
  // INTENT_FORBIDDEN and zero unintended capability writes. The
  // dedicated "add the other capability" command (later
  // boundary) is the explicit path.
  test("Conflicting intent retry (Offer after Hire) returns INTENT_FORBIDDEN; zero unintended writes", async () => {
    const cookie = await signIn();
    const hire = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(hire.status, 200);
    assert.deepEqual(hire.body.user.workspaces[0].capabilities, ["Buyer"]);

    const offer = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Offer" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(offer.status, 403);
    assert.equal(offer.body.error.code, "INTENT_FORBIDDEN");

    const view = await authRepo.getPublicUser(USER_ID);
    const personal = view!.workspaces.find((w) => w.workspaceId === WS_ID);
    assert.deepEqual(personal?.capabilities, ["Buyer"], "no silent merge into Both");
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
      .send({ intent: "Hire" })
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
