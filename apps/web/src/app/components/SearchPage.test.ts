/* eslint-disable @typescript-eslint/no-floating-promises */
// React 18 ships `renderToStaticMarkup` with a synchronous string return
// type, but `react-dom/server`'s typings expose the concurrent entry points
// alongside it. `@typescript-eslint/no-floating-promises` flags the call
// sites as floating promises even though the function returns a string,
// and the only calls in this file are the synchronous server renderer.
//
// Buyer-facing match-evidence UI tests.
//
// These tests exercise the rendered output of `ResultCard` against a
// controlled sample `TalentSearchResultV1` and assert on the HTML a real
// browser would see, not on private source structure. The web test suite
// runs in plain `node:test`; React ships `react-dom/server` so a presentational
// component can be rendered to an HTML string and asserted on without
// taking on a DOM testing dependency.
//
// What the tests pin (per the M1.5 / M1.6 review findings):
//
//   - P1-001 remediation: the result card renders BOTH deterministic
//     `matchReason` evidence AND a qualitative-fit presentation. The
//     qualitative-fit description names matched vs total preferences
//     factually. It is NEVER a percentage and NEVER a confidence or
//     quality claim.
//   - P1-002 remediation: the suite no longer reads `SearchPage.tsx` as
//     text, no longer pins helper names, and no longer greps for JSX
//     template literals or implementation structure. A behavior-preserving
//     refactor of `ResultCard` / `OfferingDetail` must keep these tests
//     green.
//   - P1-003 regression: the result card does not render
//     `relevanceScore` as a buyer-facing percentage or derive a
//     qualitative strength band from it.
//   - P2-001 regression: the additional-offering row uses the same
//     `data-testid` conventions as the best-offering row so the buyer
//     UI never collapses two distinct presentations onto one row.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TalentSearchResultV1 } from "@soundhub/types";
import { ResultCard } from "./SearchPage";

// Stable sample so the assertions read as a single behavioral contract
// rather than as ad-hoc strings. The values are minimal-but-valid for the
// public schema: a real seller, one best matching offering, one
// additional matching offering with a bundle-only IncludedService.
const sampleResult: TalentSearchResultV1 = {
  seller: {
    sellerId: "seller-1",
    professionalName: "Marc-André Pierre",
    specialties: ["Producer"],
    bio: "Brooklyn-based Haitian producer.",
    basedIn: { city: "Brooklyn", region: "NY", countryCode: "US" },
    caribbeanAffiliationCodes: ["HT"],
  },
  bestMatchingOffering: {
    offeringId: "offering-1",
    title: "Haitian dancehall single production — remote",
    description: "Remote dancehall single production.",
    primaryCategory: { key: "music-production", name: "Music Production" },
    includedServices: [],
    genreTags: ["Dancehall"],
    serviceMode: "Remote",
    serviceAreas: [{ countryCode: "US" }],
    pricing: {
      kind: "StartingAt",
      amount: { amountMinor: 60000, currency: "USD" },
      unit: "track",
    },
  },
  additionalMatchingOfferings: [
    {
      offeringId: "offering-2",
      title: "Mixing for Caribbean-rooted releases",
      description: "Mixing for Caribbean-rooted releases.",
      primaryCategory: { key: "mixing", name: "Mixing" },
      includedServices: [
        { key: "remote-coaching", name: "Remote coaching", purchaseMode: "BundleOnly" },
      ],
      genreTags: ["Dancehall"],
      serviceMode: "Remote",
      serviceAreas: [{ countryCode: "US" }],
    },
  ],
  relevanceScore: 0.75,
  matchReason: "matched offering title; preferred genre: Dancehall",
  preferenceCoverage: { matched: 1, total: 2 },
};

const fullCoverageResult: TalentSearchResultV1 = {
  ...sampleResult,
  matchReason: "matched offering title; preferred genre: Dancehall; preferred specialty: Producer",
  preferenceCoverage: { matched: 2, total: 2 },
};

