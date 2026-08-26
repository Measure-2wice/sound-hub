/* eslint-disable @typescript-eslint/no-floating-promises */
// Matchmaker page contract tests.
//
// Background: ticket #60 ships the buyer-facing Matchmaker flow.
// The page submits the buyer's natural-language brief to
// /api/matchmaker/brief and renders the resulting eligibility-
// determined recommendations. These tests pin the UI contract at
// the React boundary so a refactor cannot silently regress the
// buyer journey:
//
//   - The shipped DEFAULT_BRIEF uses Brooklyn-based phrasing
//     (not "in Brooklyn"); the deterministic adapter must
//     preserve the required location (GS 14). This is the exact
//     text the buyer UI submits, so it is exercised here.
//   - The page calls /api/matchmaker/brief with the acting
//     workspace id and the verbatim brief text.
//   - The page renders the persisted Brief + each Recommendation
//     including the factual match evidence, and surfaces the AI
//     provenance + fallback notice when the deterministic
//     fallback ran.
//
// The full BG3 integration (Matchmaker → real TalentSearchService
// → PostgreSQL) is exercised in apps/api's focused and repository
// tests; this file pins the React boundary that fronts them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readMatchmakerPage(): string {
  return readFileSync(`${repoRoot}/src/app/matchmaker/page.tsx`, "utf8");
}

describe("BG3 Matchmaker buyer page contract", () => {
  test("DEFAULT_BRIEF preserves the shipped Brooklyn-based phrasing (GS 14)", () => {
    // The buyer UI ships this exact brief text; the deterministic
    // adapter must recognise "Brooklyn-based" so the required
    // location survives interpretation. If a refactor changes the
    // phrasing, the deterministic adapter's LOCATION_PHRASES
    // table must keep up.
    const source = readMatchmakerPage();
    assert.match(
      source,
      /DEFAULT_BRIEF\s*=\s*"I need a Brooklyn-based producer[^"]*"/,
      "DEFAULT_BRIEF must use Brooklyn-based phrasing so the deterministic adapter preserves the required location",
    );
  });

  test("buyer submission wires actingWorkspaceId + briefText into POST /api/matchmaker/brief", () => {
    // The page must call the shared matchmaker client with both
    // required fields. A refactor that omits either would let
    // the server reject the request with MATCHMAKER_INVALID_REQUEST.
    const source = readMatchmakerPage();
    assert.match(
      source,
      /submitBrief\(\{[\s\S]*actingWorkspaceId[\s\S]*briefText:[\s\S]*\}\)/,
      "buyer submission must include actingWorkspaceId and briefText",
    );
    assert.match(
      source,
      /await submitBrief\(\{[\s\S]*\}\)/,
      "submitBrief must be awaited so a rejection can be surfaced",
    );
  });

  test("buyer page filters workspaces by Buyer capability", () => {
    // The page must NOT expose Seller-only Workspaces in the
    // acting-Workspace selector. The selector computes
    // `workspaces.filter(w => w.capabilities.includes("Buyer"))`
    // and renders only the resulting list.
    const source = readMatchmakerPage();
    assert.match(
      source,
      /capabilities\.includes\("Buyer"\)/,
      "buyer page must filter acting workspaces by Buyer capability",
    );
    assert.match(
      source,
      /data-testid="matchmaker-no-buyer-workspace"/,
      "buyer page must surface the empty-state when no Buyer-capable Workspace is available",
    );
  });

  test("buyer page surfaces AI provenance + fallback notice", () => {
    // The UI must disclose which adapter produced the criteria so
    // the buyer understands the provenance. The fallback notice
    // data-testid is the element reviewers can assert against.
    const source = readMatchmakerPage();
    assert.match(
      source,
      /data-testid="matchmaker-fallback-notice"/,
      "buyer page must surface the fallback notice when the deterministic fallback ran",
    );
    assert.match(
      source,
      /Provider: \{brief\.aiProvider\}[\s\S]*Fallback: \{brief\.aiFallbackUsed[^}]*\}/,
      "buyer page must render provider + fallback provenance on the persisted brief",
    );
  });

  test("buyer page renders factual explanations (no AI-invented text)", () => {
    // The page must iterate over `recommendation.explanations`
    // (allow-listed kinds assembled by the application layer
    // from the returned search result) and render each entry's
    // label. AI cannot inject free-form text at this boundary.
    const source = readMatchmakerPage();
    assert.match(
      source,
      /data-testid="matchmaker-explanation-item"/,
      "buyer page must render each explanation entry from the validated DTO",
    );
    assert.match(
      source,
      /recommendation\.explanations\.map\(/,
      "buyer page must drive the explanations list off the DTO, not a generated string",
    );
  });
});
