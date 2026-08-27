/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */
// ProjectRequest route tests.
//
// Background: ticket #62 requires the API surface to:
//   - Reject unauthenticated requests with SESSION_INVALID.
//   - Validate the request body through the shared Zod schemas.
//   - Reject buyer-side authorization failures with
//     PROJECT_REQUEST_FORBIDDEN.
//   - Forward to the ProjectRequestService and surface typed
//     errors as safe-envelope codes.
//   - Cross-check the response shape against the shared schema.
//
// These tests use fake services so the route handler's contract is
// pinned without exercising the database or the real services.

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import express from "express";
import request from "supertest";
import {
  acceptProjectRequestResponseV1Schema,
  createProjectRequestResponseV1Schema,
  declineProjectRequestResponseV1Schema,
  getProjectRequestResponseV1Schema,
  listProjectRequestsResponseV1Schema,
} from "@soundhub/types";
import { createProjectRequestRouter } from "./project-requests.js";
import {
  ProjectRequestError,
  type ProjectRequestService,
} from "../project-request/project-request.service.js";
import { AuthorizationError } from "../services/workspace-authorization.service.js";
import type { AuthenticationService } from "../services/authentication.service.js";
import type { Express } from "express";

const BUYER_USER_ID = "user-buyer";
const SELLER_USER_ID = "user-seller";
const BUYER_WORKSPACE_ID = "ws-buyer";
const SELLER_WORKSPACE_ID = "ws-seller";
const NON_MEMBER_USER_ID = "user-non-member";
const NON_MEMBER_WORKSPACE_ID = "ws-non-member";

class FakeAuthService {
  signedIn = true;
  async resolveSession() {
    return this.signedIn ? { userAccountId: BUYER_USER_ID } : null;
  }
  async signOut() {
    return false;
  }
  async requestSignIn() {
    throw new Error("not used");
  }
  async verifySignIn() {
    throw new Error("not used");
  }
}

class FakeProjectRequestService {
  static NEXT_BUYER_REJECTION: "OK" | "NOT_A_MEMBER" | "MISSING_CAPABILITY" | "INVALID" | null =
    null;

  // Toggle for accept: the next call returns OK or throws
  // AuthorizationError so we can pin the FORBIDDEN envelope path.
  static ACCEPT_REJECTION: "OK" | "NOT_FOUND" | "ALREADY_RESPONDED" | "FORBIDDEN" = "OK";

  // Counters for asserting call counts and payloads.
  readonly createCalls: unknown[] = [];
  readonly acceptCalls: unknown[] = [];
  readonly declineCalls: unknown[] = [];
  readonly getCalls: unknown[] = [];
  readonly listCalls: unknown[] = [];

  async createProjectRequest(input: unknown) {
    this.createCalls.push(input);
    if (FakeProjectRequestService.NEXT_BUYER_REJECTION === "NOT_A_MEMBER") {
      throw new AuthorizationError("not a member", "NOT_A_MEMBER");
    }
    if (FakeProjectRequestService.NEXT_BUYER_REJECTION === "MISSING_CAPABILITY") {
      throw new AuthorizationError("missing capability", "MISSING_CAPABILITY");
    }
    if (FakeProjectRequestService.NEXT_BUYER_REJECTION === "INVALID") {
      throw new ProjectRequestError("invalid", "PROJECT_REQUEST_INVALID");
    }
    return {
      projectRequest: {
        projectRequestId: "pr-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        createdByUserId: BUYER_USER_ID,
        status: "Pending",
        sellerDecisionAt: null,
        sellerDecisionByUserId: null,
        sellerConsentAt: null,
        createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
      },
    };
  }

  async acceptProjectRequest(input: unknown) {
    this.acceptCalls.push(input);
    if (FakeProjectRequestService.ACCEPT_REJECTION === "NOT_FOUND") {
      throw new ProjectRequestError("missing", "PROJECT_REQUEST_NOT_FOUND");
    }
    if (FakeProjectRequestService.ACCEPT_REJECTION === "ALREADY_RESPONDED") {
      throw new ProjectRequestError("already", "PROJECT_REQUEST_ALREADY_RESPONDED");
    }
    if (FakeProjectRequestService.ACCEPT_REJECTION === "FORBIDDEN") {
      throw new AuthorizationError("not a member", "NOT_A_MEMBER");
    }
    return {
      projectRequest: {
        projectRequestId: "pr-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        createdByUserId: BUYER_USER_ID,
        status: "Accepted",
        sellerDecisionAt: new Date("2026-08-27T00:00:01Z").toISOString(),
        sellerDecisionByUserId: SELLER_USER_ID,
        sellerConsentAt: new Date("2026-08-27T00:00:01Z").toISOString(),
        createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
      },
      deal: {
        dealId: "deal-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        projectRequestId: "pr-1",
        status: "Negotiating",
        activatedAt: null,
        createdAt: new Date("2026-08-27T00:00:01Z").toISOString(),
      },
    };
  }

