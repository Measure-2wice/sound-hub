/* eslint-disable @typescript-eslint/no-floating-promises */
// Pure evaluator tests for the BG6 funding authorization policy.

import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateActivationAuthority,
  evaluatePreauthAuthority,
  type ActivationAuthoritySnapshot,
  type PreauthAuthoritySnapshot,
} from "./funding-authorization-policy.js";

function makePreauthSnapshot(
  overrides: Partial<PreauthAuthoritySnapshot> = {},
): PreauthAuthoritySnapshot {
  return {
    dealId: "deal_test_001",
    dealStatus: "Negotiating",
    buyerWorkspaceId: "ws_buyer",
    sellerWorkspaceId: "ws_seller",
    actingWorkspaceId: "ws_buyer",
    actingWorkspaceStatus: "Active",
    actingUserIsMember: true,
    hasBuyerCapability: true,
    currentTermsVersionId: "tv_current",
    currentTermsVersionDealId: "deal_test_001",
    projectRequestStatus: "Accepted",
    projectRequestSellerConsentAt: new Date("2026-09-01T10:00:00.000Z"),
    buyerApprovalExists: true,
    sellerApprovalExists: true,
    ...overrides,
  };
}

function makeActivationSnapshot(
  overrides: Partial<ActivationAuthoritySnapshot> = {},
): ActivationAuthoritySnapshot {
  return {
    projectRequestSellerConsentAt: new Date("2026-09-01T10:00:00.000Z"),
    buyerApprovalExists: true,
    sellerApprovalExists: true,
    fundingConfirmedAmountMinor: 75000,
    fundingConfirmedCurrency: "USD",
    fundingTermsVersionId: "tv_current",
    currentTermsVersionId: "tv_current",
    currentTermsVersionAmountMinor: 75000,
    currentTermsVersionCurrency: "USD",
    ...overrides,
  };
}

// ---------- evaluatePreauthAuthority ----------

test("evaluatePreauthAuthority: ok when every snapshot fact is satisfied", () => {
  const verdict = evaluatePreauthAuthority(makePreauthSnapshot());
  assert.deepEqual(verdict, { ok: true });
});

test("evaluatePreauthAuthority: DEAL_NOT_FOUND when dealStatus is null", () => {
  const verdict = evaluatePreauthAuthority(makePreauthSnapshot({ dealStatus: null }));
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_NOT_FOUND" });
});

test("evaluatePreauthAuthority: DEAL_NOT_NEGOTIATING when status is Active", () => {
  const verdict = evaluatePreauthAuthority(makePreauthSnapshot({ dealStatus: "Active" }));
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_NOT_NEGOTIATING" });
});

test("evaluatePreauthAuthority: TERMS_VERSION_NOT_FOUND when no current TV", () => {
  const verdict = evaluatePreauthAuthority(makePreauthSnapshot({ currentTermsVersionId: null }));
  assert.deepEqual(verdict, { ok: false, reason: "TERMS_VERSION_NOT_FOUND" });
});

test("evaluatePreauthAuthority: NOT_BUYER_SIDE when acting WS is the seller", () => {
  const verdict = evaluatePreauthAuthority(makePreauthSnapshot({ actingWorkspaceId: "ws_seller" }));
  assert.deepEqual(verdict, { ok: false, reason: "NOT_BUYER_SIDE" });
});

test("evaluatePreauthAuthority: WORKSPACE_INELIGIBLE when buyer WS is Suspended", () => {
  const verdict = evaluatePreauthAuthority(
    makePreauthSnapshot({ actingWorkspaceStatus: "Suspended" }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "WORKSPACE_INELIGIBLE" });
});

test("evaluatePreauthAuthority: NOT_A_MEMBER when user has lost membership", () => {
  const verdict = evaluatePreauthAuthority(makePreauthSnapshot({ actingUserIsMember: false }));
  assert.deepEqual(verdict, { ok: false, reason: "NOT_A_MEMBER" });
});

