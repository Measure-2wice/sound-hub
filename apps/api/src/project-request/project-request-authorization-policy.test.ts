/* eslint-disable @typescript-eslint/no-floating-promises */
// ProjectRequest authorization policy shared tests (P1-003).
//
// Background: the application owns the buyer / seller authorization
// policy; the repository adapters (Prisma + in-memory) MUST
// interpret authority identically. These tests pin the policy
// helpers directly and prove a new adapter cannot redefine the
// semantics — both adapters consume the same evaluators and must
// surface the same typed failure reasons.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  evaluateBriefRecommendationBoundary,
  evaluateBuyerAuthority,
  evaluateSellerAuthority,
  evaluateSellerEligibility,
} from "./project-request-authorization-policy.js";

describe("project-request-authorization-policy", () => {
  describe("evaluateBuyerAuthority", () => {
    test("Active workspace, current member, Buyer capability is ok", () => {
      const verdict = evaluateBuyerAuthority({
        userAccountId: "u-1",
        buyerWorkspaceId: "ws-1",
        workspaceStatus: "Active",
        isMember: true,
        hasBuyerCapability: true,
      });
      assert.deepEqual(verdict, { ok: true });
    });

    test("Suspended workspace is rejected with WORKSPACE_INELIGIBLE", () => {
      const verdict = evaluateBuyerAuthority({
        userAccountId: "u-1",
        buyerWorkspaceId: "ws-1",
        workspaceStatus: "Suspended",
        isMember: true,
        hasBuyerCapability: true,
      });
      assert.deepEqual(verdict, { ok: false, reason: "WORKSPACE_INELIGIBLE" });
    });

    test("missing WorkspaceMembership is rejected with NOT_A_MEMBER", () => {
      const verdict = evaluateBuyerAuthority({
        userAccountId: "u-1",
        buyerWorkspaceId: "ws-1",
        workspaceStatus: "Active",
        isMember: false,
        hasBuyerCapability: true,
      });
      assert.deepEqual(verdict, { ok: false, reason: "NOT_A_MEMBER" });
    });

    test("missing Buyer capability is rejected with MISSING_CAPABILITY", () => {
      const verdict = evaluateBuyerAuthority({
        userAccountId: "u-1",
        buyerWorkspaceId: "ws-1",
        workspaceStatus: "Active",
        isMember: true,
        hasBuyerCapability: false,
      });
      assert.deepEqual(verdict, { ok: false, reason: "MISSING_CAPABILITY" });
    });

    test("policy ordering — workspace status is checked first", () => {
      // Even with no membership / capability, a Suspended workspace
      // surfaces WORKSPACE_INELIGIBLE so the safe envelope doesn't
      // leak membership facts.
      const verdict = evaluateBuyerAuthority({
        userAccountId: "u-1",
        buyerWorkspaceId: "ws-1",
        workspaceStatus: "Suspended",
        isMember: false,
        hasBuyerCapability: false,
      });
      assert.deepEqual(verdict, { ok: false, reason: "WORKSPACE_INELIGIBLE" });
    });
  });

  describe("evaluateSellerEligibility", () => {
    test("Active workspace + Seller capability + Published profile + Active offering is ok", () => {
      const verdict = evaluateSellerEligibility({
        serviceOfferingId: "of-1",
        sellerWorkspaceId: "ws-seller",
        offeringStatus: "Active",
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        profileStatus: "Published",
      });
      assert.deepEqual(verdict, { ok: true, sellerWorkspaceId: "ws-seller" });
    });

    test("missing offering is rejected with OFFERING_NOT_FOUND", () => {
      const verdict = evaluateSellerEligibility({
        serviceOfferingId: "of-missing",
        sellerWorkspaceId: null,
        offeringStatus: null,
        workspaceStatus: null,
        workspaceHasSellerCapability: null,
        profileStatus: null,
      });
      assert.deepEqual(verdict, { ok: false, reason: "OFFERING_NOT_FOUND" });
    });

    test("Suspended seller Workspace is rejected with WORKSPACE_INELIGIBLE", () => {
      const verdict = evaluateSellerEligibility({
        serviceOfferingId: "of-1",
        sellerWorkspaceId: "ws-seller",
        offeringStatus: "Active",
        workspaceStatus: "Suspended",
        workspaceHasSellerCapability: true,
        profileStatus: "Published",
      });
      assert.deepEqual(verdict, { ok: false, reason: "WORKSPACE_INELIGIBLE" });
    });

    test("missing Seller capability is rejected with MISSING_CAPABILITY", () => {
      const verdict = evaluateSellerEligibility({
        serviceOfferingId: "of-1",
        sellerWorkspaceId: "ws-seller",
        offeringStatus: "Active",
        workspaceStatus: "Active",
        workspaceHasSellerCapability: false,
        profileStatus: "Published",
      });
      assert.deepEqual(verdict, { ok: false, reason: "MISSING_CAPABILITY" });
    });

    test("Draft SellerProfile is rejected with PROFILE_NOT_PUBLISHED", () => {
      const verdict = evaluateSellerEligibility({
        serviceOfferingId: "of-1",
        sellerWorkspaceId: "ws-seller",
        offeringStatus: "Active",
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        profileStatus: "Draft",
      });
      assert.deepEqual(verdict, { ok: false, reason: "PROFILE_NOT_PUBLISHED" });
    });

    test("Paused offering is rejected with OFFERING_NOT_ACTIVE", () => {
      const verdict = evaluateSellerEligibility({
        serviceOfferingId: "of-1",
        sellerWorkspaceId: "ws-seller",
        offeringStatus: "Paused",
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        profileStatus: "Published",
      });
      assert.deepEqual(verdict, { ok: false, reason: "OFFERING_NOT_ACTIVE" });
    });

    test("Archived offering is rejected with OFFERING_NOT_ACTIVE", () => {
      const verdict = evaluateSellerEligibility({
        serviceOfferingId: "of-1",
        sellerWorkspaceId: "ws-seller",
        offeringStatus: "Archived",
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        profileStatus: "Published",
      });
      assert.deepEqual(verdict, { ok: false, reason: "OFFERING_NOT_ACTIVE" });
    });

    test("policy ordering — workspace suspension is checked before capability / profile / offering", () => {
      const verdict = evaluateSellerEligibility({
        serviceOfferingId: "of-1",
        sellerWorkspaceId: "ws-seller",
        offeringStatus: "Archived",
        workspaceStatus: "Suspended",
        workspaceHasSellerCapability: false,
        profileStatus: "Draft",
      });
      assert.deepEqual(verdict, { ok: false, reason: "WORKSPACE_INELIGIBLE" });
    });
  });

  describe("evaluateBriefRecommendationBoundary", () => {
    test("an offering surfaced by Matchmaker for this brief is ok", () => {
      const verdict = evaluateBriefRecommendationBoundary(
        {
          projectBriefId: "brief-1",
          buyerWorkspaceId: "ws-buyer",
          exists: true,
          offeringIds: ["of-a", "of-b"],
        },
        "of-b",
        "ws-buyer",
      );
      assert.deepEqual(verdict, { ok: true });
    });

    test("an offering absent from the brief's recommendations is rejected", () => {
      const verdict = evaluateBriefRecommendationBoundary(
        {
          projectBriefId: "brief-1",
          buyerWorkspaceId: "ws-buyer",
          exists: true,
          offeringIds: ["of-a"],
        },
        "of-other",
        "ws-buyer",
      );
      assert.deepEqual(verdict, { ok: false, reason: "OFFERING_NOT_IN_BRIEF" });
    });

    test("a missing brief is rejected with BRIEF_NOT_FOUND", () => {
      const verdict = evaluateBriefRecommendationBoundary(
        {
          projectBriefId: "brief-missing",
          buyerWorkspaceId: null,
          exists: false,
          offeringIds: [],
        },
        "of-1",
        "ws-buyer",
      );
      assert.deepEqual(verdict, { ok: false, reason: "BRIEF_NOT_FOUND" });
    });

    test("a brief owned by another Workspace is rejected with BRIEF_FORBIDDEN", () => {
      const verdict = evaluateBriefRecommendationBoundary(
        {
          projectBriefId: "brief-1",
          buyerWorkspaceId: "ws-other",
          exists: true,
          offeringIds: ["of-a"],
        },
        "of-a",
        "ws-buyer",
      );
      assert.deepEqual(verdict, { ok: false, reason: "BRIEF_FORBIDDEN" });
    });
  });

  describe("evaluateSellerAuthority", () => {
    test("Active workspace, current member, Seller capability, matching seller side is ok", () => {
      const verdict = evaluateSellerAuthority({
        userAccountId: "u-2",
        actingWorkspaceId: "ws-2",
        projectRequestSellerWorkspaceId: "ws-2",
        workspaceStatus: "Active",
        isMember: true,
        hasSellerCapability: true,
      });
      assert.deepEqual(verdict, { ok: true });
    });

    test("Suspended workspace is rejected with WORKSPACE_INELIGIBLE", () => {
      const verdict = evaluateSellerAuthority({
        userAccountId: "u-2",
        actingWorkspaceId: "ws-2",
        projectRequestSellerWorkspaceId: "ws-2",
        workspaceStatus: "Suspended",
        isMember: true,
        hasSellerCapability: true,
      });
      assert.deepEqual(verdict, { ok: false, reason: "WORKSPACE_INELIGIBLE" });
    });

    test("missing WorkspaceMembership is rejected with NOT_A_MEMBER", () => {
      const verdict = evaluateSellerAuthority({
        userAccountId: "u-2",
        actingWorkspaceId: "ws-2",
        projectRequestSellerWorkspaceId: "ws-2",
        workspaceStatus: "Active",
        isMember: false,
        hasSellerCapability: true,
      });
      assert.deepEqual(verdict, { ok: false, reason: "NOT_A_MEMBER" });
    });

    test("missing Seller capability is rejected with MISSING_CAPABILITY", () => {
      const verdict = evaluateSellerAuthority({
        userAccountId: "u-2",
        actingWorkspaceId: "ws-2",
        projectRequestSellerWorkspaceId: "ws-2",
        workspaceStatus: "Active",
        isMember: true,
        hasSellerCapability: false,
      });
      assert.deepEqual(verdict, { ok: false, reason: "MISSING_CAPABILITY" });
    });

    test("mismatched seller workspace is rejected with NOT_A_MEMBER", () => {
      const verdict = evaluateSellerAuthority({
        userAccountId: "u-2",
        actingWorkspaceId: "ws-2",
        projectRequestSellerWorkspaceId: "ws-other",
        workspaceStatus: "Active",
        isMember: true,
        hasSellerCapability: true,
      });
      assert.deepEqual(verdict, { ok: false, reason: "NOT_A_MEMBER" });
    });
  });

  // P1-003 verification: buyer and seller verdicts share the same
  // shape so a new adapter that constructs the snapshots
  // identically cannot redefine authority semantics.
  test("buyer and seller verdicts share the same shape so an adapter cannot redefine semantics", () => {
    const cases: Array<{
      label: string;
      workspaceStatus: "Active" | "Suspended";
      isMember: boolean;
      hasCapability: boolean;
    }> = [
      { label: "ok", workspaceStatus: "Active", isMember: true, hasCapability: true },
      { label: "suspended", workspaceStatus: "Suspended", isMember: true, hasCapability: true },
      { label: "no-member", workspaceStatus: "Active", isMember: false, hasCapability: true },
      { label: "no-cap", workspaceStatus: "Active", isMember: true, hasCapability: false },
    ];
    for (const c of cases) {
      const buyer = evaluateBuyerAuthority({
        userAccountId: "u",
        buyerWorkspaceId: "w",
        workspaceStatus: c.workspaceStatus,
        isMember: c.isMember,
        hasBuyerCapability: c.hasCapability,
      });
      const seller = evaluateSellerAuthority({
        userAccountId: "u",
        actingWorkspaceId: "w",
        projectRequestSellerWorkspaceId: "w",
        workspaceStatus: c.workspaceStatus,
        isMember: c.isMember,
        hasSellerCapability: c.hasCapability,
      });
      assert.equal(buyer.ok, seller.ok, `ok flag must agree for case "${c.label}"`);
      if (!buyer.ok && !seller.ok) {
        assert.equal(buyer.reason, seller.reason, `reason must agree for case "${c.label}"`);
      }
    }
  });
});
