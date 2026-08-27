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

test("deterministic fallback fails closed on an unsupported explicit location (GS 14)", async () => {
  // QA reproduction: "I need an in-person music producer based in
  // Antarctica." The buyer's natural-language brief explicitly named
  // Antarctica as the required location. The deterministic adapter
  // does not know Antarctica (the canonical LOCATION_PHRASES list is
  // closed), so it MUST surface AiInvalidOutputError rather than
  // silently dropping the location and running a relaxed search
  // (GS 14: required constraints must never be silently relaxed).
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need an in-person music producer based in Antarctica.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(
    caught.message,
    /Antarctica/,
    "the error message must echo the unsupported location so the buyer can rephrase",
  );
});

test("deterministic fallback fails closed on an unsupported <X>-based location", async () => {
  // Same fail-closed invariant via the "<City>-based" cue. "Reykjavik"
  // is not in LOCATION_PHRASES; the adapter must throw instead of
  // silently dropping the location and treating the brief as
  // location-unconstrained.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a Reykjavik-based music producer for a remote single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
});

test("deterministic fallback does not fail closed on canonical service-mode phrasings", async () => {
  // "remote-based" describes a service mode, not a location. The
  // fail-closed detector must NOT trigger on service-mode keywords
  // because a buyer writing "a remote-based producer" is expressing
  // a service preference, not a city.
  const criteria = await interpret("I need a remote-based music producer for a remote single.");
  assert.ok(criteria.required.serviceModes?.includes("Remote"));
});

test("deterministic fallback fails closed on 'in <unsupported-city>' cues", async () => {
  // P1-001 reproduction: "I need a music producer in Antarctica."
  // The buyer used the `in <Location>` cue. Antarctica is not in
  // LOCATION_PHRASES; the detector must surface AiInvalidOutputError
  // rather than silently dropping the location and running a
  // relaxed search (GS 14: required constraints are never silently
  // relaxed).
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a music producer in Antarctica.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Antarctica/);
});

test("deterministic fallback fails closed on 'located in <unsupported-city>' cues", async () => {
  // P1-001 reproduction: "I am located in Reykjavik and need a
  // producer." The buyer used the `located in <Location>` cue.
  // Reykjavik is not in LOCATION_PHRASES; the detector must throw.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I am located in Reykjavik and need a music producer.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Reykjavik/);
});

test("deterministic fallback resolves 'based in Port of Spain' with a trailing project clause", async () => {
  // P1-001 reproduction: "based in Port of Spain for a remote
  // single". Port of Spain is canonical (TT) and the buyer used
  // the supported `based in <Location>` cue. The detector must
  // NOT falsely reject this brief as unsupported, and the
  // canonical-phrase scan must produce the TT basedIn constraint.
  const criteria = await interpret("I need a producer based in Port of Spain for a remote single.");
  assert.equal(criteria.required.basedIn?.countryCode, "TT");
  assert.equal(criteria.required.basedIn?.city, "Port of Spain");
  assert.ok(criteria.required.serviceModes?.includes("Remote"));
});

test("deterministic fallback resolves 'in <unsupported-city>' followed by a project clause", async () => {
  // Belt-and-suspenders: the clause-bound capture must reject
  // trailing project text. "in Reykjavik for a remote single"
  // should fail closed with "Reykjavik" — NOT "Reykjavik for a
  // remote single" — so the buyer sees a precise, actionable
  // error.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a music producer in Reykjavik for a remote single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Reykjavik/);
  assert.doesNotMatch(caught.message, /for a remote single/);
});

// --- P1-001 regression coverage (Codex review) -----------------------
//
// The Codex review flagged that the location detector both relaxed
// explicit required constraints (`in antarctica`, `in Antarctica
// next month`, `from antarctica for a single`, `reykjavik-based`)
// and misclassified non-location language (`mixing in Dolby Atmos`)
// as a geographic cue. These regression tests pin every branch of
// the case-insensitive detector and the creative-verb preceding-word
// check so a regression in either direction — silent relaxation or
// false-positive fail-closed — cannot ship.

test("deterministic fallback fails closed on a lowercase 'in <unsupported-city>' cue", async () => {
  // P1-001 reproduction: `in antarctica` (lowercase). The detector
  // must be case-insensitive so a lowercase city/country name
  // triggers the same fail-closed path as its capitalised
  // equivalent. The error message must echo the unsupported
  // location so the buyer can rephrase.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a music producer in antarctica.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /antarctica/i);
});

