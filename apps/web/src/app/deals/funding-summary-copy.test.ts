/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildDealSummaryCopy,
  buildFundingBadgeLabel,
  buildPublicFundingStatusCopy,
} from "./deal-summary-copy.js";

describe("BG6 Deal summary presentation", () => {
  test("describes Negotiating status without rendering database identifiers", () => {
    const copy = buildDealSummaryCopy("Negotiating");
    assert.deepEqual(copy, {
      title: "Deal terms",
      description: "Status: Negotiating. Created from an accepted project request.",
    });
  });

  test("Active branch carries the Golden Slice terminal copy", () => {
    const copy = buildDealSummaryCopy("Active");
    assert.deepEqual(copy, {
      title: "Deal Active",
      description: "Escrow funded; commissioned work may begin.",
    });
  });

  test("buildFundingBadgeLabel returns the unambiguous sandbox label", () => {
    assert.equal(buildFundingBadgeLabel(), "Sandbox · simulated");
  });
});

describe("BG6 public funding status copy", () => {
  test("Confirmed status renders the Confirmed copy", () => {
    assert.equal(buildPublicFundingStatusCopy("Confirmed", null), "Funding confirmed (sandbox)");
  });

  test("AwaitingConfirmation status renders the awaiting copy", () => {
    assert.equal(
      buildPublicFundingStatusCopy("AwaitingConfirmation", null),
      "Awaiting sandbox confirmation",
    );
  });

  test("Failed status renders the closed sanitized code, NOT raw exception text", () => {
    const copy = buildPublicFundingStatusCopy("Failed", "EscrowProviderUnavailable");
    assert.equal(copy, "Funding failed (EscrowProviderUnavailable)");
    // Explicit anti-assertion: no raw exception text.
    assert.equal(copy.includes("ECONNRESET"), false);
  });
});
