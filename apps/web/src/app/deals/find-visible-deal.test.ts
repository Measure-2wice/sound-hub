/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Bg5GetDealResponseV1 } from "@soundhub/types";
import { findVisibleDeal } from "./find-visible-deal.js";

const visibleDeal = {
  deal: {
    deal: {
      dealId: "deal-1",
      buyerWorkspaceId: "ws-buyer",
      sellerWorkspaceId: "ws-seller",
      serviceOfferingId: "offering-1",
      projectBriefId: "brief-1",
      projectRequestId: "request-1",
      status: "Negotiating",
      activatedAt: null,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    currentTermsVersion: null,
    currentApprovals: [],
  },
} satisfies Bg5GetDealResponseV1;

describe("BG5 Deal bootstrap", () => {
  test("loads an authorized Deal before its party Workspaces are known", async () => {
    const calls: string[] = [];
    const result = await findVisibleDeal({
      dealId: "deal-1",
      workspaceIds: ["ws-seller"],
      fetchDeal: (_dealId, workspaceId) => {
        calls.push(workspaceId);
        return Promise.resolve(visibleDeal);
      },
    });

    assert.deepEqual(calls, ["ws-seller"]);
    assert.equal(result.actingWorkspaceId, "ws-seller");
    assert.equal(result.response.deal.deal.dealId, "deal-1");
  });

  test("tries another current Workspace only after a safe DEAL_NOT_FOUND response", async () => {
    const calls: string[] = [];
    const notFound = Object.assign(new Error("Deal not found."), { code: "DEAL_NOT_FOUND" });
    const result = await findVisibleDeal({
      dealId: "deal-1",
      workspaceIds: ["ws-unrelated", "ws-seller"],
      fetchDeal: (_dealId, workspaceId) => {
        calls.push(workspaceId);
        if (workspaceId === "ws-unrelated") return Promise.reject(notFound);
        return Promise.resolve(visibleDeal);
      },
    });

    assert.deepEqual(calls, ["ws-unrelated", "ws-seller"]);
    assert.equal(result.actingWorkspaceId, "ws-seller");
  });

  test("does not hide session failures by probing another Workspace", async () => {
    const calls: string[] = [];
    const sessionError = Object.assign(new Error("Session expired."), {
      code: "SESSION_EXPIRED",
    });

    await assert.rejects(
      findVisibleDeal({
        dealId: "deal-1",
        workspaceIds: ["ws-one", "ws-two"],
        fetchDeal: (_dealId, workspaceId) => {
          calls.push(workspaceId);
          return Promise.reject(sessionError);
        },
      }),
      sessionError,
    );
    assert.deepEqual(calls, ["ws-one"]);
  });
});