test("deterministic fallback fails closed on a lowercase 'from <unsupported-city>' cue", async () => {
  // P1-001 reproduction: `from antarctica for a single`. The
  // detector must capture "antarctica" (lowercase) — NOT "antarctica
  // for a single" — and fail-closed with the unsupported token in
  // the message.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a producer from antarctica for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /antarctica/i);
  assert.doesNotMatch(caught.message, /for a single/);
});

test("deterministic fallback fails closed on 'in <unsupported-city>' followed by a temporal phrase", async () => {
  // P1-001 reproduction: `in Antarctica next month`. The detector
  // must bound the capture at the temporal adverb (next) so the
  // token is just "Antarctica" — NOT "Antarctica next month" — and
  // fail-closed with "Antarctica" in the error message.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a music producer in Antarctica next month.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Antarctica/);
  assert.doesNotMatch(caught.message, /next month/);
});

test("deterministic fallback fails closed on a lowercase '<X>-based' cue", async () => {
  // P1-001 reproduction: `reykjavik-based` (lowercase). The
  // `<X>-based` matcher must be case-insensitive so a lowercase
  // location prefix reaches the same fail-closed path. The captured
  // token preserves the buyer's original casing (lowercase), which
  // is what surfaces in the error message.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a reykjavik-based music producer for a remote single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /reykjavik/i);
});

test("deterministic fallback does not fail closed on 'mixing in <Creative Technology>'", async () => {
  // P1-001 reproduction: `mixing in Dolby Atmos`. The buyer used a
  // creative-phrase verb before "in", so the detector must skip the
  // "in" occurrence and the brief must NOT be rejected as
  // unsupported geography. The canonical-phrase scanner does not
  // match "dolby atmos" (it is not a city), so basedIn stays unset.
  const criteria = await interpret("I need a music producer for mixing in Dolby Atmos.");
  assert.equal(criteria.required.basedIn, undefined);
});

test("deterministic fallback does not fail closed on 'mastering in <Creative Technology>'", async () => {
  // Belt-and-suspenders: the creative-verb preceding-word set
  // covers the most common verbs that introduce a creative phrase
  // after "in". "mastering in Dolby Atmos" must also stay unflagged.
  const criteria = await interpret(
    "I need a music producer for mastering in Dolby Atmos for a film.",
  );
  assert.equal(criteria.required.basedIn, undefined);
});

test("deterministic fallback does not fail closed when creative phrase precedes a canonical location", async () => {
  // Belt-and-suspenders: the creative-verb preceding-word check
  // skips only the matching "in" occurrence. A later canonical
  // location must still be honoured. "mixing in Brooklyn for film"
  // → skip "in Brooklyn" via the creative check (no false-positive
  // fail-closed), and the canonical-phrase scanner picks up the
  // `in brooklyn` substring to set basedIn. The brief ends up with
  // the correct required.basedIn constraint.
  const criteria = await interpret("I need a producer mixing in Brooklyn for film.");
  assert.equal(criteria.required.basedIn?.city, "Brooklyn");
});

test("deterministic fallback fails closed on unknown explicit geography even with mixed creative phrasing", async () => {
  // Belt-and-suspenders: when a brief mixes creative-phrase "in"
  // (skipped by the creative-verb check) with a later unknown
  // geography ("in Antarctica"), the detector must skip the first
  // "in" but still fail-closed on the second. This proves the
  // creative-verb skip is per-occurrence, not global.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a producer for mixing in Dolby Atmos and a second producer in Antarctica.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Antarctica/);
  assert.doesNotMatch(caught.message, /Dolby/);
});

test("deterministic fallback still resolves a lowercase canonical 'in <city>' cue", async () => {
  // Belt-and-suspenders: case-insensitive matching must not regress
  // the canonical path. A lowercase "in brooklyn" continues to set
  // the required basedIn constraint, so the brief stays accepted
  // and the canonical location is preserved.
  const criteria = await interpret("I need a music producer in brooklyn for a remote single.");
  assert.equal(criteria.required.basedIn?.countryCode, "US");
  assert.equal(criteria.required.basedIn?.city, "Brooklyn");
});

