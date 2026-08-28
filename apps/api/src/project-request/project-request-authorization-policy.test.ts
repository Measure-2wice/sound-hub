/* eslint-disable @typescript-eslint/no-floating-promises */
// ProjectRequest authorization policy shared tests (P1-003).
//
// Background: the application owns the buyer / seller authorization
// policy; the repository adapters (Prisma + in-memory) MUST
// interpret authority identically. These tests pin the policy
// helpers directly and prove a new adapter cannot redefine the
// semantics — both adapters consume the same
// `evaluateBuyerAuthority` / `evaluateSellerAuthority` helpers and
// must surface the same typed failure reasons.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  evaluateBuyerAuthority,
  evaluateSellerAuthority,
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

  describe("evaluateSellerAuthority", () => {
    test("Active workspace, current member, Seller capability is ok", () => {
      const verdict = evaluateSellerAuthority({
        userAccountId: "u-2",
        actingWorkspaceId: "ws-2",
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
        workspaceStatus: "Active",
        isMember: true,
        hasSellerCapability: false,
      });
      assert.deepEqual(verdict, { ok: false, reason: "MISSING_CAPABILITY" });
    });
  });

  // P1-003 verification: buyer and seller policies share the same
  // verdict shape so a new adapter that constructs the snapshots
  // identically cannot redefine authority semantics. The two verdict
  // types are identical (`AuthorityVerdict`) and the only difference
  // is the capability flag name; the repository boundary collapses
  // both verdict reasons into `BUYER_NOT_AUTHORIZED` /
  // `SELLER_NOT_AUTHORIZED`.
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
