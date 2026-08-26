/* eslint-disable @typescript-eslint/no-floating-promises */
// Deterministic AI adapter tests.
//
// Background: the BG3 ticket requires that the deterministic
// fallback produces a candidate criteria payload that ALWAYS
// validates against `matchmakerCriteriaV1Schema`. The tests
// cover every documented GS 14 invariant: required constraints
// are never silently relaxed, the fallback respects the buyer's
// expressed hard axes, and identical inputs produce identical
// outputs (deterministic).

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchmakerCriteriaV1Schema } from "@soundhub/types";
import { DeterministicAiAdapter } from "./deterministic-ai-adapter.js";

const adapter = new DeterministicAiAdapter();

async function interpret(briefText: string) {
  const out = await adapter.interpretBrief({
    actingWorkspaceId: "ws-buyer-1",
    briefText,
  });
  return matchmakerCriteriaV1Schema.parse(out.candidate);
}

test("deterministic fallback recognises a remote dancehall brief", async () => {
  const criteria = await interpret(
    "I need a producer in Brooklyn for a remote Haitian dancehall single.",
  );
  assert.ok(criteria.required.serviceModes?.includes("Remote"));
  assert.ok(
    criteria.required.primaryCategoryKeys?.some((k) => k === "music-production"),
    "music-production category should be required",
  );
  assert.equal(criteria.required.basedIn?.countryCode, "US");
  assert.equal(criteria.required.basedIn?.city, "Brooklyn");
  assert.ok(criteria.preferred?.genreTags?.includes("dancehall"));
  assert.ok(criteria.preferred?.caribbeanAffiliationCodes?.includes("HT"));
  assert.equal(criteria.query, undefined);
});

test("deterministic fallback preserves in-person live performance as required", async () => {
  const criteria = await interpret(
    "Looking for a live performance for a bachata festival in Santo Domingo.",
  );
  assert.ok(criteria.required.serviceModes?.includes("InPerson"));
  assert.ok(criteria.required.primaryCategoryKeys?.some((k) => k === "live-performance"));
  assert.equal(criteria.required.basedIn?.countryCode, "DO");
  assert.ok(criteria.preferred?.genreTags?.includes("bachata"));
});

test("deterministic fallback recognises a hybrid mixing brief with an explicit deadline", async () => {
  const criteria = await interpret(
    "Need a hybrid mixing engineer for a dancehall project before March 14.",
  );
  assert.ok(criteria.required.serviceModes?.includes("Hybrid"));
  assert.ok(criteria.required.primaryCategoryKeys?.some((k) => k === "mixing"));
  assert.equal(criteria.nonSearchRequirements?.fundingDeadline, "march 14");
});

test("deterministic fallback drops genre tokens that the search contract does not recognise", async () => {
  const criteria = await interpret("I need a producer who plays underwater bagpipes.");
  // "underwater bagpipes" is not in the recognised genre list. The
  // fallback must NOT invent a fake genre tag; it returns no
  // `preferred.genreTags` rather than fabricating one.
  assert.equal(criteria.preferred?.genreTags, undefined);
});

test("deterministic fallback preserves hard category even when the brief also names a genre", async () => {
  const criteria = await interpret("Mixing engineer for a dancehall record, in Brooklyn.");
  // The hard category axis must contain "mixing" — the buyer named
  // the work explicitly. "dancehall" is a preference, not a hard
  // constraint.
  assert.ok(criteria.required.primaryCategoryKeys?.includes("mixing"));
  assert.ok(criteria.preferred?.genreTags?.includes("dancehall"));
});

test("deterministic fallback is deterministic: identical inputs yield identical outputs", async () => {
  const a = await interpret("Need a remote Brooklyn producer for a Haitian dancehall single.");
  const b = await interpret("Need a remote Brooklyn producer for a Haitian dancehall single.");
  assert.deepEqual(a, b);
});

test("deterministic fallback surfaces hard required constraints only when buyer expressed them", async () => {
  // The brief says nothing about location, genre, or service
  // mode. The fallback must NOT invent them; the criteria must
  // still validate (it keeps the empty `required` block plus at
  // least one hard axis implied by the category mapping). The
  // buyer's hard requirement is the primary category — they
  // said "songwriter", which collapses to the songwriting key.
  const criteria = await interpret("Need a songwriter.");
  assert.ok(criteria.required.primaryCategoryKeys?.includes("songwriting"));
  assert.equal(criteria.required.serviceModes, undefined);
  assert.equal(criteria.required.basedIn, undefined);
});

test("deterministic fallback carries buyer-supplied nonSearchRequirements verbatim", async () => {
  const out = await adapter.interpretBrief({
    actingWorkspaceId: "ws-buyer-1",
    briefText: "Need a producer.",
    buyerNonSearchRequirements: { customNote: "rush job" },
  });
  assert.equal(
    (out.candidate as { nonSearchRequirements?: Record<string, string> }).nonSearchRequirements
      ?.customNote,
    "rush job",
  );
});

test("deterministic fallback always produces a candidate that passes the M1+BG3 schema", async () => {
  const inputs = [
    "Need a Brooklyn-based dancehall producer.",
    "Looking for a bachata live set in Santo Domingo.",
    "Hybrid mixing for a Caribbean release.",
    "Short brief.",
    "Anything goes, no preferences.",
  ];
  for (const text of inputs) {
    const out = await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: text,
    });
    assert.doesNotThrow(() => {
      matchmakerCriteriaV1Schema.parse(out.candidate);
    }, `candidate for "${text}" must validate`);
  }
});

test("deterministic fallback preserves the shipped default brief's Brooklyn required location", async () => {
  // The buyer UI ships DEFAULT_BRIEF verbatim:
  //   "I need a Brooklyn-based producer for a remote Haitian
  //   dancehall single, ideally delivered before March 14."
  // GS 14 forbids silently dropping or relaxing required
  // constraints; a Brooklyn-based requirement must survive the
  // deterministic interpretation. Without the "brooklyn-based"
  // phrase in LOCATION_PHRASES, the required.basedIn axis was
  // absent and the talent search surfaced sellers outside
  // Brooklyn.
  const criteria = await interpret(
    "I need a Brooklyn-based producer for a remote Haitian dancehall single, ideally delivered before March 14.",
  );
  assert.ok(criteria.required.serviceModes?.includes("Remote"));
  assert.ok(criteria.required.primaryCategoryKeys?.some((k) => k === "music-production"));
  assert.equal(
    criteria.required.basedIn?.countryCode,
    "US",
    "Brooklyn-based must survive as a required US basedIn",
  );
  assert.equal(criteria.required.basedIn?.city, "Brooklyn");
  assert.equal(criteria.required.basedIn?.region, "NY");
  assert.ok(criteria.preferred?.genreTags?.includes("dancehall"));
  assert.ok(criteria.preferred?.caribbeanAffiliationCodes?.includes("HT"));
});

test("deterministic fallback refuses to emit an unvalidated criteria payload (punctuation-only brief)", async () => {
  // Punctuation-only briefs have no recognised axis and produce a
  // query value that normalizedQuerySchema rejects. The adapter
  // self-validates before returning and surfaces AiInvalidOutputError
  // so the application boundary maps it to MATCHMAKER_INVALID_REQUEST
  // rather than handing the unvalidated payload to TalentSearchService.
  let caught: unknown;
  try {
    await adapter.interpretBrief({ actingWorkspaceId: "ws-buyer-1", briefText: "---" });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
});
