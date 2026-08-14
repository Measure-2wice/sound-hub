/* eslint-disable @typescript-eslint/no-floating-promises */
// Browser request-builder tests.
//
// These tests verify that every candidate payload produced by the
// shared request builder is schema-valid. The Codex review surfaced
// that the browser previously built requests by hand and dropped a
// one-character query when any required filter was supplied; that
// silently violated the rule that required constraints are never
// "saved" by relaxing or dropping a query. The fix is: build the
// candidate payload, parse it with the shared Zod schema, and let
// the schema be the only thing that decides what enters the wire.
//
// Each test below is the load-bearing assertion that the builder
// cannot bypass that schema-level enforcement.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { talentSearchRequestV1Schema } from "@soundhub/types";
import {
  buildCandidatePayload,
  hasUsableCriteria,
  type RequiredFiltersValue,
} from "./talent-search-request-builder.js";

const emptyFilters: RequiredFiltersValue = {
  primaryCategoryKey: "",
  independentlyPurchasableServiceKey: "",
  serviceModes: [],
  basedInCountryCode: "",
  basedInRegion: "",
  basedInCity: "",
  serviceAreaCountryCode: "",
  serviceAreaRegion: "",
  serviceAreaCity: "",
};

describe("buildCandidatePayload + talentSearchRequestV1Schema", () => {
  test("empty query and empty filters produce a payload that the schema rejects (no usable criteria)", () => {
    const candidate = buildCandidatePayload("", emptyFilters);
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false, "an empty payload must not be schema-valid");
  });

  test("a one-character query combined with a valid required filter is NOT silently dropped — the schema rejects it with a query field error", () => {
    // Buyer types "a" and selects a category. The builder must keep
    // the query in the candidate so the schema can reject it with
    // an actionable field-level error. The pre-fix code dropped this
    // exact case and produced a successful filter-only request.
    const candidate = buildCandidatePayload("a", {
      ...emptyFilters,
      primaryCategoryKey: "music-production",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false, "the one-character query must surface a schema rejection");
    const issue = parsed.error.issues.find((i) => i.path.join(".") === "query");
    assert.ok(issue, "the rejection must name the query path");
  });

  test("all-empty structured filters with no query do not craft a query-only request", () => {
    const candidate = buildCandidatePayload("", emptyFilters);
    assert.equal(candidate.query, undefined);
    assert.equal(candidate.required, undefined);
  });

  test("a query of 2+ characters with no filters produces a schema-valid request", () => {
    const candidate = buildCandidatePayload("dancehall", emptyFilters);
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.query, "dancehall");
  });

  test("a malformed basedIn countryCode is NOT silently dropped — it reaches the schema and the schema rejects it", () => {
    // Numeric `12` passes the 2-char length check but fails the
    // shared Zod `/^[A-Z]{2}$/` regex. The schema rejects the
    // payload with a field-level error pointing at the countryCode.
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      basedInCountryCode: "12",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false);
    assert.ok(
      parsed.error.issues.some((i) => i.path.join(".").includes("basedIn.countryCode")),
      "the rejection must name the basedIn.countryCode path",
    );
  });

  test("a malformed serviceArea countryCode is NOT silently dropped — it reaches the schema and the schema rejects it", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      serviceAreaCountryCode: "12",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false);
    assert.ok(
      parsed.error.issues.some((i) => i.path.join(".").includes("serviceArea.countryCode")),
      "the rejection must name the serviceArea.countryCode path",
    );
  });

  test("a lower-case basedIn countryCode is upper-cased so the schema accepts it", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      basedInCountryCode: "jm",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.basedIn?.countryCode, "JM");
  });

  test("a lower-case serviceArea countryCode is upper-cased so the schema accepts it", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      serviceAreaCountryCode: "gb",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.serviceArea?.countryCode, "GB");
  });

  test("a basedIn city-only constraint survives the schema and is preserved on the request", () => {
    // Brooklyn is the canonical positive control for Marc-André
    // Pierre. The buyer is allowed to constrain basedIn.city without
    // supplying a countryCode; the schema accepts the partial
    // LocationFilter and the builder does not silently drop it.
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      basedInCity: "Brooklyn",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.basedIn?.city, "Brooklyn");
    assert.equal(parsed.data.required?.basedIn?.countryCode, undefined);
    assert.equal(parsed.data.required?.basedIn?.region, undefined);
  });

  test("a basedIn region-only constraint survives the schema and is preserved on the request", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      basedInRegion: "NY",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.basedIn?.region, "NY");
    assert.equal(parsed.data.required?.basedIn?.countryCode, undefined);
    assert.equal(parsed.data.required?.basedIn?.city, undefined);
  });

  test("a serviceArea city-only constraint survives the schema and is preserved on the request", () => {
    const candidate = buildCandidatePayload("", {
      ...emptyFilters,
      serviceAreaCity: "London",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.serviceArea?.city, "London");
  });

  test("a serviceArea region-only constraint survives the schema and is preserved on the request", () => {
    const candidate = buildCandidatePayload("", {
      ...emptyFilters,
      serviceAreaRegion: "ON",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.serviceArea?.region, "ON");
  });

  test("a fully populated basedIn (city + region + countryCode) is preserved verbatim", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      basedInCity: "Brooklyn",
      basedInRegion: "NY",
      basedInCountryCode: "US",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.required?.basedIn, {
      city: "Brooklyn",
      region: "NY",
      countryCode: "US",
    });
  });

  test("a fully populated serviceArea (city + region + countryCode) is preserved verbatim", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      serviceAreaCity: "London",
      serviceAreaRegion: "LDN",
      serviceAreaCountryCode: "GB",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.required?.serviceArea, {
      city: "London",
      region: "LDN",
      countryCode: "GB",
    });
  });

  test("whitespace-only basedIn.city is trimmed and dropped, NOT surfaced as a malformed payload", () => {
    // Buyer types "  " into the basedIn.city input. The builder trims
    // it, sees an empty string, and omits the field rather than
    // sending a value the schema would reject. The rest of the
    // request remains valid.
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      basedInCity: "   ",
      basedInCountryCode: "JM",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.basedIn?.city, undefined);
    assert.equal(parsed.data.required?.basedIn?.countryCode, "JM");
  });

  test("whitespace-only serviceArea.region is trimmed and dropped, NOT surfaced as a malformed payload", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      serviceAreaRegion: "   ",
      serviceAreaCountryCode: "GB",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.required?.serviceArea?.region, undefined);
    assert.equal(parsed.data.required?.serviceArea?.countryCode, "GB");
  });

  test("a city whose trimmed length exceeds the 120-character schema bound surfaces a schema-level error", () => {
    // The HTML input caps city at 120 chars, but the builder is
    // pure and accepts any string. A 200-character city must reach
    // the schema and be rejected at the canonical boundary so the
    // browser surfaces a standard envelope rather than silently
    // dropping a field the buyer actually typed.
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      basedInCity: "x".repeat(200),
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, false);
    assert.ok(
      parsed.error.issues.some((i) => i.path.join(".").includes("basedIn.city")),
      "the rejection must name the basedIn.city path",
    );
  });

  test("a single primaryCategoryKey is wrapped in an array and the schema accepts it", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      primaryCategoryKey: "music-production",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.required?.primaryCategoryKeys, ["music-production"]);
  });

  test("a single serviceMode is wrapped in an array and the schema accepts it", () => {
    const candidate = buildCandidatePayload("dancehall", {
      ...emptyFilters,
      serviceModes: ["Remote"],
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data.required?.serviceModes, ["Remote"]);
  });

  test("all structured filters combined produce a schema-valid structured-only request", () => {
    const candidate = buildCandidatePayload("", {
      primaryCategoryKey: "music-production",
      independentlyPurchasableServiceKey: "mixing",
      serviceModes: ["Remote", "Hybrid"],
      basedInCountryCode: "GB",
      basedInRegion: "LDN",
      basedInCity: "London",
      serviceAreaCountryCode: "US",
      serviceAreaRegion: "NY",
      serviceAreaCity: "Brooklyn",
    });
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.query, undefined);
    assert.equal(parsed.data.required?.primaryCategoryKeys?.[0], "music-production");
    assert.equal(parsed.data.required?.independentlyPurchasableServiceKeys?.[0], "mixing");
    assert.deepEqual(parsed.data.required?.serviceModes, ["Remote", "Hybrid"]);
    assert.equal(parsed.data.required?.basedIn?.countryCode, "GB");
    assert.equal(parsed.data.required?.serviceArea?.countryCode, "US");
  });
});

