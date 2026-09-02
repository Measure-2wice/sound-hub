/* eslint-disable @typescript-eslint/no-floating-promises */
// DealTerms authorization policy unit tests (BG5).
//
// Background: ticket #63 requires pure policy evaluators that the
// service layer invokes to decide whether FOR UPDATE-locked
// snapshots authorize a drafting or approval command. These tests
// exercise the evaluators directly with synthetic snapshots — no
// repository, no Prisma, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateApprovalAuthority,
  evaluateDraftingAuthority,
} from "./deal-terms-authorization-policy.js";

const baseDraftingSnapshot = () => ({
  dealId: "deal-1",
  dealStatus: "Negotiating" as const,
  buyerWorkspaceId: "ws-buyer",
  sellerWorkspaceId: "ws-seller",
  actingWorkspaceId: "ws-buyer",
  actingWorkspaceStatus: "Active" as const,
  actingUserIsMember: true,
});

const baseApprovalSnapshot = () => ({
  dealId: "deal-1",
  dealStatus: "Negotiating" as const,
  termsVersionId: "tv-1",
  termsVersionDealId: "deal-1",
  currentTermsVersionId: "tv-1",
  buyerWorkspaceId: "ws-buyer",
  sellerWorkspaceId: "ws-seller",
  actingWorkspaceId: "ws-buyer",
  actingWorkspaceStatus: "Active" as const,
  actingUserIsMember: true,
  userAccountId: "user-1",
  dealApproverExists: true,
  dealApproverId: "da-1",
});

// ---------- drafting ----------

test("drafting: Negotiating + acting Workspace is a party + current member => ok", () => {
  const verdict = evaluateDraftingAuthority(baseDraftingSnapshot());
  assert.deepEqual(verdict, { ok: true });
});

test("drafting: Active Deal is rejected with DEAL_NOT_NEGOTIATING", () => {
  const verdict = evaluateDraftingAuthority({
    ...baseDraftingSnapshot(),
    dealStatus: "Active",
  });
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_NOT_NEGOTIATING" });
});

test("drafting: missing Deal is rejected with DEAL_NOT_FOUND", () => {
  const verdict = evaluateDraftingAuthority({
    ...baseDraftingSnapshot(),
    dealStatus: null,
  });
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_NOT_FOUND" });
});

test("drafting: non-member is rejected with NOT_A_MEMBER", () => {
  const verdict = evaluateDraftingAuthority({
    ...baseDraftingSnapshot(),
    actingUserIsMember: false,
  });
  assert.deepEqual(verdict, { ok: false, reason: "NOT_A_MEMBER" });
});

test("drafting: suspended acting Workspace is rejected with WORKSPACE_INELIGIBLE", () => {
  const verdict = evaluateDraftingAuthority({
    ...baseDraftingSnapshot(),
    actingWorkspaceStatus: "Suspended",
  });
  assert.deepEqual(verdict, { ok: false, reason: "WORKSPACE_INELIGIBLE" });
});

test("drafting: acting Workspace is not a party to the Deal is rejected with NOT_A_MEMBER", () => {
  const verdict = evaluateDraftingAuthority({
    ...baseDraftingSnapshot(),
    actingWorkspaceId: "ws-other",
  });
  assert.deepEqual(verdict, { ok: false, reason: "NOT_A_MEMBER" });
});

// ---------- approval ----------

test("approval: full snapshot is ok", () => {
  const verdict = evaluateApprovalAuthority(baseApprovalSnapshot());
  assert.equal(verdict.ok, true);
});

test("approval: non-current TermsVersion fails with TERMS_VERSION_NOT_CURRENT", () => {
  const verdict = evaluateApprovalAuthority({
    ...baseApprovalSnapshot(),
    currentTermsVersionId: "tv-2",
  });
  assert.deepEqual(verdict, { ok: false, reason: "TERMS_VERSION_NOT_CURRENT" });
});

test("approval: cross-Deal TermsVersion fails with TERMS_VERSION_NOT_FOUND", () => {
  const verdict = evaluateApprovalAuthority({
    ...baseApprovalSnapshot(),
    termsVersionDealId: "deal-OTHER",
  });
  assert.deepEqual(verdict, { ok: false, reason: "TERMS_VERSION_NOT_FOUND" });
});

test("approval: missing DealApprover authorization fails with DEAL_APPROVER_NOT_FOUND", () => {
  const verdict = evaluateApprovalAuthority({
    ...baseApprovalSnapshot(),
    dealApproverExists: false,
    dealApproverId: null,
  });
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_APPROVER_NOT_FOUND" });
});

test("approval: non-party Workspace fails with WORKSPACE_NOT_PARTY", () => {
  const verdict = evaluateApprovalAuthority({
    ...baseApprovalSnapshot(),
    actingWorkspaceId: "ws-other",
  });
  assert.deepEqual(verdict, { ok: false, reason: "WORKSPACE_NOT_PARTY" });
});

test("approval: non-member fails with NOT_A_member", () => {
  const verdict = evaluateApprovalAuthority({
    ...baseApprovalSnapshot(),
    actingUserIsMember: false,
  });
  assert.deepEqual(verdict, { ok: false, reason: "NOT_A_MEMBER" });
});

test("approval: Active Deal fails with DEAL_NOT_NEGOTIATING", () => {
  const verdict = evaluateApprovalAuthority({
    ...baseApprovalSnapshot(),
    dealStatus: "Active",
  });
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_NOT_NEGOTIATING" });
});

test("approval: missing Deal fails with DEAL_NOT_FOUND", () => {
  const verdict = evaluateApprovalAuthority({
    ...baseApprovalSnapshot(),
    dealStatus: null,
  });
  assert.deepEqual(verdict, { ok: false, reason: "DEAL_NOT_FOUND" });
});