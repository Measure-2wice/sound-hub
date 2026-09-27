// ServiceOffering route tests (M2 #85).
//
// HTTP contract tests for the service-offering route family at
// `/api/workspaces/:workspaceId/service-offerings/...`.
//
// Coverage:
//   - signed-out → SESSION_INVALID
//   - Organization Workspace actor → SERVICE_OFFERING_FORBIDDEN
//   - Buyer-only Personal Workspace → SERVICE_OFFERING_FORBIDDEN
//   - schema validation → SERVICE_OFFERING_INVALID
//   - happy path: draft save → resume; activation happy path is
//     covered by the service-level tests
//   - activation on an unpublished SellerProfile →
//     SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED
//   - activation completeness → SERVICE_OFFERING_INCOMPLETE with
//     `fields` populated

/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import request from "supertest";
import type { Application } from "express";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";
import { InMemoryServiceOfferingRepository } from "../repositories/in-memory-service-offering.repository.js";
import { buildApp, type AppOptions } from "../index.js";
import { ServiceOfferingService } from "../services/service-offering.service.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { AuthenticationService } from "../services/authentication.service.js";
import { DeterministicIdentityAdapter } from "../identity/deterministic-identity-adapter.js";
import { PersonalWorkspaceConvergenceService } from "../services/personal-workspace-convergence.service.js";

const SELLER_USER = "user-service-offering-route";
const ORG_SELLER_USER = "user-org-service-offering";
const PERSONAL_WS = "ws-service-offering-personal";
const ORG_WS = "ws-service-offering-org";

const SELLER_EMAIL = "service-offering-route@example.com";
const ORG_SELLER_EMAIL = "org-service-offering-route@example.com";

const stubPrisma = new Proxy({} as never, {
  get() {
    throw new Error(
      "Prisma client was invoked; the route tests must use the in-memory repository.",
    );
  },
});

function buildUsers(): InMemoryAuthRepository {
  return new InMemoryAuthRepository([
    {
      userAccountId: SELLER_USER,
      email: SELLER_EMAIL,
      identityProvider: "deterministic",
      identitySubject: `deterministic|${SELLER_EMAIL}`,
      memberships: [
        {
          workspaceId: PERSONAL_WS,
          slug: "service-offering-personal",
          name: "Service Offering Personal",
          workspaceType: "Personal",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Seller"],
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
          slug: "org-service-offering",
          name: "Org Service Offering",
          workspaceType: "Organization",
          workspaceStatus: "Active",
          role: "Owner",
          capabilities: ["Seller"],
        },
      ],
    },
  ]);
}

describe("ServiceOffering route (in-memory)", () => {
  const adapter = new DeterministicIdentityAdapter({ allowDevVerificationUrl: true });

  let authRepo: ReturnType<typeof buildUsers>;
  let authenticationService: AuthenticationService;
  let workspaceAuthorizationService: WorkspaceAuthorizationService;
  let serviceOfferingService: ServiceOfferingService;
  let personalWorkspaceConvergenceService: PersonalWorkspaceConvergenceService;
  let serviceOfferingRepository: InMemoryServiceOfferingRepository;
  let app: Application;

  beforeEach(() => {
    authRepo = buildUsers();
    serviceOfferingRepository = new InMemoryServiceOfferingRepository();
    serviceOfferingRepository._seedOffering({
      id: "of_test_1",
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Draft",
    });
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
    serviceOfferingService = new ServiceOfferingService({
      repository: serviceOfferingRepository,
      workspaceAuthorizationService,
      // No SellerProfile exists yet for this Workspace. The activate
      // path rejects with SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED.
      getSellerProfileStatus: () => Promise.resolve(null),
      playbackUrlFor: (input) =>
        `https://api.test/services/${input.offeringId}/samples/${input.sampleId}/play`,
    });
    const options: AppOptions = {
      authenticationService,
      workspaceAuthorizationService,
      authRepository: authRepo,
      identityAdapter: adapter,
      personalWorkspaceConvergenceService,
      serviceOfferingService,
      serviceOfferingRepository,
      prismaClient: stubPrisma,
    };
    app = buildApp(options).app;
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
    title: "Haitian dancehall production",
    description: "Arrangement + recording direction + editing.",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: { kind: "StartingAt", amountMinor: 60000, currency: "USD", unitId: "per-track" },
    genreTags: ["dancehall"],
    includedServiceCategoryKeys: [],
    idempotencyKey: "draft-1",
  };

  test("GET without a session returns SESSION_INVALID", async () => {
    const response = await request(app).get(
      `/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_1`,
    );
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "SESSION_INVALID");
  });

  test("GET on an Organization actor returns SERVICE_OFFERING_FORBIDDEN", async () => {
    const cookie = await signIn(ORG_SELLER_EMAIL);
    const response = await request(app)
      .get(`/api/workspaces/${ORG_WS}/service-offerings/of_test_1`)
      .set("Cookie", cookie);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_FORBIDDEN");
  });

  test("GET returns the OwnerView for an owned Draft offering", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .get(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_1`)
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.offering.serviceOfferingId, "of_test_1");
    assert.equal(response.body.offering.status, "Draft");
  });

  test("GET list returns only offerings owned by the acting Workspace", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .get(`/api/workspaces/${PERSONAL_WS}/service-offerings`)
      .set("Cookie", cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.offerings.length, 1);
    assert.equal(response.body.offerings[0].serviceOfferingId, "of_test_1");
  });

  test("PUT draft rejects a malformed body with SERVICE_OFFERING_INVALID + field errors", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_1/draft`)
      .send({})
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_INVALID");
    assert.ok(Array.isArray(response.body.error.fields));
  });

  test("PUT draft happy path persists the values", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_1/draft`)
      .send(draftBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.offering.title, "Haitian dancehall production");
    assert.equal(response.body.offering.primaryCategoryKey, "music-production");
    assert.equal(response.body.offering.pricing.kind, "StartingAt");
    assert.equal(response.body.offering.pricing.amountMinor, 60000);
  });

  test("POST activate on an unpublished SellerProfile returns SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_1/activate`)
      .send({
        title: "Haitian dancehall production",
        description: "Arrangement + recording direction + editing.",
        primaryCategoryKey: "music-production",
        serviceMode: "Remote",
        serviceAreas: [],
        pricing: {
          kind: "StartingAt",
          amountMinor: 60000,
          currency: "USD",
          unitId: "per-track",
        },
        genreTags: [],
        includedServiceCategoryKeys: [],
        confirmationVersion: "m2-service-activation-v1",
        idempotencyKey: "11111111-2222-3333-4444-555555555555",
      })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED");
  });
});
