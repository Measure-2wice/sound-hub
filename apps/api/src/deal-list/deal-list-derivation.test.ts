/* eslint-disable @typescript-eslint/no-floating-promises */
// Deal-list state derivation tests (ticket #74).
//
// Background: neither the approval state nor the list funding status
// is a persisted column. Both are derived server-side so the client
// never reconstructs authorization-adjacent state. These tests pin the
// derivation rules directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveApprovalState, deriveListFundingStatus } from "./deal-list-derivation.js";

const BUYER_WS = "ws-buyer";
const SELLER_WS = "ws-seller";
const CURRENT_VERSION = "tv-2";

function approvalStateWith(approvingWorkspaceIds: readonly string[]) {
  return deriveApprovalState({
    currentTermsVersionId: CURRENT_VERSION,
    approvingWorkspaceIds,
    buyerWorkspaceId: BUYER_WS,
    sellerWorkspaceId: SELLER_WS,
  });
}

// ---------------------------------------------------------------- approvals

test("deriveApprovalState reports NoTerms when no TermsVersion exists", () => {
  const state = deriveApprovalState({
    currentTermsVersionId: null,
    approvingWorkspaceIds: [],
    buyerWorkspaceId: BUYER_WS,
    sellerWorkspaceId: SELLER_WS,
  });
  assert.equal(state, "NoTerms");
});

test("deriveApprovalState reports NoTerms even if stale approvals were passed", () => {
  // Defensive: a caller that fails to scope approvals to the current
  // version must still not imply approval when there is no version.
  const state = deriveApprovalState({
    currentTermsVersionId: null,
    approvingWorkspaceIds: [BUYER_WS, SELLER_WS],
    buyerWorkspaceId: BUYER_WS,
    sellerWorkspaceId: SELLER_WS,
  });
  assert.equal(state, "NoTerms");
});

test("deriveApprovalState awaits both when neither party approved", () => {
  assert.equal(approvalStateWith([]), "AwaitingBothApprovals");
});

test("deriveApprovalState awaits the seller when only the buyer approved", () => {
  assert.equal(approvalStateWith([BUYER_WS]), "AwaitingSellerApproval");
});

test("deriveApprovalState awaits the buyer when only the seller approved", () => {
  assert.equal(approvalStateWith([SELLER_WS]), "AwaitingBuyerApproval");
});

test("deriveApprovalState reports BothApproved only when both sides approved", () => {
  assert.equal(approvalStateWith([BUYER_WS, SELLER_WS]), "BothApproved");
});

test("deriveApprovalState ignores approvals from a workspace that is not a party", () => {
  // One party's approval can never synthesize the other's, and an
  // unrelated Workspace's row must not count as either side.
  assert.equal(approvalStateWith([BUYER_WS, "ws-unrelated"]), "AwaitingSellerApproval");
});

test("deriveApprovalState is not confused by duplicate approval rows", () => {
  assert.equal(approvalStateWith([BUYER_WS, BUYER_WS]), "AwaitingSellerApproval");
});

// ------------------------------------------------------------------ funding

test("deriveListFundingStatus is null while terms are undrafted", () => {
  assert.equal(
    deriveListFundingStatus({
      approvalState: "NoTerms",
      currentPaymentIntentState: null,
    }),
    null,
  );
});

test("deriveListFundingStatus is null while approvals are incomplete", () => {
  for (const approvalState of [
    "AwaitingBothApprovals",
    "AwaitingBuyerApproval",
    "AwaitingSellerApproval",
  ] as const) {
    assert.equal(
      deriveListFundingStatus({ approvalState, currentPaymentIntentState: null }),
      null,
      `${approvalState} must not report a funding status`,
    );
  }
});

test("deriveListFundingStatus stays null for an incomplete approval even if an intent exists", () => {
  // BG6 forbids funding an unapproved version. A lingering intent must
  // never make the row claim funding is in progress.
  assert.equal(
    deriveListFundingStatus({
      approvalState: "AwaitingSellerApproval",
      currentPaymentIntentState: "Confirmed",
    }),
    null,
  );
});

test("deriveListFundingStatus awaits confirmation once both approved and no intent exists", () => {
  assert.equal(
    deriveListFundingStatus({
      approvalState: "BothApproved",
      currentPaymentIntentState: null,
    }),
    "AwaitingConfirmation",
  );
});

test("deriveListFundingStatus maps a Created intent onto AwaitingConfirmation", () => {
  assert.equal(
    deriveListFundingStatus({
      approvalState: "BothApproved",
      currentPaymentIntentState: "Created",
    }),
    "AwaitingConfirmation",
  );
});

test("deriveListFundingStatus maps a Confirmed intent onto Confirmed", () => {
  assert.equal(
    deriveListFundingStatus({
      approvalState: "BothApproved",
      currentPaymentIntentState: "Confirmed",
    }),
    "Confirmed",
  );
});

test("deriveListFundingStatus maps a Failed intent onto Failed", () => {
  assert.equal(
    deriveListFundingStatus({
      approvalState: "BothApproved",
      currentPaymentIntentState: "Failed",
    }),
    "Failed",
  );
});