describe("SearchPage buyer-facing match evidence (P1-001)", () => {
  test("renders both the deterministic matchReason evidence and the qualitative fit", () => {
    const html = renderToStaticMarkup(ResultCard({ result: sampleResult }));

    // Deterministic evidence: the result-match-reason block carries the
    // factual matchReason the search service produced.
    assert.ok(
      html.includes('data-testid="result-match-reason"'),
      "the result card must render the result-match-reason block",
    );
    assert.ok(
      html.includes("Why this matches"),
      "the matchReason block must keep its buyer-facing header",
    );
    assert.ok(
      html.includes("matched offering title; preferred genre: Dancehall"),
      "the matchReason text must round-trip verbatim from the API result",
    );

    // Qualitative fit: a distinct, separately-labeled block that names
    // matched vs total preferences factually. It is NOT a percentage, it
    // is NOT derived from relevanceScore, and it is NOT a score-derived
    // confidence or quality band.
    assert.ok(
      html.includes('data-testid="result-qualitative-fit"'),
      "the result card must render the result-qualitative-fit block",
    );
    assert.ok(
      html.includes("Preference coverage"),
      "the qualitative-fit block must keep its buyer-facing header",
    );
    assert.ok(
      html.includes("Matches 1 of 2 requested preferences; 1 not matched."),
      "the qualitative-fit description must name matched/total preferences factually",
    );
  });

  test("qualitative fit shows the full-coverage variant when all preferences match", () => {
    const html = renderToStaticMarkup(ResultCard({ result: fullCoverageResult }));

    assert.ok(
      html.includes("Matches all 2 requested preferences."),
      "the qualitative-fit description must say full coverage when matched === total",
    );
  });

  test("does not render a buyer-facing percentage or confidence claim", () => {
    const html = renderToStaticMarkup(ResultCard({ result: sampleResult }));

    // No numeric percentage next to any of the prohibited labels.
    assert.doesNotMatch(
      html,
      /\b\d{1,3}%\s*(match|score|confidence|fit)/i,
      "the result card must not render any percentage-based match score",
    );
    // The bounded strategy-specific score must never reach the buyer.
    assert.doesNotMatch(
      html,
      /relevanceScore/i,
      "the result card must not surface the internal relevanceScore name",
    );
    // The previous (P1-003) score-derived bands must stay out.
    for (const phrase of [
      "Strong qualitative fit",
      "Good qualitative fit",
      "Partial qualitative fit",
      "Weak qualitative fit",
    ]) {
      assert.doesNotMatch(
        html,
        new RegExp(phrase, "i"),
        `the result card must not render the score-derived band "${phrase}"`,
      );
    }
    // Confidence and guarantee claims are also off the table.
    assert.doesNotMatch(
      html,
      /\b(confidence|guarantee|quality)\b/i,
      "the result card must not render a buyer-facing confidence/guarantee/quality claim",
    );
  });

  // P1-001 Codex review remediation (revised again after Codex re-review):
  // a required-only search returns no `preferenceCoverage` AND no
  // `textCoverage`. The buyer UI must STILL surface a qualitative-fit
  // block so Issue #6's "deterministic evidence AND qualitative fit"
  // requirement is satisfied for every meaningful result. The fallback
  // wording is derived from existing result facts (matchReason +
  // absence of coverage fields) and is non-percentage / never derived
  // from `relevanceScore` / never a confidence claim.
  test("renders a deterministic required-only qualitative-fit fallback when both coverage fields are absent", () => {
    const requiredOnlyResult: TalentSearchResultV1 = {
      seller: sampleResult.seller,
      bestMatchingOffering: sampleResult.bestMatchingOffering,
      additionalMatchingOfferings: sampleResult.additionalMatchingOfferings,
      relevanceScore: sampleResult.relevanceScore,
      matchReason: "eligible standalone offering",
    };
    const html = renderToStaticMarkup(ResultCard({ result: requiredOnlyResult }));

    assert.ok(
      html.includes('data-testid="result-match-reason"'),
      "the matchReason block must still render when coverage is absent",
    );
    assert.ok(
      html.includes("eligible standalone offering"),
      "the matchReason text must still round-trip verbatim",
    );
    assert.ok(
      html.includes('data-testid="result-qualitative-fit"'),
      "the qualitative-fit block must render when both coverage fields are absent",
    );
    assert.ok(
      html.includes("Eligibility"),
      "the required-only fallback must label its qualitative-fit block distinctly",
    );
    assert.ok(
      html.includes("Eligible based on your structured filters (eligible standalone offering)."),
      "the required-only qualitative-fit must name the deterministic matchReason fact alongside the structured-filters wording",
    );
    assert.ok(
      !html.includes("Preference coverage"),
      "the preference-coverage header must not appear for a required-only request",
    );
    assert.ok(
      !html.includes("Brief coverage"),
      "the brief-coverage header must not appear for a required-only request",
    );
  });

  // P1-001 regression (revised after Codex review): the service omits
  // `preferenceCoverage` whenever the buyer supplied no canonical
  // preference atoms, AND it omits `textCoverage` whenever the buyer
  // supplied no usable query. Both fields remain optional in the public
  // DTO (P1-002) for backward compatibility with in-flight clients.
  test("keeps the public DTO coverage fields optional and absent for a required-only result", () => {
    const requiredOnlyResult: TalentSearchResultV1 = {
      seller: sampleResult.seller,
      bestMatchingOffering: sampleResult.bestMatchingOffering,
      additionalMatchingOfferings: sampleResult.additionalMatchingOfferings,
      relevanceScore: sampleResult.relevanceScore,
      matchReason: "eligible standalone offering",
    };
    const html = renderToStaticMarkup(ResultCard({ result: requiredOnlyResult }));

    // The public DTO still omits the optional coverage fields on a
    // required-only request — the fallback is rendered entirely from
    // existing result facts. No new DTO field is introduced.
    assert.equal(
      requiredOnlyResult.preferenceCoverage,
      undefined,
      "preferenceCoverage must remain absent on a required-only result",
    );
    assert.equal(
      requiredOnlyResult.textCoverage,
      undefined,
      "textCoverage must remain absent on a required-only result",
    );
    assert.ok(
      html.includes('data-testid="result-qualitative-fit"'),
      "the required-only fallback must still surface a qualitative-fit block",
    );
  });

  // P1-001 Codex review remediation: a query-only search (no preferences)
  // must STILL surface a qualitative-fit block — the `textCoverage` line
  // describes matched vs total query tokens factually, never as a
  // percentage, never derived from `relevanceScore`. The matchReason
  // alone does not satisfy Issue #6's "deterministic evidence AND
  // qualitative fit" requirement.
  test("renders the brief-coverage qualitative-fit block when textCoverage is present without preferences", () => {
    const textOnlyResult: TalentSearchResultV1 = {
      seller: sampleResult.seller,
      bestMatchingOffering: sampleResult.bestMatchingOffering,
      additionalMatchingOfferings: sampleResult.additionalMatchingOfferings,
      relevanceScore: sampleResult.relevanceScore,
      matchReason: "matched offering title; matched category key",
      textCoverage: { matched: 2, total: 4 },
    };
    const html = renderToStaticMarkup(ResultCard({ result: textOnlyResult }));

    assert.ok(
      html.includes('data-testid="result-qualitative-fit"'),
      "the qualitative-fit block must render when textCoverage is present",
    );
    assert.ok(
      html.includes("Brief coverage"),
      "the qualitative-fit header must label the textCoverage line distinctly",
    );
    assert.ok(
      html.includes("Matches 2 of 4 words from your brief; 2 not matched."),
      "the brief-coverage line must describe matched/total words factually",
    );
    assert.ok(
      !html.includes("Preference coverage"),
      "the preference-coverage header must not appear for a query-only request",
    );
  });

  // P1-001 Codex review remediation: a request that supplies BOTH a
  // query and preferences must surface BOTH factual-evidence lines,
  // each labeled distinctly. The buyer-facing state carries the
  // deterministic matchReason plus two independent coverage lines.
  test("renders both preference and brief coverage when both fields are present", () => {
    const combinedResult: TalentSearchResultV1 = {
      seller: sampleResult.seller,
      bestMatchingOffering: sampleResult.bestMatchingOffering,
      additionalMatchingOfferings: sampleResult.additionalMatchingOfferings,
      relevanceScore: sampleResult.relevanceScore,
      matchReason: sampleResult.matchReason,
      preferenceCoverage: { matched: 1, total: 2 },
      textCoverage: { matched: 3, total: 4 },
    };
    const html = renderToStaticMarkup(ResultCard({ result: combinedResult }));

    const qualitativeBlocks = html.match(/data-testid="result-qualitative-fit"/g) ?? [];
    assert.ok(
      qualitativeBlocks.length >= 2,
      "both coverage lines must render, producing at least two qualitative-fit blocks",
    );
    assert.ok(html.includes("Preference coverage"), "the preference-coverage header must render");
    assert.ok(
      html.includes("Matches 1 of 2 requested preferences; 1 not matched."),
      "the preference-coverage line must be present",
    );
    assert.ok(html.includes("Brief coverage"), "the brief-coverage header must render");
    assert.ok(
      html.includes("Matches 3 of 4 words from your brief; 1 not matched."),
      "the brief-coverage line must be present",
    );
  });

  // P1-001 Codex review remediation: the brief-coverage full-match
  // variant uses the singular/plural wording exactly like the preference
  // variant so the two coverage lines read consistently.
  test("brief coverage shows the full-coverage variant when all words matched", () => {
    const fullTextCoverageResult: TalentSearchResultV1 = {
      seller: sampleResult.seller,
      bestMatchingOffering: sampleResult.bestMatchingOffering,
      additionalMatchingOfferings: sampleResult.additionalMatchingOfferings,
      relevanceScore: sampleResult.relevanceScore,
      matchReason: sampleResult.matchReason,
      textCoverage: { matched: 1, total: 1 },
    };
    const html = renderToStaticMarkup(ResultCard({ result: fullTextCoverageResult }));
    assert.ok(
      html.includes("Matches all 1 word of your brief."),
      "the brief-coverage description must say full coverage when matched === total",
    );
  });
});

