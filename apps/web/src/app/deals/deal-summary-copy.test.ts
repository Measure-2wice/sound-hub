/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildApprovalStatusRows,
  buildApprovalSuccessCopy,
  buildAiDraftStatusLabel,
  buildDealSummaryCopy,
  buildSellerConsentLabel,
  shouldShowDraftTermsControl,
} from "./deal-summary-copy.js";

describe("BG5 Deal summary presentation", () => {
  test("describes status and origin without rendering database identifiers", () => {
    const copy = buildDealSummaryCopy("Negotiating");

    assert.deepEqual(copy, {
      title: "Deal terms",
      description: "Status: Negotiating. Created from an accepted project request.",
    });
  });
});

describe("BG5 approval presentation", () => {
  test("draft terms control requires both Negotiating status and an authorized drafter", () => {
    assert.equal(shouldShowDraftTermsControl("Negotiating", true), true);
    assert.equal(shouldShowDraftTermsControl("Active", true), false);
    assert.equal(shouldShowDraftTermsControl("Negotiating", false), false);
  });

  test("shows independent buyer and seller state without exposing Workspace IDs", () => {
    const rows = buildApprovalStatusRows({
      buyerWorkspaceId: "ws-private-buyer",
      sellerWorkspaceId: "ws-private-seller",
      approvals: [
        {
          dealApprovalId: "approval-private-1",
          termsVersionId: "terms-private-2",
          workspaceId: "ws-private-seller",
          approvedAt: "2026-09-02T22:30:05.000Z",
        },
      ],
    });

    assert.deepEqual(rows, [
      { side: "Buyer", approvedAt: null },
      { side: "Seller", approvedAt: "2026-09-02T22:30:05.000Z" },
    ]);
    assert.equal(JSON.stringify(rows).includes("ws-private"), false);
  });

  test("approval success copy names the party side, not its Workspace ID", () => {
    assert.equal(buildApprovalSuccessCopy("Seller", 2), "Seller approved TermsVersion 2.");
  });

  test("AI draft badge follows zero, partial, and complete human approval state", () => {
    assert.equal(
      buildAiDraftStatusLabel([
        { side: "Buyer", approvedAt: null },
        { side: "Seller", approvedAt: null },
      ]),
      "AI-drafted · unapproved",
    );
    assert.equal(
      buildAiDraftStatusLabel([
        { side: "Buyer", approvedAt: null },
        { side: "Seller", approvedAt: "2026-09-02T22:36:14.000Z" },
      ]),
      "AI-drafted · awaiting buyer approval",
    );
    assert.equal(
      buildAiDraftStatusLabel([
        { side: "Buyer", approvedAt: "2026-09-02T22:42:19.000Z" },
        { side: "Seller", approvedAt: "2026-09-02T22:36:14.000Z" },
      ]),
      "AI-drafted · approved by both parties",
    );
  });
});

describe("BG5 seller-consent projection (ticket AC27)", () => {
  test("renders an explicit Accepted label when the projection carries a timestamp", () => {
    const copy = buildSellerConsentLabel({
      status: "Accepted",
      sellerConsentAt: "2026-09-02T22:30:05.000Z",
    });
    assert.ok(copy !== null);
    assert.equal(copy.label, "Seller consent: Accepted");
    assert.equal(copy.consentedAt, "2026-09-02T22:30:05.000Z");
  });

  test("fails closed (returns null) when the projection is null", () => {
    assert.equal(buildSellerConsentLabel(null), null);
  });

  test("fails closed (returns null) when the projection lacks a timestamp", () => {
    // Defensive: a null sellerConsentAt must NOT present "Accepted"
    // consent — only a complete projection drives the indicator.
    assert.equal(buildSellerConsentLabel({ status: "Accepted", sellerConsentAt: null }), null);
  });

  test("the label names the side (Seller) but no Workspace ID or internal id", () => {
    const copy = buildSellerConsentLabel({
      status: "Accepted",
      sellerConsentAt: "2026-09-02T22:30:05.000Z",
    });
    assert.ok(copy !== null);
    const json = JSON.stringify(copy);
    assert.equal(json.includes("ws-"), false, "label must not leak a Workspace id");
    assert.equal(json.includes("dealId"), false, "label must not leak a Deal id");
    assert.equal(
      json.includes("projectRequestId"),
      false,
      "label must not leak a ProjectRequest id",
    );
  });
});