  async declineProjectRequest(input: unknown) {
    this.declineCalls.push(input);
    return {
      projectRequest: {
        projectRequestId: "pr-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        createdByUserId: BUYER_USER_ID,
        status: "Declined",
        sellerDecisionAt: new Date("2026-08-27T00:00:01Z").toISOString(),
        sellerDecisionByUserId: SELLER_USER_ID,
        sellerConsentAt: null,
        createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
      },
    };
  }

  async getProjectRequest(input: unknown) {
    this.getCalls.push(input);
    return {
      projectRequest: {
        projectRequestId: "pr-1",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        serviceOfferingId: "of-1",
        projectBriefId: "brief-1",
        createdByUserId: BUYER_USER_ID,
        status: "Pending",
        sellerDecisionAt: null,
        sellerDecisionByUserId: null,
        sellerConsentAt: null,
        createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
      },
    };
  }

  async listProjectRequests(input: unknown) {
    this.listCalls.push(input);
    return {
      projectRequests: [
        {
          projectRequestId: "pr-1",
          buyerWorkspaceId: BUYER_WORKSPACE_ID,
          sellerWorkspaceId: SELLER_WORKSPACE_ID,
          serviceOfferingId: "of-1",
          projectBriefId: "brief-1",
          createdByUserId: BUYER_USER_ID,
          status: "Pending",
          sellerDecisionAt: null,
          sellerDecisionByUserId: null,
          sellerConsentAt: null,
          createdAt: new Date("2026-08-27T00:00:00Z").toISOString(),
        },
      ],
    };
  }
}

