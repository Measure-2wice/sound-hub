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
const SELLER_USER_ID = SELLER_USER;
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
    // The in-memory adapter maintains a minimal SellerProfile
    // registry so `createDraft` can find the precondition satisfied
    // AND the Reactivate publication check has access to the
    // current status. The route setup registers Published by
    // default; the Reactivate unpublished-profile test re-registers
    // a Draft profile before the call.
    serviceOfferingRepository._registerSellerProfile({
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Published",
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

  test("M2 (#85) PR-review feedback round 3: POST /draft creates the offering AND persists the supplied fields atomically", async () => {
    // The spec requires the stable identity to be created on the
    // first successful save. Clicking "Create service" on the
    // listing page must NOT persist an empty row that the seller
    // can navigate away from. The create-and-save is one atomic
    // transaction; the listing page navigates to the empty editor
    // and the first Save creates the row with the user's submitted
    // fields.
    const cookie = await signIn(SELLER_EMAIL);
    const idempotencyKey = "draft-create-save-1";
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/draft`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", idempotencyKey)
      .send(draftBody);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    const created = response.body.offering;
    assert.notEqual(
      created.serviceOfferingId,
      "",
      "POST /draft must return a non-empty offeringId",
    );
    assert.equal(created.title, draftBody.title);
    assert.equal(created.primaryCategoryKey, draftBody.primaryCategoryKey);
    assert.equal(created.pricing.kind, draftBody.pricing.kind);
    assert.equal(created.pricing.amountMinor, draftBody.pricing.amountMinor);
    assert.equal(created.status, "Draft");
    // The newly created offering is reachable via the regular
    // OwnerView GET endpoint so subsequent saves (PUT) can find it.
    const followup = await request(app)
      .get(
        `/api/workspaces/${PERSONAL_WS}/service-offerings/${encodeURIComponent(String(created.serviceOfferingId))}`,
      )
      .set("Cookie", cookie);
    assert.equal(followup.status, 200);
    assert.equal(followup.body.offering.serviceOfferingId, created.serviceOfferingId);
    assert.equal(followup.body.offering.title, draftBody.title);
  });

  test("M2 (#85) PR-review feedback round 3: same-attempt POST /draft retry converges on the same offeringId (and the same persisted fields)", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const idempotencyKey = "draft-create-save-converge-1";
    const first = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/draft`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", idempotencyKey)
      .send(draftBody);
    assert.equal(first.status, 201);
    const firstId = first.body.offering.serviceOfferingId;
    // Same idempotencyKey + same payload → returns the SAME
    // offeringId (DB unique constraint + service-layer pre-check).
    const second = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/draft`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", idempotencyKey)
      .send(draftBody);
    assert.equal(second.status, 201);
    assert.equal(second.body.offering.serviceOfferingId, firstId);
  });

  test("M2 (#85) PR-review feedback round 3: a fresh idempotencyKey creates a NEW offering (deliberate second click)", async () => {
    const cookie = await signIn(SELLER_EMAIL);
    const first = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/draft`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "draft-create-save-fresh-A")
      .send(draftBody);
    const second = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/draft`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "draft-create-save-fresh-B")
      .send(draftBody);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(
      first.body.offering.serviceOfferingId,
      second.body.offering.serviceOfferingId,
      "distinct idempotencyKeys create distinct offerings",
    );
  });

  test("M2 (#85) PR-review feedback round 4: malformed JSON on POST /draft does NOT create an empty Draft", async () => {
    // Round 3 promised "no empty orphan rows". With every draft
    // field optional and a valid `Idempotency-Key` header, a
    // request whose body fails to parse MUST be rejected with
    // SERVICE_OFFERING_INVALID — not silently coerced to `undefined`
    // and routed through the all-optional create schema (which
    // would create an empty Draft on every failure).
    const cookie = await signIn(SELLER_EMAIL);
    const before = await request(app)
      .get(`/api/workspaces/${PERSONAL_WS}/service-offerings`)
      .set("Cookie", cookie);
    const beforeCount = (before.body.offerings ?? []).length;
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/draft`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "draft-malformed-body-1")
      // Intentionally malformed JSON: trailing comma + unbalanced
      // braces. The route's `readBody` throws.
      .send('{"title": "oops",}');
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "SERVICE_OFFERING_INVALID");
    const after = await request(app)
      .get(`/api/workspaces/${PERSONAL_WS}/service-offerings`)
      .set("Cookie", cookie);
    const afterCount = (after.body.offerings ?? []).length;
    assert.equal(afterCount, beforeCount, "malformed body must not have persisted a new Draft");
  });

  test("M2 (#85) PR-review feedback round 4: oversized JSON body on POST /draft returns SERVICE_OFFERING_INVALID without creating a Draft", async () => {
    // The route's `readBody` enforces a hard byte limit and
    // throws when exceeded. With a valid `Idempotency-Key` header
    // and every draft field optional, the old behavior would
    // silently coerce the parse failure to `undefined` and create
    // an empty Draft; the round-4 fix rejects at the boundary.
    const cookie = await signIn(SELLER_EMAIL);
    const before = await request(app)
      .get(`/api/workspaces/${PERSONAL_WS}/service-offerings`)
      .set("Cookie", cookie);
    const beforeCount = (before.body.offerings ?? []).length;
    // 64 KB JSON body — comfortably above the route's 32 KB limit.
    const oversized = JSON.stringify({
      title: "x".repeat(64 * 1024),
      description: "y",
      idempotencyKey: "draft-oversized-body-1",
    });
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/draft`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .set("Idempotency-Key", "draft-oversized-body-1")
      .send(oversized);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error.code, "SERVICE_OFFERING_INVALID");
    const after = await request(app)
      .get(`/api/workspaces/${PERSONAL_WS}/service-offerings`)
      .set("Cookie", cookie);
    const afterCount = (after.body.offerings ?? []).length;
    assert.equal(afterCount, beforeCount, "oversized body must not have persisted a new Draft");
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

  // M2 (#86, slice 86B): POST pause route coverage.
  // The in-memory adapter seeds the offering as Draft in `beforeEach`.
  // The Pause precondition requires Active state, so each Pause test
  // re-seeds the offering as Active before the call. The Published-
  // SellerProfile path is NOT a Pause precondition — Pause does not
  // require the SellerProfile to be Published, only that the actor
  // is a current Personal-Workspace member with Seller capability.

  function seedAsActive(id: string): void {
    serviceOfferingRepository._seedOffering({
      id,
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Active",
    });
  }

  test("POST pause without a session returns SESSION_INVALID", async () => {
    seedAsActive("of_test_pause_no_session");
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_pause_no_session/pause`)
      .send({ idempotencyKey: "11111111-2222-3333-4444-555555555555" })
      .set("Content-Type", "application/json");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "SESSION_INVALID");
  });

  test("POST pause on an Organization Workspace returns SERVICE_OFFERING_FORBIDDEN", async () => {
    seedAsActive("of_test_pause_org");
    const cookie = await signIn(ORG_SELLER_EMAIL);
    const response = await request(app)
      .post(`/api/workspaces/${ORG_WS}/service-offerings/of_test_pause_org/pause`)
      .send({ idempotencyKey: "11111111-2222-3333-4444-555555555555" })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_FORBIDDEN");
  });

  test("POST pause with a non-UUID idempotencyKey returns SERVICE_OFFERING_INVALID", async () => {
    seedAsActive("of_test_pause_bad_uuid");
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_pause_bad_uuid/pause`)
      .send({ idempotencyKey: "not-a-uuid" })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_INVALID");
  });

  test("POST pause on an Active offering returns 200 with paused status and a pause evidence shape", async () => {
    seedAsActive("of_test_pause_active");
    const cookie = await signIn(SELLER_EMAIL);
    const idempotencyKey = "11111111-2222-3333-4444-aaaaaaaaaaaa";
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_pause_active/pause`)
      .send({ idempotencyKey })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.offering.status, "Paused");
    assert.equal(response.body.evidence.reason, "user_initiated");
    assert.equal(response.body.evidence.idempotencyKey, idempotencyKey);
  });

  test("POST pause same-key retry returns 200 with converged success", async () => {
    seedAsActive("of_test_pause_retry");
    const cookie = await signIn(SELLER_EMAIL);
    const idempotencyKey = "11111111-2222-3333-4444-bbbbbbbbbbbb";
    const first = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_pause_retry/pause`)
      .send({ idempotencyKey })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(first.status, 200);
    const second = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_pause_retry/pause`)
      .send({ idempotencyKey })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.evidence, first.body.evidence);
  });

  test("POST pause on a Draft offering returns 409 SERVICE_OFFERING_NOT_ACTIVE", async () => {
    // `of_test_1` is seeded as Draft by `beforeEach`.
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_1/pause`)
      .send({ idempotencyKey: "11111111-2222-3333-4444-cccccccccccc" })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_NOT_ACTIVE");
  });

  test("POST pause different-key on a Paused offering returns 409 SERVICE_OFFERING_ALREADY_PAUSED", async () => {
    seedAsActive("of_test_pause_dbl");
    const cookie = await signIn(SELLER_EMAIL);
    const first = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_pause_dbl/pause`)
      .send({ idempotencyKey: "11111111-2222-3333-4444-dddddddddddd" })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(first.status, 200);
    const second = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_pause_dbl/pause`)
      .send({ idempotencyKey: "22222222-3333-4444-5555-eeeeeeeeeeee" })
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "SERVICE_OFFERING_ALREADY_PAUSED");
  });

  // M2 (#86, slice 86B): POST reactivate route coverage.
  // The activate-route test pattern (above) is mirrored. Reactivate
  // requires the SellerProfile.published precondition (same as
  // activate), so the route returns SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED
  // for the test fixture (which seeds `getSellerProfileStatus: () => null`).

  function seedAsPaused(id: string): void {
    serviceOfferingRepository._seedOffering({
      id,
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Paused",
    });
  }

  const reactivateBody = {
    title: "Haitian dancehall production",
    description: "Arrangement + recording direction + editing.",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: { kind: "StartingAt", amountMinor: 60000, currency: "USD", unitId: "per-track" },
    genreTags: [],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey: "11111111-2222-3333-4444-ffffffffffff",
  } as const;

  test("POST reactivate without a session returns SESSION_INVALID", async () => {
    seedAsPaused("of_test_reactivate_no_session");
    const response = await request(app)
      .post(
        `/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_reactivate_no_session/reactivate`,
      )
      .send(reactivateBody)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "SESSION_INVALID");
  });

  test("POST reactivate on an unpublished SellerProfile returns SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED", async () => {
    seedAsPaused("of_test_reactivate_unpub");
    // The repository's Reactivate publication check runs inside the
    // transaction and reads the SellerProfile status from the
    // in-memory registry; the default Published registration must
    // be overwritten with a Draft status to surface the precondition
    // rejection.
    serviceOfferingRepository._registerSellerProfile({
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Draft",
    });
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .post(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_reactivate_unpub/reactivate`)
      .send(reactivateBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED");
  });

  // M2 (#86, slice 86C): PUT /update route coverage. The Update
  // command is Active → Active; it requires the SellerProfile
  // .published precondition (same as Activate / Reactivate) and
  // the strict activation completeness contract (same as Activate
  // / Reactivate). The response shape is the dedicated
  // `serviceOfferingUpdateResponseV1Schema` (carries `updatedAt`
  // rather than `activatedAt`).
  const updateBody = {
    title: "Updated service title",
    description: "Updated service description.",
    primaryCategoryKey: "music-production",
    serviceMode: "Remote",
    serviceAreas: [],
    pricing: { kind: "StartingAt", amountMinor: 75000, currency: "USD", unitId: "per-track" },
    genreTags: ["dancehall"],
    includedServiceCategoryKeys: [],
    confirmationVersion: "m2-service-activation-v1",
    idempotencyKey: "44444444-5555-6666-7777-888888888881",
  };

  void test("PUT /update returns 200 + serviceOfferingUpdateResponseV1 shape on happy path", async () => {
    seedAsActive("of_test_update_happy");
    serviceOfferingRepository._seedSample("of_test_update_happy", {
      sampleId: "smp_update_happy",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://update-happy",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: SELLER_USER_ID,
        confirmedAt: new Date(),
      },
    });
    // Register the SellerProfile as Published so the in-tx
    // SellerProfile.published check passes.
    serviceOfferingRepository._registerSellerProfile({
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Published",
    });
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_update_happy/update`)
      .send(updateBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.offering.status, "Active");
    assert.equal(response.body.offering.title, "Updated service title");
    // The `updatedAt` is the timestamp of the update evidence row,
    // NOT the activation timestamp (which is preserved verbatim).
    assert.ok(typeof response.body.evidence.updatedAt === "string");
    assert.equal(response.body.evidence.confirmationVersion, "m2-service-activation-v1");
    assert.equal(response.body.evidence.idempotencyKey, "44444444-5555-6666-7777-888888888881");
  });

  void test("PUT /update same-key retry returns converged success", async () => {
    seedAsActive("of_test_update_idem");
    serviceOfferingRepository._seedSample("of_test_update_idem", {
      sampleId: "smp_update_idem",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://update-idem",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: SELLER_USER_ID,
        confirmedAt: new Date(),
      },
    });
    serviceOfferingRepository._registerSellerProfile({
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Published",
    });
    const cookie = await signIn(SELLER_EMAIL);
    // First call.
    const first = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_update_idem/update`)
      .send(updateBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(first.status, 200);
    // Same-key retry.
    const retry = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_update_idem/update`)
      .send(updateBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body.evidence, first.body.evidence);
  });

  void test("PUT /update on a Paused offering returns 409 SERVICE_OFFERING_NOT_ACTIVE", async () => {
    // The Paused offering is seeded (Draft at the same time would
    // also surface this error — the precondition is `status ===
    // Active`).
    serviceOfferingRepository._seedOffering({
      id: "of_test_update_paused",
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Paused",
    });
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_update_paused/update`)
      .send(updateBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_NOT_ACTIVE");
  });

  void test("PUT /update with zero CONFIRMED Live samples returns 422 SERVICE_OFFERING_INVALID_UPDATE with samples_required", async () => {
    // The repository's completeness recheck enforces
    // 1..BG2_AUDIO_SAMPLE_MAX_PER_OFFERING CONFIRMED Live samples.
    // A new STRICT request validates the schema but seeds no
    // sample, so the repository's in-tx count check trips and
    // throws `ServiceOfferingInvalidUpdateError` carrying the
    // `samples_required` field error.
    seedAsActive("of_test_update_no_samples");
    // No sample is seeded — the completeness recheck trips on the
    // sample-count predicate inside the repository transaction.
    serviceOfferingRepository._registerSellerProfile({
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Published",
    });
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_update_no_samples/update`)
      .send(updateBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_INVALID_UPDATE");
    assert.ok(
      Array.isArray(response.body.error.fields) &&
        (
          response.body.error.fields as ReadonlyArray<{
            path: string;
            code: string;
          }>
        ).some((f) => f.path === "samples" && f.code === "samples_required"),
      "SERVICE_OFFERING_INVALID_UPDATE must carry the samples_required field error",
    );
  });

  void test("PUT /update without SellerProfile Published returns 422 SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED", async () => {
    seedAsActive("of_test_update_unpub");
    serviceOfferingRepository._seedSample("of_test_update_unpub", {
      sampleId: "smp_update_unpub",
      label: "Demo",
      byteSize: 1024,
      displayOrder: 1,
      storageRef: "ref://update-unpub",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: SELLER_USER_ID,
        confirmedAt: new Date(),
      },
    });
    // The repository's Update publication check runs inside the
    // transaction and reads the SellerProfile status from the
    // in-memory registry; the default Published registration must
    // be overwritten with a Draft status to surface the precondition
    // rejection.
    serviceOfferingRepository._registerSellerProfile({
      workspaceId: PERSONAL_WS,
      sellerProfileId: "sp_test",
      status: "Draft",
    });
    const cookie = await signIn(SELLER_EMAIL);
    const response = await request(app)
      .put(`/api/workspaces/${PERSONAL_WS}/service-offerings/of_test_update_unpub/update`)
      .send(updateBody)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "SERVICE_OFFERING_SELLER_PROFILE_NOT_PUBLISHED");
  });
});