// --- P1-001 + P2-001 regression coverage (Codex re-review) ----------
//
// The previous fix skipped location detection whenever `in`
// immediately followed one of six creative verbs. That
// categorically ignored the object even when it was clearly
// geographic (e.g. "recording in Antarctica"). It also left the
// underlying ambiguity in place: nearly every `in <X>` was treated
// as geography unless the immediately preceding word happened to be
// on the six-word exemption list, so ordinary creative briefs like
// "production in stereo" or "vocals in English" failed with
// AiInvalidOutputError.
//
// The new detector anchors the disambiguation on the captured
// OBJECT (a bounded allow-list of clearly non-geographic terms) and
// treats every other `in <X>` as a potential location cue. The tests
// below pin both directions:

test("deterministic fallback fails closed on 'recording in <Explicit Geography>' (P1-001)", async () => {
  // P1-001 reproduction: "I need an in-person recording in Antarctica."
  // The previous creative-verb exemption silently dropped the
  // Antarctica location because "recording" preceded "in". The
  // detector must now examine the OBJECT — "Antarctica" is a clear
  // geographic reference (a place name), not a creative term — and
  // fail closed so the buyer can rephrase using a supported city.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need an in-person recording in Antarctica.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Antarctica/);
});

test("deterministic fallback fails closed on 'mixing in <Explicit Geography>' (P1-001 follow-up)", async () => {
  // P1-001 follow-up: the same fail-closed invariant via the
  // "mixing in" verb the previous fix exempted. "Antarctica" is
  // still a place name; the detector must not let the verb exempt
  // the geography.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a mixing in Antarctica for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Antarctica/);
});

test("deterministic fallback does not fail closed on 'production in stereo' (P2-001)", async () => {
  // P2-001 reproduction: "Need production in stereo for a single".
  // "stereo" is an audio format, not a place. The bounded
  // CREATIVE_OBJECT_PHRASES allow-list lets the brief pass without
  // surfacing MATCHMAKER_INVALID_REQUEST.
  const criteria = await interpret("Need production in stereo for a single.");
  assert.equal(criteria.required.basedIn, undefined);
});

test("deterministic fallback does not fail closed on 'vocals in English' (P2-001)", async () => {
  // P2-001 reproduction: "Need vocals in English for a single".
  // "English" is a language, not a place. The detector must NOT
  // treat "in English" as a geographic cue.
  const criteria = await interpret("Need vocals in English for a single.");
  assert.equal(criteria.required.basedIn, undefined);
});

test("deterministic fallback does not fail closed on 'working in Pro Tools' (P2-001)", async () => {
  // P2-001 reproduction: "Need a producer working in Pro Tools for
  // a single". "Pro Tools" is DAW software, not a place. The
  // detector must skip the object because it is in the bounded
  // CREATIVE_OBJECT_PHRASES allow-list.
  const criteria = await interpret("Need a producer working in Pro Tools for a single.");
  assert.equal(criteria.required.basedIn, undefined);
});

test("deterministic fallback does not fail closed on 'experienced in Dolby Atmos' (P2-001)", async () => {
  // P2-001 reproduction: "I need a producer experienced in Dolby
  // Atmos." The detector must recognise "Dolby Atmos" as a
  // technology, not a place, regardless of the verb preceding it.
  const criteria = await interpret("I need a producer experienced in Dolby Atmos.");
  assert.equal(criteria.required.basedIn, undefined);
});

test("deterministic fallback does not fail closed on 'specializing in Dolby Atmos' (P2-001)", async () => {
  // P2-001 reproduction: "I need a producer specializing in Dolby
  // Atmos." Same invariant as above via a different preceding verb.
  const criteria = await interpret("I need a producer specializing in Dolby Atmos.");
  assert.equal(criteria.required.basedIn, undefined);
});

test("deterministic fallback still fails closed on unknown explicit geography even when the verb is creative (P1-001 belt-and-suspenders)", async () => {
  // P1-001 belt-and-suspenders: a creative verb followed by an
  // explicit geographic name (Antarctica) must still fail closed.
  // The disambiguation is anchored on the OBJECT, not the verb, so
  // the previous "skip if preceded by a creative verb" exemption
  // does not re-introduce silent relaxation.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need an in-person recording in Antarctica for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Antarctica/);
});