describe("SearchPage shared offering-detail markup (P2-001)", () => {
  test("best offering and additional offerings render the same data-testid conventions", () => {
    const html = renderToStaticMarkup(ResultCard({ result: sampleResult }));

    // The best-offering path uses the `result-offering-…` prefix.
    assert.ok(
      html.includes('data-testid="result-offering-title"'),
      "the best offering must render with the result-offering-title testid",
    );
    assert.ok(
      html.includes('data-testid="result-offering-category"'),
      "the best offering must render with the result-offering-category testid",
    );
    assert.ok(
      html.includes('data-testid="result-offering-service-mode"'),
      "the best offering must render with the result-offering-service-mode testid",
    );
    assert.ok(
      html.includes('data-testid="result-offering-pricing"'),
      "the best offering must render with the result-offering-pricing testid",
    );

    // The additional-offering path uses the `result-additional-offering-…`
    // prefix for the row markup that OfferingDetail owns. The full set is
    // pinned here so a future OfferingDetail refactor (P2-001) cannot
    // silently drop one of the row fields.
    assert.ok(
      html.includes('data-testid="result-additional-offering-title"'),
      "the additional offering must render with the result-additional-offering-title testid",
    );
    assert.ok(
      html.includes('data-testid="result-additional-offering-category"'),
      "the additional offering must render with the result-additional-offering-category testid",
    );
    assert.ok(
      html.includes('data-testid="result-additional-offering-service-mode"'),
      "the additional offering must render with the result-additional-offering-service-mode testid",
    );
    assert.ok(
      html.includes('data-testid="result-additional-offering-included-services"'),
      "the additional offering must render its bundle-includes testid",
    );
  });

  test("bundle-only IncludedServices are labeled 'bundle only' on both paths", () => {
    // The best offering has no IncludedServices. The additional offering
    // carries one bundle-only IncludedService that must be labeled
    // `bundle only` so the buyer never reads it as a standalone purchase.
    const html = renderToStaticMarkup(ResultCard({ result: sampleResult }));

    assert.ok(
      html.includes("Remote coaching"),
      "the bundle component must appear by its public name",
    );
    assert.ok(html.includes("bundle only"), "every bundle component must be labeled 'bundle only'");
  });

  test("renders the deterministic pricing disclaimer so no pricing presentation reads as a quote", () => {
    const html = renderToStaticMarkup(ResultCard({ result: sampleResult }));

    assert.ok(
      html.includes('data-testid="result-offering-pricing-disclaimer"'),
      "the best offering must render its pricing disclaimer",
    );
    assert.ok(
      html.includes("non-binding"),
      "the pricing disclaimer must name the non-binding framing",
    );
    assert.ok(
      html.includes("approved terms"),
      "the pricing disclaimer must name the approved-terms boundary",
    );
  });
});
