// Intent route tests (M2 #83).
//
// HTTP contract tests for `POST /api/workspaces/:workspaceId/intent`.
// Coverage:
//
//   - Happy path: schema-validated request returns the updated
//     user payload + validated `returnTo`.
//   - `returnTo` validation: malformed or cross-origin paths are
//     silently dropped; the response echoes `null`.
//   - `INTENT_LEGAL_BLOCKED`: Seller participation terms are not
//     yet registered. Customer-facing copy is the neutral retryable
//     message.
//   - `INTENT_INVALID`: missing `sellerAcceptance` on `Offer` or
//     `Both`; mismatched `termsContentHash`.
//   - `INTENT_FORBIDDEN`: not a current member of the target
//     Workspace.
//   - `SESSION_INVALID`: missing or invalid session cookie.
//
// The tests run against the in-memory AuthRepository +
// WorkspaceAuthorizationService. The intent service uses
// the registered Seller participation terms from
// `apps/api/src/lib/seller-participation-terms.ts`.

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
import {
  __resetSellerParticipationTermsForTests,
  registerSellerParticipationTerms,
} from "../lib/seller-participation-terms.js";

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

const SAMPLE_TERMS = {
  version: "1.0.0",
  content:
    "SoundHub Seller participation terms v1.0.0\n\n" +
    "By choosing Offer services, you confirm you understand the marketplace participation rules.\n",
};

describe("Intent route (in-memory)", () => {
  const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: true });

  // The auth repository, services, and app are rebuilt per-test so
  // state does not leak between cases (Hire followed by Offer would
  // leave Buyer capability on the Workspace).
  let authRepo: InMemoryAuthRepository;
  let authenticationService: AuthenticationService;
  let workspaceAuthorizationService: WorkspaceAuthorizationService;
  let intentService: IntentService;
  let personalWorkspaceConvergenceService: PersonalWorkspaceConvergenceService;
  let app: import("express").Application;

  beforeEach(() => {
    __resetSellerParticipationTermsForTests();
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

  test("Offer without sellerAcceptance returns INTENT_INVALID", async () => {
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Offer" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INTENT_INVALID");
  });

  test("Offer with unregistered Seller participation terms returns INTENT_LEGAL_BLOCKED with the neutral retryable copy", async () => {
    __resetSellerParticipationTermsForTests();
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({
        intent: "Offer",
        sellerAcceptance: {
          termsVersion: "1.0.0",
          termsContentHash: "0".repeat(64),
        },
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "INTENT_LEGAL_BLOCKED");
    assert.equal(
      response.body.error.message,
      "Seller setup is temporarily unavailable. Please try again later.",
    );
  });

  test("Both with unregistered Seller participation terms also returns INTENT_LEGAL_BLOCKED", async () => {
    __resetSellerParticipationTermsForTests();
    const cookie = await signIn();
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({
        intent: "Both",
        sellerAcceptance: {
          termsVersion: "1.0.0",
          termsContentHash: "0".repeat(64),
        },
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "INTENT_LEGAL_BLOCKED");
  });

  test("Offer with registered Seller participation terms succeeds and provisions Seller + acceptance", async () => {
    const cookie = await signIn();
    const registered = registerSellerParticipationTerms(SAMPLE_TERMS);
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({
        intent: "Offer",
        sellerAcceptance: {
          termsVersion: registered.version,
          termsContentHash: registered.contentHash,
        },
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    const ws = response.body.user.workspaces[0];
    assert.deepEqual(ws.capabilities, ["Seller"]);
  });

  test("Both with registered terms succeeds and provisions Buyer + Seller + acceptance", async () => {
    const cookie = await signIn();
    const registered = registerSellerParticipationTerms(SAMPLE_TERMS);
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({
        intent: "Both",
        sellerAcceptance: {
          termsVersion: registered.version,
          termsContentHash: registered.contentHash,
        },
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    const ws = response.body.user.workspaces[0];
    assert.deepEqual(ws.capabilities, ["Buyer", "Seller"]);
  });

  test("Mismatched termsContentHash returns INTENT_INVALID", async () => {
    const cookie = await signIn();
    const registered = registerSellerParticipationTerms(SAMPLE_TERMS);
    const response = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({
        intent: "Offer",
        sellerAcceptance: {
          termsVersion: registered.version,
          termsContentHash: "0".repeat(64),
        },
      })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INTENT_INVALID");
  });

  test("Organization inverse authorization: POST /api/workspaces/<orgId>/intent returns 403 with INTENT_FORBIDDEN; zero mutation", async () => {
    // M2 #83 remediation §2: a valid Organization Owner
    // membership does NOT permit intent provisioning. Re-seed
    // the in-memory repository with both a Personal Workspace
    // AND an Organization Workspace (both Owner); POST to the
    // Organization id; assert the inverse and re-read the
    // Organization surface — it stays zero-capability.
    __resetSellerParticipationTermsForTests();
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

    // Re-read the user payload: Organization has zero
    // capabilities; Personal is untouched.
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
    // WorkspaceAuthorizationService.requireActingMembership throws
    // NOT_A_MEMBER; the IntentService translates the
    // AuthorizationError to INTENT_FORBIDDEN. The route surfaces
    // the safe envelope with the intent-flavored code so the
    // browser can render the correct customer-facing copy.
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

    // Drop the buyer capability to retry with an invalid returnTo.
    // Note: Hire is idempotent, so we can repeat with the same body.
    const badResponse = await request(app)
      .post(`/api/workspaces/${WS_ID}/intent`)
      .send({ intent: "Hire", returnTo: "https://evil.example/x" })
      .set("Content-Type", "application/json")
      .set("Cookie", cookie);
    assert.equal(badResponse.status, 200);
    assert.equal(badResponse.body.returnTo, null);
  });
});