test("deterministic fallback does not fail closed when a non-geographic in-object precedes a geographic in-object (P1-001 + P2-001 interaction)", async () => {
  // Belt-and-suspenders for the interaction between P1-001 and
  // P2-001: a brief that mixes creative/technical phrasing
  // ("mixing in Dolby Atmos") with a later geographic cue
  // ("producer in Brooklyn") must skip the first occurrence and
  // honour the canonical location on the second.
  const criteria = await interpret(
    "I need a music producer for mixing in Dolby Atmos and a second producer in Brooklyn.",
  );
  assert.equal(criteria.required.basedIn?.city, "Brooklyn");
});

// --- P1-001 regression coverage (Codex re-review): St. George's ----
//
// The previous location-candidate grammar treated the period in the
// canonical `St.` abbreviation as a clause boundary, so the
// supported briefs below all failed with `AiInvalidOutputError`
// claiming `St` was unsupported. The detector now absorbs the
// abbreviation period when it is immediately followed by another
// proper noun and continues through the apostrophe-s in the
// canonical city name. These tests pin all three supported cues
// and the trailing-punctuation edge cases.

test("deterministic fallback honours 'in St. George's' (canonical supported city)", async () => {
  const criteria = await interpret("I need a producer in St. George's.");
  assert.equal(criteria.required.basedIn?.countryCode, "GD");
  assert.equal(criteria.required.basedIn?.city, "St. George's");
});

test("deterministic fallback honours 'based in St. George's' (canonical supported city)", async () => {
  const criteria = await interpret("I need a producer based in St. George's for a remote single.");
  assert.equal(criteria.required.basedIn?.countryCode, "GD");
  assert.equal(criteria.required.basedIn?.city, "St. George's");
  assert.ok(criteria.required.serviceModes?.includes("Remote"));
});

test("deterministic fallback honours 'from St. George's' (canonical supported city)", async () => {
  const criteria = await interpret("I need a producer from St. George's for a single.");
  assert.equal(criteria.required.basedIn?.countryCode, "GD");
  assert.equal(criteria.required.basedIn?.city, "St. George's");
});

test("deterministic fallback honours lowercase 'in st. george's' (case-insensitive)", async () => {
  // Belt-and-suspenders: the case-insensitive detector must still
  // capture "st. george's" so the canonical supported city is
  // preserved when the buyer types the abbreviation in lowercase.
  const criteria = await interpret("I need a producer in st. george's.");
  assert.equal(criteria.required.basedIn?.countryCode, "GD");
  assert.equal(criteria.required.basedIn?.city, "St. George's");
});

test("deterministic fallback still fails closed on an unsupported 'St.' location", async () => {
  // Belt-and-suspenders: the abbreviation period must only be
  // absorbed when it is followed by another proper noun. A
  // sentence-final "St." (no following capitalised word) must
  // still fail closed if the location is unsupported.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a producer in St.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
});

// --- P1-001 regression coverage (Codex re-review): substring substitution ---
//
// The previous `matchesKnownLocation()` accepted a captured location
// whenever it contained a canonical city substring. That silently
// narrowed longer unsupported locations to a canonical substring:
// Brooklyn Heights → Brooklyn, London Ontario → London GB, Kingston
// Ontario → Kingston Jamaica. The detector now uses exact normalized
// equality (with apostrophe-style variants as the only supported
// non-semantic normalisation) and the canonical-phrase scanner uses
// word-boundary phrase matching instead of substring matching.

test("deterministic fallback resolves 'in Brooklyn' (canonical supported city)", async () => {
  const criteria = await interpret("I need a music producer in Brooklyn for a remote single.");
  assert.equal(criteria.required.basedIn?.countryCode, "US");
  assert.equal(criteria.required.basedIn?.city, "Brooklyn");
  assert.equal(criteria.required.basedIn?.region, "NY");
});

test("deterministic fallback fails closed on 'in Brooklyn Heights' (no substring narrowing to Brooklyn)", async () => {
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a producer based in Brooklyn Heights for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Brooklyn Heights/);
});

test("deterministic fallback resolves 'in London' (canonical supported city)", async () => {
  const criteria = await interpret("I need a music producer in London for a single.");
  assert.equal(criteria.required.basedIn?.countryCode, "GB");
  assert.equal(criteria.required.basedIn?.city, "London");
});

