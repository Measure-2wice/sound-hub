/* eslint-disable @typescript-eslint/no-floating-promises */
// DealTermsAiAdapter unit tests (BG5).
//
// Background: ticket #63 requires a provider-neutral AI boundary for
// TermsVersion drafting. The application owns the validation; the
// adapter returns a candidate that the service re-validates against
// `bg5ProposedTermsV1Schema`. The deterministic adapter is the
// buildathon-only AI path; no managed integration is wired.
//
// These tests assert observable output shape only — no assertions on
// private orchestration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bg5ProposedTermsV1Schema } from "@soundhub/types";
import { DeterministicDealTermsAiAdapter } from "./deal-terms-ai-adapter.js";

const adapter = new DeterministicDealTermsAiAdapter();

test("deterministic adapter returns a candidate that parses against the strict BG5 schema", async () => {
  const output = await adapter.draftProposedTerms({
    dealId: "deal-1",
    buyerWorkspaceId: "ws-buyer",
    sellerWorkspaceId: "ws-seller",
    serviceOfferingId: "of-1",
    projectBriefId: "brief-1",
  });
  assert.equal(output.provider, "deterministic-fallback");
  assert.equal(output.modelId, null);
  const parsed = bg5ProposedTermsV1Schema.parse(output.candidate);
  assert.equal(parsed.price.currency, "USD");
  assert.ok(parsed.deliverables.length >= 1);
  assert.ok(parsed.scope.length > 0);
});

test("deterministic adapter key is stable and labelled as fallback", () => {
  assert.equal(adapter.key, "deterministic-fallback");
});

test("deterministic adapter output is stable across calls (no AI randomness)", async () => {
  const input = {
    dealId: "deal-1",
    buyerWorkspaceId: "ws-buyer",
    sellerWorkspaceId: "ws-seller",
    serviceOfferingId: "of-1",
    projectBriefId: "brief-1",
  };
  const a = await adapter.draftProposedTerms(input);
  const b = await adapter.draftProposedTerms(input);
  // Deterministic schedule (2026-01-01 base date) keeps the candidate
  // byte-stable across calls; AI cannot introduce non-determinism.
  assert.equal(JSON.stringify(a.candidate), JSON.stringify(b.candidate));
});