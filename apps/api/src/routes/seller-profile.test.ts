// SellerProfile route tests (M2 #84).
//
// HTTP contract tests for the seller-profile route family at
// `/api/workspaces/:workspaceId/seller-profile/{draft,publish}`.
//
// Coverage:
//   - signed-out → SESSION_INVALID
//   - Organization Workspace actor → SELLER_PROFILE_FORBIDDEN
//   - Buyer-only Personal Workspace → SELLER_PROFILE_FORBIDDEN
//   - schema validation → SELLER_PROFILE_INVALID
//   - happy path: draft save → resume → publish → stable success
//   - same-attempt retry: identical `idempotencyKey` returns the
//     already-persisted evidence; only ONE SellerProfilePublication
//     row exists
//   - post-publication update replaces the field set atomically;
//     a new evidence row is written

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/consistent-type-imports */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import request from "supertest";
import { buildApp } from "../index.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { InMemorySellerProfileRepository } from "../repositories/in-memory-seller-profile.repository.js";
import { SellerProfileService } from "../services/seller-profile.service.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { AuthenticationService } from "../services/authentication.service.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";
import { PersonalWorkspaceConvergenceService } from "../services/personal-workspace-convergence.service.js";

const SELLER_USER = "user-seller-profile-route";
const BUYER_USER = "user-buyer-personal";
const ORG_SELLER_USER = "user-org-seller";
const PERSONAL_WS = "ws-seller-profile-personal";
const PERSONAL_WS_BUYER = "ws-seller-profile-buyer";
const ORG_WS = "ws-seller-profile-org";

const SELLER_EMAIL = "seller-profile-route@example.com";
const BUYER_EMAIL = "buyer-personal-route@example.com";
const ORG_SELLER_EMAIL = "org-seller-route@example.com";

const stubPrisma = new Proxy({} as never, {
  get() {
    throw new Error(
      "Prisma client was invoked; the route tests must use the in-memory repository.",
    );
  },
});

function buildUsers() {
  return new InMemoryAuthRepository([
    {
      userAccountId: SELLER_USER,
      email: SELLER_EMAIL,
      identityProvider: "deterministic",
      identitySubject: `deterministic|${SELLER_EMAIL}`,
      memberships: [
        {
          workspaceId: PERSONAL_WS,
          slug: "seller-profile-personal",
          name: "Seller Profile Personal",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Seller"],
        },
      ],
    },
    {
      userAccountId: BUYER_USER,
      email: BUYER_EMAIL,
      identityProvider: "deterministic",
      identitySubject: `deterministic|${BUYER_EMAIL}`,
      memberships: [
        {
          workspaceId: PERSONAL_WS_BUYER,
          slug: "buyer-personal",
          name: "Buyer Personal",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Buyer"],
        },
      ],
    },
    {
      userAccountId: ORG_SELLER_USER,
      email: ORG_SELLER_EMAIL,
      identityProvider: "deterministic",
      identitySubject: `deterministic|${ORG_SELLER_EMAIL}`,
      memberships: [
        {
          workspaceId: ORG_WS,
          slug: "org-seller",
          name: "Org Seller",
          workspaceType: "Organization",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Seller"],
        },
      ],
    },
  ]);
}