describe("hasUsableCriteria", () => {
  test("empty query and empty filters are not usable", () => {
    assert.equal(hasUsableCriteria("", emptyFilters), false);
  });

  test("a 1-character query is not usable on its own", () => {
    assert.equal(hasUsableCriteria("a", emptyFilters), false);
  });

  test("a 2-character query is usable", () => {
    assert.equal(hasUsableCriteria("ab", emptyFilters), true);
  });

  test("any single non-empty structured filter is usable", () => {
    assert.equal(
      hasUsableCriteria("", { ...emptyFilters, primaryCategoryKey: "music-production" }),
      true,
    );
    assert.equal(
      hasUsableCriteria("", {
        ...emptyFilters,
        independentlyPurchasableServiceKey: "music-production",
      }),
      true,
    );
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceModes: ["Remote"] }), true);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, basedInCountryCode: "JM" }), true);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, basedInRegion: "NY" }), true);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, basedInCity: "Brooklyn" }), true);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceAreaCountryCode: "GB" }), true);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceAreaRegion: "LDN" }), true);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceAreaCity: "London" }), true);
  });

  test("whitespace-only filter inputs are not usable", () => {
    assert.equal(hasUsableCriteria("", { ...emptyFilters, basedInCountryCode: "   " }), false);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, basedInRegion: "   " }), false);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, basedInCity: "   " }), false);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceAreaCountryCode: "  " }), false);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceAreaRegion: "  " }), false);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceAreaCity: "  " }), false);
  });
});