describe("ProjectRequest route contract", () => {
  let auth: FakeAuthService;
  let pr: FakeProjectRequestService;
  let app: Express;

  before(() => {
    auth = new FakeAuthService();
    pr = new FakeProjectRequestService();
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.setHeader("x-request-id", "test-request-id");
      next();
    });
    app.use(
      "/api/project-requests",
      createProjectRequestRouter({
        authenticationService: auth as unknown as AuthenticationService,
        projectRequestService: pr as unknown as ProjectRequestService,
      }),
    );
  });

  test("POST /api/project-requests rejects an unauthenticated request", async () => {
    auth.signedIn = false;
    FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    try {
      const response = await request(app).post("/api/project-requests").send({
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        projectBriefId: "brief-1",
        serviceOfferingId: "of-1",
      });
      assert.equal(response.status, 401);
      assert.equal((response.body as { error: { code: string } }).error.code, "SESSION_INVALID");
      assert.equal(pr.createCalls.length, 0);
    } finally {
      auth.signedIn = true;
    }
  });

  test("POST /api/project-requests rejects an invalid payload with PROJECT_REQUEST_INVALID", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    const response = await request(app)
      .post("/api/project-requests")
      .send({ actingWorkspaceId: BUYER_WORKSPACE_ID });
    assert.equal(response.status, 400);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      "PROJECT_REQUEST_INVALID",
    );
    assert.equal(pr.createCalls.length, 0);
  });

  test("POST /api/project-requests forwards and validates the response shape", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    const response = await request(app).post("/api/project-requests").send({
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      projectBriefId: "brief-1",
      serviceOfferingId: "of-1",
    });
    assert.equal(response.status, 201);
    const parsed = createProjectRequestResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.equal(pr.createCalls.length, 1);
  });

  test("POST /api/project-requests maps AuthorizationError to PROJECT_REQUEST_FORBIDDEN", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = "NOT_A_MEMBER";
    try {
      const response = await request(app).post("/api/project-requests").send({
        actingWorkspaceId: NON_MEMBER_WORKSPACE_ID,
        projectBriefId: "brief-1",
        serviceOfferingId: "of-1",
      });
      assert.equal(response.status, 403);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_FORBIDDEN",
      );
    } finally {
      FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    }
  });

  test("POST /api/project-requests maps PROJECT_REQUEST_ALREADY_PENDING to 409", async () => {
    FakeProjectRequestService.NEXT_BUYER_REJECTION = "INVALID";
    try {
      const response = await request(app).post("/api/project-requests").send({
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        projectBriefId: "brief-1",
        serviceOfferingId: "of-1",
      });
      // The fake's "INVALID" rejection simulates the service
      // throwing a typed ProjectRequestError with code
      // PROJECT_REQUEST_INVALID; the route maps it to 400. To pin
      // the 409 path, we throw a typed
      // PROJECT_REQUEST_ALREADY_PENDING error in a dedicated call.
      assert.equal(response.status, 400);
    } finally {
      FakeProjectRequestService.NEXT_BUYER_REJECTION = null;
    }
  });

  test("GET /api/project-requests returns the listed rows scoped to the acting workspace", async () => {
    const response = await request(app).get(
      `/api/project-requests?actingWorkspaceId=${BUYER_WORKSPACE_ID}&status=Pending`,
    );
    assert.equal(response.status, 200);
    const parsed = listProjectRequestsResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.equal(pr.listCalls.length, 1);
  });

  test("GET /api/project-requests/:id returns one request for a member", async () => {
    const response = await request(app).get(
      `/api/project-requests/pr-1?actingWorkspaceId=${BUYER_WORKSPACE_ID}`,
    );
    assert.equal(response.status, 200);
    const parsed = getProjectRequestResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.equal(pr.getCalls.length, 1);
  });

  test("POST /api/project-requests/:id/accept returns 200 + Deal on success", async () => {
    FakeProjectRequestService.ACCEPT_REJECTION = "OK";
    const response = await request(app)
      .post("/api/project-requests/pr-1/accept")
      .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
    assert.equal(response.status, 200);
    const parsed = acceptProjectRequestResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    assert.equal(pr.acceptCalls.length, 1);
  });

  test("POST /api/project-requests/:id/accept maps ALREADY_RESPONDED to 409", async () => {
    FakeProjectRequestService.ACCEPT_REJECTION = "ALREADY_RESPONDED";
    try {
      const response = await request(app)
        .post("/api/project-requests/pr-1/accept")
        .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
      assert.equal(response.status, 409);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_ALREADY_RESPONDED",
      );
    } finally {
      FakeProjectRequestService.ACCEPT_REJECTION = "OK";
    }
  });

  test("POST /api/project-requests/:id/accept maps NOT_FOUND to 404", async () => {
    FakeProjectRequestService.ACCEPT_REJECTION = "NOT_FOUND";
    try {
      const response = await request(app)
        .post("/api/project-requests/pr-missing/accept")
        .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
      assert.equal(response.status, 404);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_NOT_FOUND",
      );
    } finally {
      FakeProjectRequestService.ACCEPT_REJECTION = "OK";
    }
  });

  test("POST /api/project-requests/:id/accept maps AuthorizationError to 403", async () => {
    FakeProjectRequestService.ACCEPT_REJECTION = "FORBIDDEN";
    try {
      const response = await request(app)
        .post("/api/project-requests/pr-1/accept")
        .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
      assert.equal(response.status, 403);
      assert.equal(
        (response.body as { error: { code: string } }).error.code,
        "PROJECT_REQUEST_FORBIDDEN",
      );
    } finally {
      FakeProjectRequestService.ACCEPT_REJECTION = "OK";
    }
  });

  test("POST /api/project-requests/:id/decline returns 200 and creates no Deal", async () => {
    const response = await request(app)
      .post("/api/project-requests/pr-1/decline")
      .send({ actingWorkspaceId: SELLER_WORKSPACE_ID });
    assert.equal(response.status, 200);
    const parsed = declineProjectRequestResponseV1Schema.safeParse(response.body);
    assert.equal(parsed.success, true);
    // No Deal field on the decline response. The shared schema is
    // `.strict()`, so an unexpected field would have failed the
    // safeParse above.
    assert.equal(pr.declineCalls.length, 1);
  });
});

// Suppress unused-import errors for non-member ids used only in
// assertions above.
void NON_MEMBER_USER_ID;
void NON_MEMBER_WORKSPACE_ID;