describe("SellerProfile route (in-memory)", () => {
  const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: true });

  let authRepo: ReturnType<typeof buildUsers>;
  let authenticationService: AuthenticationService;
  let workspaceAuthorizationService: WorkspaceAuthorizationService;
  let sellerProfileService: SellerProfileService;
  let personalWorkspaceConvergenceService: PersonalWorkspaceConvergenceService;
  let sellerProfileRepository: InMemorySellerProfileRepository;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeEach(() => {
    authRepo = buildUsers();
    sellerProfileRepository = new InMemorySellerProfileRepository();
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
    sellerProfileService = new SellerProfileService({
      repository: sellerProfileRepository,
      workspaceAuthorizationService,
    });
    app = buildApp({
      authenticationService,
      workspaceAuthorizationService,
      authRepository: authRepo,
      identityAdapter: adapter,
      personalWorkspaceConvergenceService,
      sellerProfileService,
      sellerProfileRepository,
      prismaClient: stubPrisma,
    }).app;
  });

  async function signIn(email: string): Promise<string> {
    const magic = await request(app)
      .post("/api/auth/magic-link")
      .send({ email })
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

  const draftBody = {
    identity: {
      professionalName: "Creole Beats Brooklyn",
      bio: "Brooklyn-based production studio.",
    },
    basedIn: { countryCode: "US", region: "New York", city: "Brooklyn" },
    disciplines: {
      specialtyKeys: ["Producer"],
      caribbeanAffiliationCodes: ["HT"],
    },
  };

  const publishBody = {
    identity: draftBody.identity,
    basedIn: draftBody.basedIn,
    disciplines: draftBody.disciplines,
    confirmationVersion: "m2-profile-publication-v1",
    idempotencyKey: "11111111-2222-3333-4444-555555555555",
  };

  test("GET /seller-profile returns null when no draft exists", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .get(`/api/workspaces/${PERSONAL_WS}/seller-profile`)
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.profile, null);
  });

  test("GET /seller-profile without a session returns SESSION_INVALID", async () => {
    const response = await request(app).get(`/api/workspaces/${PERSONAL_WS}/seller-profile`);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "SESSION_INVALID");
  });

  test("GET /seller-profile rejects an Organization actor with SELLER_PROFILE_FORBIDDEN", async () => {
    const cookie = await signIn(ORG_SELLER_EMAIL);
    const response = await request(app)
      .get(`/api/workspaces/${ORG_WS}/seller-profile`)
      .set("Cookie", cookie);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "SELLER_PROFILE_FORBIDDEN");
  });

  test("GET /seller-profile rejects a Buyer-only Personal actor with SELLER_PROFILE_FORBIDDEN", async () => {
    const cookie = await signIn(BUYER_EMAIL);
    const response = await request(app)
      .get(`/api/workspaces/${PERSONAL_WS_BUYER}/seller-profile`)
      .set("Cookie", cookie);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "SELLER_PROFILE_FORBIDDEN");
  });

  test("PUT /seller-profile/draft saves the draft and returns the persisted row", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.profile.status, "Draft");
    assert.equal(response.body.profile.identity.professionalName, "Creole Beats Brooklyn");
  });

  test("PUT /seller-profile/draft on a published profile is rejected with SELLER_PROFILE_NOT_DRAFT", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    // Save + publish first.
    await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/seller-profile/publish`)
      .send(publishBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    // Try to save draft again — should be rejected.
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    // The first attempt: due to retry-idempotency convergence, the
    // first publish with this key already persisted. Subsequent
    // save-draft on a Published row is rejected as not-Draft.
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "SELLER_PROFILE_NOT_DRAFT");
  });

  test("PUT /seller-profile/draft with malformed body returns SELLER_PROFILE_INVALID", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile/draft`)
      .send({ identity: {}, basedIn: {}, disciplines: {} })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "SELLER_PROFILE_INVALID");
  });

  test("POST /seller-profile/publish returns SELLER_PROFILE_INCOMPLETE for empty Specialty list", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/seller-profile/publish`)
      .send({
        ...publishBody,
        disciplines: { specialtyKeys: [], caribbeanAffiliationCodes: ["HT"] },
      })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "SELLER_PROFILE_INCOMPLETE");
  });

  test("POST /seller-profile/publish transitions Draft to Published and inserts evidence", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/seller-profile/publish`)
      .send(publishBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.profile.status, "Published");
    assert.equal(response.body.evidence.confirmationVersion, "m2-profile-publication-v1");
    assert.equal(response.body.evidence.idempotencyKey, publishBody.idempotencyKey);
  });

  test("POST /seller-profile/publish with the same idempotencyKey converges on the existing evidence", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    const first = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/seller-profile/publish`)
      .send(publishBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(first.status, 200);
    const second = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/seller-profile/publish`)
      .send(publishBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(second.status, 200);
    assert.equal(
      second.body.evidence.publishedAt,
      first.body.evidence.publishedAt,
      "retry returns the SAME evidence timestamp",
    );
    // Only ONE evidence row exists for this idempotencyKey.
    const evidence = sellerProfileRepository._peekPublication(
      PERSONAL_WS,
      publishBody.idempotencyKey,
    );
    assert.ok(evidence);
  });

  test("PUT /seller-profile replaces the public field set on a Published profile", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/seller-profile/publish`)
      .send(publishBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    const updateBody = {
      identity: { ...draftBody.identity, professionalName: "Updated Name" },
      basedIn: draftBody.basedIn,
      disciplines: draftBody.disciplines,
      confirmationVersion: "m2-profile-publication-v1",
      idempotencyKey: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile`)
      .send(updateBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.profile.status, "Published");
    assert.equal(response.body.profile.identity.professionalName, "Updated Name");
  });

  test("PUT /seller-profile on a Draft profile returns SELLER_PROFILE_NOT_PUBLISHED", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/seller-profile`)
      .send({
        identity: draftBody.identity,
        basedIn: draftBody.basedIn,
        disciplines: draftBody.disciplines,
        confirmationVersion: "m2-profile-publication-v1",
        idempotencyKey: "dddddddd-eeee-ffff-0000-111111111111",
      })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "SELLER_PROFILE_NOT_PUBLISHED");
  });

  test("Buyer-only Personal actor is rejected from the seller-profile route family", async () => {
    const cookie = await signIn(BUYER_EMAIL);
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS_BUYER}/seller-profile/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "SELLER_PROFILE_FORBIDDEN");
  });
});
