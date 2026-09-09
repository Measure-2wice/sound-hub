/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/require-await */
// Deal-list route tests (ticket #74).
//
// Background: ticket #74 requires the API surface to:
//   - Reject unauthenticated requests with SESSION_INVALID.
//   - Validate `actingWorkspaceId` through the shared Zod schema.
//   - Surface the typed DealListError as DEAL_LIST_FORBIDDEN (403).
//   - Pass the SESSION's userAccountId to the service, never a
//     client-supplied one.
//   - Cross-check the response against the shared list schema.
//   - Never emit BG6 PaymentIntent internals on the list.
//
// These tests use fake services so the route contract is pinned
// without exercising the database.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import express from "express";
import request from "supertest";
import type { Express } from "express";
import { listDealsResponseV1Schema } from "@soundhub/types";
import { createDealListRouter } from "./deal-list.js";
import { DealListError } from "../deal-list/deal-list.service.js";

const USER_ID = "user-buyer";
const WORKSPACE_ID = "ws-buyer";
const DEAL_ID = "deal-1";

class FakeAuthService {
  signedIn = true;
  async resolveSession() {
    return this.signedIn ? { userAccountId: USER_ID } : null;
  }
}

class FakeDealListService {
  static REJECTION: "OK" | "FORBIDDEN" | "BOOM" = "OK";
  readonly calls: { userAccountId: string; actingWorkspaceId: string }[] = [];

  async listDeals(input: { userAccountId: string; actingWorkspaceId: string }) {
    this.calls.push(input);
    if (FakeDealListService.REJECTION === "FORBIDDEN") {
      throw new DealListError("You cannot view Deals for this Workspace.", "DEAL_LIST_FORBIDDEN");
    }
    if (FakeDealListService.REJECTION === "BOOM") {
      throw new Error("unexpected internal failure");
    }
    return {
      deals: [
        {
          dealId: DEAL_ID,
          status: "Negotiating" as const,
          actingSide: "Buyer" as const,
          counterpartyWorkspaceName: "Blue Mountain Studio",
          serviceOfferingTitle: "Mixing & Mastering — Full Track",
          currentTermsVersion: 2,
          approvalState: "AwaitingSellerApproval" as const,
          fundingStatus: null,
          activatedAt: null,
          createdAt: "2026-02-01T10:00:00.000Z",
        },
      ],
    };
  }
}

let app: Express;
let authService: FakeAuthService;
let dealListService: FakeDealListService;

before(() => {
  authService = new FakeAuthService();
  dealListService = new FakeDealListService();
  app = express();
  app.use(
    "/api/deals",
    createDealListRouter({
      authenticationService: authService,
      dealListService,
    }),
  );
});

function resetToggles(): void {
  authService.signedIn = true;
  FakeDealListService.REJECTION = "OK";
  dealListService.calls.length = 0;
}

test("returns the Deal list for an authenticated member", async () => {
  resetToggles();
  const response = await request(app)
    .get("/api/deals")
    .query({ actingWorkspaceId: WORKSPACE_ID })
    .set("Cookie", "soundhub_session=session-token");

  assert.equal(response.status, 200);
  // The response must satisfy the shared contract exactly.
  const parsed = listDealsResponseV1Schema.parse(response.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.deals.length, 1);
  assert.equal(parsed.deals[0]?.dealId, DEAL_ID);
});

test("passes the session's userAccountId and the commanded Workspace to the service", async () => {
  resetToggles();
  await request(app)
    .get("/api/deals")
    .query({ actingWorkspaceId: WORKSPACE_ID })
    .set("Cookie", "soundhub_session=session-token");

  assert.deepEqual(dealListService.calls, [
    { userAccountId: USER_ID, actingWorkspaceId: WORKSPACE_ID },
  ]);
});

test("a client-supplied userAccountId cannot override the session identity", async () => {
  resetToggles();
  await request(app)
    .get("/api/deals")
    .query({ actingWorkspaceId: WORKSPACE_ID, userAccountId: "user-attacker" })
    .set("Cookie", "soundhub_session=session-token");

  assert.equal(dealListService.calls[0]?.userAccountId, USER_ID);
});

test("rejects an unauthenticated request with SESSION_INVALID", async () => {
  resetToggles();
  authService.signedIn = false;

  const response = await request(app).get("/api/deals").query({ actingWorkspaceId: WORKSPACE_ID });

  assert.equal(response.status, 401);
  assert.equal((response.body as { error: { code: string } }).error.code, "SESSION_INVALID");
  assert.equal(
    dealListService.calls.length,
    0,
    "the service must not be reached without a session",
  );
});

test("rejects a missing actingWorkspaceId with DEAL_LIST_INVALID", async () => {
  resetToggles();
  const response = await request(app)
    .get("/api/deals")
    .set("Cookie", "soundhub_session=session-token");

  assert.equal(response.status, 400);
  assert.equal((response.body as { error: { code: string } }).error.code, "DEAL_LIST_INVALID");
  assert.equal(dealListService.calls.length, 0);
});

test("rejects an empty actingWorkspaceId with DEAL_LIST_INVALID", async () => {
  resetToggles();
  const response = await request(app)
    .get("/api/deals")
    .query({ actingWorkspaceId: "" })
    .set("Cookie", "soundhub_session=session-token");

  assert.equal(response.status, 400);
  assert.equal((response.body as { error: { code: string } }).error.code, "DEAL_LIST_INVALID");
});

test("surfaces a service authorization rejection as 403 DEAL_LIST_FORBIDDEN", async () => {
  resetToggles();
  FakeDealListService.REJECTION = "FORBIDDEN";

  const response = await request(app)
    .get("/api/deals")
    .query({ actingWorkspaceId: WORKSPACE_ID })
    .set("Cookie", "soundhub_session=session-token");

  assert.equal(response.status, 403);
  assert.equal((response.body as { error: { code: string } }).error.code, "DEAL_LIST_FORBIDDEN");
  // The envelope must not hint at whether the Workspace exists.
  assert.ok(!JSON.stringify(response.body).includes("not found"));
});

test("an unexpected failure surfaces as a safe envelope, not a stack trace", async () => {
  resetToggles();
  FakeDealListService.REJECTION = "BOOM";

  const response = await request(app)
    .get("/api/deals")
    .query({ actingWorkspaceId: WORKSPACE_ID })
    .set("Cookie", "soundhub_session=session-token");

  assert.equal(response.status >= 500, true);
  assert.equal((response.body as { error: { code: string } }).error.code, "DEAL_LIST_FAILED");
  assert.ok(!JSON.stringify(response.body).includes("unexpected internal failure"));
});

test("the response body exposes no BG6 payment or membership internals", async () => {
  resetToggles();
  const response = await request(app)
    .get("/api/deals")
    .query({ actingWorkspaceId: WORKSPACE_ID })
    .set("Cookie", "soundhub_session=session-token");

  const serialized = JSON.stringify(response.body);
  for (const forbidden of [
    "paymentIntentId",
    "correlationId",
    "providerReference",
    "providerKey",
    "assetLabel",
    "networkLabel",
    "environmentLabel",
    "buyerWorkspaceId",
    "sellerWorkspaceId",
    "ownerUserId",
  ]) {
    assert.ok(!serialized.includes(forbidden), `the Deal list must not expose ${forbidden}`);
  }
});
