/* eslint-disable @typescript-eslint/no-floating-promises */
// Deal-list copy helper tests (ticket #74).
//
// Background: the /deals rows translate server-derived closed enums
// into human-readable copy. These pure helpers are the testable seam;
// the page itself is covered by the BG7 browser journey.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DealListItemPublicV1 } from "@soundhub/types";
import {
  buildDealStatusLine,
  describeActingSide,
  describeApprovalState,
  describeCounterparty,
  describeDealStatus,
  describeDealTitle,
  describeFundingStatus,
  describeTermsVersion,
  formatDealDate,
} from "./deal-list-copy.js";

function deal(overrides: Partial<DealListItemPublicV1> = {}): DealListItemPublicV1 {
  return {
    dealId: "deal-1",
    status: "Negotiating",
    actingSide: "Buyer",
    counterpartyWorkspaceName: "Blue Mountain Studio",
    serviceOfferingTitle: "Mixing & Mastering — Full Track",
    currentTermsVersion: 2,
    approvalState: "AwaitingSellerApproval",
    fundingStatus: null,
    activatedAt: null,
    createdAt: "2026-02-01T10:00:00.000Z",
    ...overrides,
  };
}

// ------------------------------------------------------------------ labels

test("the primary label is the offering title, not the Deal id", () => {
  const label = describeDealTitle(deal());
  assert.equal(label, "Mixing & Mastering — Full Track");
  assert.ok(!label.includes("deal-1"), "the row must not lead with a raw internal id");
});

test("a missing offering title falls back to a stable placeholder", () => {
  assert.equal(describeDealTitle(deal({ serviceOfferingTitle: null })), "Unnamed");
});

test("the counterparty line names the other side", () => {
  assert.equal(describeCounterparty(deal()), "with Blue Mountain Studio");
});

test("a missing counterparty name falls back to a stable placeholder", () => {
  assert.equal(describeCounterparty(deal({ counterpartyWorkspaceName: null })), "with Unnamed");
});

test("the acting side is described from the viewer's perspective", () => {
  assert.equal(describeActingSide("Buyer"), "You are the buyer");
  assert.equal(describeActingSide("Seller"), "You are the seller");
});

// ------------------------------------------------------------------ states

test("every Deal status has copy", () => {
  assert.equal(describeDealStatus("Negotiating"), "Negotiating");
  assert.equal(describeDealStatus("Active"), "Active");
});

test("every approval state has distinct copy", () => {
  const labels = (
    [
      "NoTerms",
      "AwaitingBothApprovals",
      "AwaitingBuyerApproval",
      "AwaitingSellerApproval",
      "BothApproved",
    ] as const
  ).map((state) => describeApprovalState(state));

  assert.equal(new Set(labels).size, labels.length, "approval copy must be unambiguous");
  assert.equal(describeApprovalState("AwaitingSellerApproval"), "Awaiting seller approval");
  assert.equal(describeApprovalState("BothApproved"), "Both parties approved");
});

test("funding copy matches the agreed wording", () => {
  assert.equal(describeFundingStatus("AwaitingConfirmation"), "Awaiting funding");
  assert.equal(describeFundingStatus("Confirmed"), "Funded");
  assert.equal(describeFundingStatus("Failed"), "Funding failed");
});

test("a null funding status yields no copy so the row omits the line", () => {
  // Rendering "not funded" for a Deal whose terms are not yet approved
  // would misstate the domain: funding is not applicable at all.
  assert.equal(describeFundingStatus(null), null);
});

test("the terms version renders as vN, or nothing when undrafted", () => {
  assert.equal(describeTermsVersion(2), "v2");
  assert.equal(describeTermsVersion(null), null);
});

// -------------------------------------------------------------- status line

test("the status line joins status, version, and approval state", () => {
  assert.equal(buildDealStatusLine(deal()), "Negotiating · v2 · Awaiting seller approval");
});

test("the status line omits the version when no terms are drafted", () => {
  assert.equal(
    buildDealStatusLine(deal({ currentTermsVersion: null, approvalState: "NoTerms" })),
    "Negotiating · No terms drafted",
  );
});

test("the status line reflects an Active funded Deal", () => {
  assert.equal(
    buildDealStatusLine(
      deal({ status: "Active", currentTermsVersion: 3, approvalState: "BothApproved" }),
    ),
    "Active · v3 · Both parties approved",
  );
});

// --------------------------------------------------------------------- date

test("dates render as a stable ISO day", () => {
  assert.equal(formatDealDate("2026-02-01T10:00:00.000Z"), "2026-02-01");
});

test("an unparseable date is passed through rather than rendered as NaN", () => {
  assert.equal(formatDealDate("not-a-date"), "not-a-date");
});
