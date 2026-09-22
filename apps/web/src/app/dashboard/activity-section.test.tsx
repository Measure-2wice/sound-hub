/* eslint-disable @typescript-eslint/no-floating-promises */
// Behavior tests for the dashboard activity section (M2 #83
// P1-001, P1-002, P2-002).
//
// Background: Codex review CHANGES_REQUESTED flagged that the
// dashboard's source-pattern tests could not catch cross-
// Workspace stale state, party-specific readiness, or partial-
// failure semantics. This file renders the extracted
// `DashboardActivitySection` with controlled props via
// `react-dom/server`, asserting on the actual rendered HTML so
// regressions in the gate logic fail at the behavior layer
// (not just at the source-text layer).
//
// The section is PURE: it derives its output from props only,
// never reading from hooks or context. That makes it directly
// renderable with `renderToString` — no SessionProvider wrapper
// required.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type * as React from "react";
import type {
  Bg1PublicWorkspaceV1,
  DealListItemPublicV1,
  ProjectRequestPublicV1,
} from "@soundhub/types";
import { DashboardActivitySection } from "./activity-section.js";

type RenderFn = (element: React.ReactElement) => string;
let renderToString: RenderFn | null = null;
async function loadRenderer(): Promise<RenderFn> {
  if (!renderToString) {
    const server = await import("react-dom/server");
    renderToString = (element) => server.renderToString(element);
  }
  return renderToString;
}

const BUYER_WS: Bg1PublicWorkspaceV1 = {
  workspaceId: "ws-buyer",
  slug: "buyer-slug",
  name: "Buyer Personal",
  workspaceType: "Personal",
  workspaceStatus: "Active",
  capabilities: ["Buyer"],
};
const SELLER_WS: Bg1PublicWorkspaceV1 = {
  workspaceId: "ws-seller",
  slug: "seller-slug",
  name: "Seller Personal",
  workspaceType: "Personal",
  workspaceStatus: "Active",
  capabilities: ["Seller"],
};
const BOTH_WS: Bg1PublicWorkspaceV1 = {
  workspaceId: "ws-both",
  slug: "both-slug",
  name: "Both Personal",
  workspaceType: "Personal",
  workspaceStatus: "Active",
  capabilities: ["Buyer", "Seller"],
};

function buyerPendingRequest(): ProjectRequestPublicV1 {
  return {
    projectRequestId: "req-buyer-1",
    buyerWorkspaceId: "ws-buyer",
    sellerWorkspaceId: "ws-seller",
    serviceOfferingId: "so-1",
    projectBriefId: "brief-1",
    status: "Pending",
    sellerDecisionAt: null,
    sellerConsentAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    buyerWorkspaceName: "Buyer Personal",
    sellerWorkspaceName: "Seller Personal",
    serviceOfferingTitle: "Mixing — Full Track",
    briefExcerpt: "I need a mix engineer.",
  };
}

function sellerPendingRequest(): ProjectRequestPublicV1 {
  return {
    ...buyerPendingRequest(),
    projectRequestId: "req-seller-1",
    buyerWorkspaceId: "ws-buyer-other",
    sellerWorkspaceId: "ws-seller",
  };
}

function buyerSideDeal(): DealListItemPublicV1 {
  return {
    dealId: "deal-1",
    status: "Negotiating",
    actingSide: "Buyer",
    counterpartyWorkspaceName: "Seller Personal",
    serviceOfferingTitle: "Mixing — Full Track",
    currentTermsVersion: 1,
    approvalState: "AwaitingBuyerApproval",
    fundingStatus: null,
    activatedAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
  };
}

function sellerSideDeal(): DealListItemPublicV1 {
  return {
    dealId: "deal-2",
    status: "Negotiating",
    actingSide: "Seller",
    counterpartyWorkspaceName: "Buyer Personal",
    serviceOfferingTitle: "Mixing — Full Track",
    currentTermsVersion: 1,
    approvalState: "AwaitingSellerApproval",
    fundingStatus: null,
    activatedAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
  };
}

