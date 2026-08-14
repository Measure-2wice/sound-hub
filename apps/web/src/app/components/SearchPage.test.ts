/* eslint-disable @typescript-eslint/no-floating-promises */
// Buyer-facing match-evidence UI tests.
//
// P1-003 regression: the result card previously rendered a qualitative
// "Strong/Good/Partial/Weak fit" band derived directly from the internal
// `relevanceScore`, and exposed the raw score in a `data-relevance-score`
// DOM attribute. The v1 contract says `relevanceScore` is a bounded
// strategy-specific ordering signal — not a probability, confidence
// estimate, or quality rating — and the buyer UI must not render it as a
// percentage OR derive a qualitative strength band from it. The fix
// removes the score-derived fit summary, the raw-score DOM attribute,
// and the `fitBandFor` / `describeFit` helpers; the deterministic
// `matchReason` produced by the search service stays visible.
//
// This test reads the component source as a static string and asserts
// that no score-derived UI surface is reintroduced. The web test suite
// runs in plain `node:test` without DOM testing infrastructure, so a
// component source-level assertion is the most direct regression we can
// pin without taking on a new dependency. The assertions cover both the
// buyer-facing strings (which a screen reader would read) and the data
// attributes (which downstream tests, telemetry, or extensions could
// observe).
//
// P2-002 regression: the previous markup duplicated title/description/
// category/mode/bundle rendering between the best and additional paths.
// The fix extracts a shared `OfferingDetail` component; this test pins
// that the shared renderer exists and that both call sites consume it
// with stable `data-testid` prefixes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const searchPageSource = readFileSync(resolve(here, "SearchPage.tsx"), "utf8");

describe("SearchPage buyer-facing match evidence (P1-003)", () => {
  test("does not expose relevanceScore as a DOM data attribute", () => {
    assert.equal(
      searchPageSource.includes("data-relevance-score"),
      false,
      "the buyer UI must not expose the raw relevanceScore as a DOM attribute",
    );
  });

  test("does not expose a derived fit-band DOM attribute", () => {
    assert.equal(
      searchPageSource.includes("data-fit-band"),
      false,
      "the buyer UI must not expose a qualitative fit band derived from relevanceScore",
    );
  });

  test("does not render a result-fit-summary block", () => {
    assert.equal(
      searchPageSource.includes('data-testid="result-fit-summary"'),
      false,
      "the result-fit-summary block (score-derived qualitative fit) must be removed",
    );
  });

  test("does not define score-derived fit-band helpers", () => {
    assert.equal(
      searchPageSource.includes("function fitBandFor"),
      false,
      "fitBandFor must be removed; relevanceScore must not drive a buyer-facing band",
    );
    assert.equal(
      searchPageSource.includes("function describeFit"),
      false,
      "describeFit must be removed; relevanceScore must not produce buyer-facing prose",
    );
  });

  test("does not include buyer-facing score-derived strength prose", () => {
    // The previous implementation rendered one of four bands derived
    // from `relevanceScore` thresholds. None of these phrases should
    // appear in the buyer-facing UI anymore.
    const forbidden = [
      "Strong qualitative fit",
      "Good qualitative fit",
      "Partial qualitative fit",
      "Weak qualitative fit",
    ];
    for (const phrase of forbidden) {
      assert.equal(
        searchPageSource.includes(phrase),
        false,
        `buyer-facing phrase "${phrase}" must be removed`,
      );
    }
  });

  test("still renders the deterministic matchReason block as the buyer-facing evidence", () => {
    assert.ok(
      searchPageSource.includes('data-testid="result-match-reason"'),
      "the result-match-reason testid anchors the deterministic match evidence",
    );
    assert.ok(
      searchPageSource.includes("Why this matches"),
      "the matchReason block must keep its buyer-facing header",
    );
  });
});

describe("SearchPage shared offering-detail markup (P2-002)", () => {
  test("extracts an OfferingDetail renderer used by both best and additional paths", () => {
    assert.ok(
      searchPageSource.includes("function OfferingDetail"),
      "the shared OfferingDetail component must exist",
    );
    // The best card uses the shared renderer; its lead-only additions
    // (service areas, genres, pricing, pricing disclaimer) remain on
    // the BestOfferingCard body.
    assert.ok(
      searchPageSource.includes("<OfferingDetail"),
      "the best card must consume the shared OfferingDetail",
    );
    assert.ok(
      searchPageSource.match(/OfferingDetail[\s\S]*?testIdPrefix="result-additional-offering"/) !==
        null,
      "the additional offerings list must consume the shared OfferingDetail",
    );
  });

  test("additional offerings keep the same row markup as the best card", () => {
    // The shared component renders title + category + service-mode +
    // bundle-includes testids via `${testIdPrefix}-title` template
    // literals; both call sites must pass a stable prefix so the
    // rendered DOM carries the same data-testid conventions.
    for (const testId of ["title", "category", "service-mode", "included-services"]) {
      const suffix = `-${testId}`;
      const sharedTemplate = `\`\${testIdPrefix}${suffix}\``;
      assert.ok(
        searchPageSource.includes(sharedTemplate),
        `shared OfferingDetail must render the "${testId}" testid via template literal`,
      );
      assert.ok(
        searchPageSource.includes('testIdPrefix="result-additional-offering"'),
        `additional offerings must pass the "result-additional-offering" prefix`,
      );
      assert.ok(
        searchPageSource.includes('testIdPrefix="result-offering"'),
        `best offering must pass the "result-offering" prefix`,
      );
    }
  });
});