test("evaluatePreauthAuthority: MISSING_BUYER_CAPABILITY when buyer Workspace lacks Buyer capability", () => {
  // Per ticket #64 P0-001 the Buyer capability is an independently
  // granted WorkspaceCapability row — NOT inferred from membership,
  // ownership, or Deal party identity. A current member of the
  // buyer Workspace without the Buyer capability is rejected here.
  const verdict = evaluatePreauthAuthority(makePreauthSnapshot({ hasBuyerCapability: false }));
  assert.deepEqual(verdict, { ok: false, reason: "MISSING_BUYER_CAPABILITY" });
});

test("evaluatePreauthAuthority: SELLER_NOT_CONSENTED when PR is Pending", () => {
  const verdict = evaluatePreauthAuthority(
    makePreauthSnapshot({
      projectRequestStatus: "Pending",
      projectRequestSellerConsentAt: null,
    }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "SELLER_NOT_CONSENTED" });
});

test("evaluatePreauthAuthority: SELLER_NOT_CONSENTED when PR is Accepted but sellerConsentAt is null", () => {
  const verdict = evaluatePreauthAuthority(
    makePreauthSnapshot({ projectRequestSellerConsentAt: null }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "SELLER_NOT_CONSENTED" });
});

test("evaluatePreauthAuthority: APPROVALS_INCOMPLETE when buyer has not approved", () => {
  const verdict = evaluatePreauthAuthority(makePreauthSnapshot({ buyerApprovalExists: false }));
  assert.deepEqual(verdict, { ok: false, reason: "APPROVALS_INCOMPLETE" });
});

test("evaluatePreauthAuthority: APPROVALS_INCOMPLETE when seller has not approved", () => {
  const verdict = evaluatePreauthAuthority(makePreauthSnapshot({ sellerApprovalExists: false }));
  assert.deepEqual(verdict, { ok: false, reason: "APPROVALS_INCOMPLETE" });
});

// ---------- evaluateActivationAuthority ----------

test("evaluateActivationAuthority: ok when all four GS-25 conditions match", () => {
  const verdict = evaluateActivationAuthority(makeActivationSnapshot());
  assert.deepEqual(verdict, { ok: true });
});

test("evaluateActivationAuthority: SELLER_NOT_CONSENTED when sellerConsentAt is null", () => {
  const verdict = evaluateActivationAuthority(
    makeActivationSnapshot({ projectRequestSellerConsentAt: null }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "SELLER_NOT_CONSENTED" });
});

test("evaluateActivationAuthority: APPROVALS_INCOMPLETE when one approval is missing", () => {
  const verdict = evaluateActivationAuthority(
    makeActivationSnapshot({ sellerApprovalExists: false }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "APPROVALS_INCOMPLETE" });
});

test("evaluateActivationAuthority: NO_FUNDING when funding has not confirmed", () => {
  const verdict = evaluateActivationAuthority(
    makeActivationSnapshot({
      fundingConfirmedAmountMinor: null,
      fundingConfirmedCurrency: null,
      fundingTermsVersionId: null,
    }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "NO_FUNDING" });
});

test("evaluateActivationAuthority: TERMS_VERSION_MISMATCH when funding pinned an older TV", () => {
  const verdict = evaluateActivationAuthority(
    makeActivationSnapshot({ fundingTermsVersionId: "tv_older" }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "TERMS_VERSION_MISMATCH" });
});

test("evaluateActivationAuthority: AMOUNT_MISMATCH when provider amount differs by 1 minor unit", () => {
  const verdict = evaluateActivationAuthority(
    makeActivationSnapshot({ fundingConfirmedAmountMinor: 74999 }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "AMOUNT_MISMATCH" });
});

test("evaluateActivationAuthority: CURRENCY_MISMATCH when provider currency differs", () => {
  const verdict = evaluateActivationAuthority(
    makeActivationSnapshot({ fundingConfirmedCurrency: "EUR" }),
  );
  assert.deepEqual(verdict, { ok: false, reason: "CURRENCY_MISMATCH" });
});