describe("DashboardActivitySection behavior (M2 #83)", () => {
  // ---------- P1-001: cross-Workspace stale state gate ----------

  test("P1-001: actor switch with loadedForWorkspaceId=null renders NO activity, hint, or error surfaces", async () => {
    // When the actor switches Workspaces and the new fetch is
    // in flight, the section MUST render nothing for the new
    // actor — even though state from the previous Workspace
    // could still be present in props.
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[buyerPendingRequest()]}
        deals={[buyerSideDeal()]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer
        hasSeller
        actingWorkspace={BUYER_WS}
        loadedForWorkspaceId={null}
      />,
    );
    assert.equal(
      html.includes('data-testid="dashboard-activity"'),
      false,
      "activity card MUST NOT render when loadedForWorkspaceId is null",
    );
    assert.equal(
      html.includes('data-testid="dashboard-activity-error"'),
      false,
      "error card MUST NOT render when loadedForWorkspaceId is null",
    );
    assert.equal(
      html.includes('data-testid="dashboard-approval-readiness-buyer"'),
      false,
      "buyer approval readiness MUST NOT render when loadedForWorkspaceId is null",
    );
    assert.equal(
      html.includes('data-testid="dashboard-approval-readiness-seller"'),
      false,
      "seller approval readiness MUST NOT render when loadedForWorkspaceId is null",
    );
  });

  test("P1-001: actor switch from A to B (loadedForWorkspaceId === A) renders NO B-side activity", async () => {
    // Behavior-level proof of the cross-Workspace stale state
    // bug the review flagged. With the actor now on Workspace
    // B but loadedForWorkspaceId still pointing at A, the
    // section MUST render nothing — A's counts and A's approval
    // hints cannot leak into B's view.
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[buyerPendingRequest()]}
        deals={[buyerSideDeal()]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer
        hasSeller
        actingWorkspace={SELLER_WS}
        loadedForWorkspaceId={BUYER_WS.workspaceId}
      />,
    );
    assert.equal(
      html.includes('data-testid="dashboard-activity"'),
      false,
      "A's activity MUST NOT render when actor is on B",
    );
    assert.equal(
      html.includes('data-testid="dashboard-activity-error"'),
      false,
      "A's error card MUST NOT render when actor is on B",
    );
    assert.equal(
      html.includes('data-testid="dashboard-approval-readiness-buyer"'),
      false,
      "A's buyer-approval hint MUST NOT render when actor is on B",
    );
    assert.equal(
      html.includes("Pending requests you sent"),
      false,
      "A's request count text MUST NOT render when actor is on B",
    );
    assert.equal(
      html.includes("Deals negotiating"),
      false,
      "A's deal count link MUST NOT render when actor is on B",
    );
  });

  test("P1-001: when loadedForWorkspaceId matches the actor, the gate passes and counts render", async () => {
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[buyerPendingRequest()]}
        deals={[buyerSideDeal()]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer
        hasSeller={false}
        actingWorkspace={BUYER_WS}
        loadedForWorkspaceId={BUYER_WS.workspaceId}
      />,
    );
    assert.ok(
      html.includes('data-testid="dashboard-activity"'),
      "activity card MUST render when loadedForWorkspaceId matches",
    );
    assert.ok(
      html.includes("Pending requests you sent"),
      "buyer-pending text MUST render for the current actor",
    );
  });

  // ---------- Populated, empty, partial-failure ----------

  test("populated activity: counts render for the matching actor", async () => {
    const render = await loadRenderer();
    // Use BOTH_WS but craft the requests so each side resolves
    // against `actingWorkspace.workspaceId === "ws-both"`. The
    // section filters by the actor's id, so the fixture must
    // carry the matching ids.
    const buyerReq: ProjectRequestPublicV1 = {
      ...buyerPendingRequest(),
      buyerWorkspaceId: BOTH_WS.workspaceId,
    };
    const sellerReq: ProjectRequestPublicV1 = {
      ...sellerPendingRequest(),
      sellerWorkspaceId: BOTH_WS.workspaceId,
    };
    const buyerDeal: DealListItemPublicV1 = {
      ...buyerSideDeal(),
      actingSide: "Buyer",
    };
    const sellerDeal: DealListItemPublicV1 = {
      ...sellerSideDeal(),
      actingSide: "Seller",
    };
    const html = render(
      <DashboardActivitySection
        requests={[buyerReq, sellerReq]}
        deals={[buyerDeal, sellerDeal]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer
        hasSeller
        actingWorkspace={BOTH_WS}
        loadedForWorkspaceId={BOTH_WS.workspaceId}
      />,
    );
    assert.ok(html.includes('data-testid="dashboard-activity"'));
    assert.ok(html.includes('data-testid="dashboard-activity-buyer-pending"'));
    assert.ok(html.includes('data-testid="dashboard-activity-seller-pending"'));
    assert.ok(html.includes('data-testid="dashboard-activity-deals"'));
  });

  test("empty activity: activity card is omitted when no records exist", async () => {
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[]}
        deals={[]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer
        hasSeller
        actingWorkspace={BOTH_WS}
        loadedForWorkspaceId={BOTH_WS.workspaceId}
      />,
    );
    assert.equal(
      html.includes('data-testid="dashboard-activity"'),
      false,
      "empty Workspace MUST NOT show a fabricated activity card",
    );
    assert.equal(
      html.includes('data-testid="dashboard-activity-error"'),
      false,
      "empty Workspace MUST NOT show the error card",
    );
  });

  test("P2-002 partial failure: requests fail, deals succeed — error card renders, deals count still renders", async () => {
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[]}
        deals={[buyerSideDeal()]}
        requestsLoadError={true}
        dealsLoadError={false}
        hasBuyer
        hasSeller={false}
        actingWorkspace={BUYER_WS}
        loadedForWorkspaceId={BUYER_WS.workspaceId}
      />,
    );
    assert.ok(
      html.includes('data-testid="dashboard-activity-error"'),
      "error card MUST render when requests list fails",
    );
    assert.ok(
      html.includes("Refresh the page"),
      "error card MUST include a recoverable retry hint",
    );
    assert.equal(
      html.includes('data-testid="dashboard-activity-buyer-pending"'),
      false,
      "buyer-pending row MUST NOT render on a failed requests list (independent failure)",
    );
  });

  test("P2-002 total failure: both lists fail — error card renders, no activity counts", async () => {
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[]}
        deals={[]}
        requestsLoadError={true}
        dealsLoadError={true}
        hasBuyer
        hasSeller
        actingWorkspace={BOTH_WS}
        loadedForWorkspaceId={BOTH_WS.workspaceId}
      />,
    );
    assert.ok(html.includes('data-testid="dashboard-activity-error"'));
    assert.equal(html.includes('data-testid="dashboard-activity"'), false);
  });

  // ---------- P1-002: party-appropriate readiness ----------

  test("P1-002: Buyer-side actor sees Buyer readiness, NOT Seller readiness", async () => {
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[]}
        deals={[buyerSideDeal()]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer
        hasSeller={false}
        actingWorkspace={BUYER_WS}
        loadedForWorkspaceId={BUYER_WS.workspaceId}
      />,
    );
    assert.ok(
      html.includes('data-testid="dashboard-approval-readiness-buyer"'),
      "Buyer-side hint MUST render for a Buyer-side Negotiating Deal",
    );
    assert.equal(
      html.includes('data-testid="dashboard-approval-readiness-seller"'),
      false,
      "Seller-side hint MUST NOT render when the actor is Buyer-only",
    );
  });

  test("P1-002: Buyer-only actor with a Seller-side Deal does NOT see Buyer readiness (Deal is on the wrong side)", async () => {
    // Behavior-level proof that approval readiness respects
    // the Deal's actingSide, not just the approval state. A
    // Buyer-only actor with a Deal in `AwaitingSellerApproval`
    // (seller already needs to act) MUST NOT see the buyer
    // readiness hint even though a Negotiating Deal is present.
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[]}
        deals={[sellerSideDeal()]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer
        hasSeller={false}
        actingWorkspace={BUYER_WS}
        loadedForWorkspaceId={BUYER_WS.workspaceId}
      />,
    );
    assert.equal(
      html.includes('data-testid="dashboard-approval-readiness-buyer"'),
      false,
      "Buyer readiness MUST NOT render when the Deal is on the Seller side",
    );
    assert.equal(
      html.includes('data-testid="dashboard-approval-readiness-seller"'),
      false,
      "Seller readiness MUST NOT render when the actor lacks Seller capability",
    );
  });

  test("P1-002: Seller-side actor sees Seller readiness, NOT Buyer readiness", async () => {
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[]}
        deals={[sellerSideDeal()]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer={false}
        hasSeller
        actingWorkspace={SELLER_WS}
        loadedForWorkspaceId={SELLER_WS.workspaceId}
      />,
    );
    assert.ok(
      html.includes('data-testid="dashboard-approval-readiness-seller"'),
      "Seller-side hint MUST render for a Seller-side Negotiating Deal",
    );
    assert.equal(
      html.includes('data-testid="dashboard-approval-readiness-buyer"'),
      false,
      "Buyer-side hint MUST NOT render when the actor is Seller-only",
    );
  });

  test("P1-002: dual-capability actor with both sides awaiting approval renders BOTH hints with party-appropriate copy", async () => {
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[]}
        deals={[buyerSideDeal(), sellerSideDeal()]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer
        hasSeller
        actingWorkspace={BOTH_WS}
        loadedForWorkspaceId={BOTH_WS.workspaceId}
      />,
    );
    assert.ok(html.includes('data-testid="dashboard-approval-readiness-buyer"'));
    assert.ok(html.includes('data-testid="dashboard-approval-readiness-seller"'));
    // Buyer-side copy MUST say "buyer approval"
    assert.ok(
      /buyer approval/.test(html),
      "Buyer-side readiness copy MUST mention 'buyer approval'",
    );
    // Seller-side copy MUST say "seller approval"
    assert.ok(
      /seller approval/.test(html),
      "Seller-side readiness copy MUST mention 'seller approval'",
    );
    // The Seller-side hint MUST NOT mention "buyer approval"
    const sellerHintBlock = html.match(
      /data-testid="dashboard-approval-readiness-seller"[\s\S]*?<\/p>/,
    );
    assert.ok(sellerHintBlock, "expected a Seller-side readiness block");
    assert.equal(
      /buyer approval/.test(sellerHintBlock[0]),
      false,
      "Seller-side hint MUST NOT contain 'buyer approval' wording",
    );
  });

  test("P1-002: irrelevant (no Negotiating Deal) state renders NO approval readiness", async () => {
    const render = await loadRenderer();
    const html = render(
      <DashboardActivitySection
        requests={[]}
        deals={[]}
        requestsLoadError={false}
        dealsLoadError={false}
        hasBuyer
        hasSeller
        actingWorkspace={BOTH_WS}
        loadedForWorkspaceId={BOTH_WS.workspaceId}
      />,
    );
    assert.equal(
      html.includes('data-testid="dashboard-approval-readiness-buyer"'),
      false,
      "Buyer-side hint MUST NOT render when there are no Negotiating Deals",
    );
    assert.equal(
      html.includes('data-testid="dashboard-approval-readiness-seller"'),
      false,
      "Seller-side hint MUST NOT render when there are no Negotiating Deals",
    );
  });
});