test("deterministic fallback fails closed on 'in London Ontario' (no narrowing to London GB)", async () => {
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a producer based in London Ontario for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /London Ontario/);
});

test("deterministic fallback resolves 'in Kingston' (canonical supported city)", async () => {
  const criteria = await interpret("I need a music producer in Kingston for a single.");
  assert.equal(criteria.required.basedIn?.countryCode, "JM");
  assert.equal(criteria.required.basedIn?.city, "Kingston");
});

test("deterministic fallback fails closed on 'in Kingston Ontario' (no narrowing to Kingston JM)", async () => {
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a producer based in Kingston Ontario for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Kingston Ontario/);
});

test("deterministic fallback fails closed on 'Brooklyn Heights-based' (no substring narrowing)", async () => {
  // Belt-and-suspenders: the <X>-based cue must also reject
  // longer unsupported locations instead of narrowing them to the
  // canonical city substring.
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a Brooklyn Heights-based producer.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Brooklyn Heights/);
});

// --- P1-001 regression coverage (Codex re-review): comma-qualified ---
//
// The location grammar previously treated a comma as the end of
// the candidate, validating only the canonical city prefix and
// discarding the qualifier after the comma. That silently narrowed
// longer unsupported locations:
//   in London, Ontario              → London, GB
//   based in Brooklyn, Connecticut  → Brooklyn, NY
//   in Kingston, Ontario            → Kingston, Jamaica
// The capture now treats `,` as a location-word separator so the
// full comma-qualified token is preserved and exact-match
// validation rejects unsupported candidates.

test("deterministic fallback resolves 'in London' (canonical supported city)", async () => {
  const criteria = await interpret("I need a music producer in London for a single.");
  assert.equal(criteria.required.basedIn?.countryCode, "GB");
  assert.equal(criteria.required.basedIn?.city, "London");
});

test("deterministic fallback fails closed on 'in London, Ontario' (no narrowing to London GB)", async () => {
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a music producer in London, Ontario for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /London, Ontario/);
});

test("deterministic fallback resolves 'in Brooklyn' (canonical supported city)", async () => {
  const criteria = await interpret("I need a music producer in Brooklyn for a single.");
  assert.equal(criteria.required.basedIn?.countryCode, "US");
  assert.equal(criteria.required.basedIn?.city, "Brooklyn");
  assert.equal(criteria.required.basedIn?.region, "NY");
});

test("deterministic fallback fails closed on 'based in Brooklyn, Connecticut' (no narrowing to Brooklyn NY)", async () => {
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a producer based in Brooklyn, Connecticut for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Brooklyn, Connecticut/);
});

test("deterministic fallback resolves 'in Kingston' (canonical supported city)", async () => {
  const criteria = await interpret("I need a music producer in Kingston for a single.");
  assert.equal(criteria.required.basedIn?.countryCode, "JM");
  assert.equal(criteria.required.basedIn?.city, "Kingston");
});

test("deterministic fallback fails closed on 'in Kingston, Ontario' (no narrowing to Kingston JM)", async () => {
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a music producer in Kingston, Ontario for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Kingston, Ontario/);
});

test("deterministic fallback resolves 'in St. George's' (canonical supported city with apostrophe)", async () => {
  const criteria = await interpret("I need a music producer in St. George's for a single.");
  assert.equal(criteria.required.basedIn?.countryCode, "GD");
  assert.equal(criteria.required.basedIn?.city, "St. George's");
});

test("deterministic fallback fails closed on 'in Brooklyn, NY' (no new-alias narrowing)", async () => {
  // Belt-and-suspenders: a buyer who adds a state qualifier must
  // not be silently mapped to the bare canonical city. Per the
  // review's no-new-aliases rule, the only non-semantic
  // normalisation permitted is case / spacing / apostrophe style,
  // so "Brooklyn, NY" cannot become "Brooklyn".
  let caught: unknown;
  try {
    await adapter.interpretBrief({
      actingWorkspaceId: "ws-buyer-1",
      briefText: "I need a music producer in Brooklyn, NY for a single.",
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AiInvalidOutputError");
  assert.match(caught.message, /Brooklyn, NY/);
});
