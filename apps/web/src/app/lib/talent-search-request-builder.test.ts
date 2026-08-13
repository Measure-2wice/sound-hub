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
  serviceAreaCountryCode: "",
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
      serviceAreaCountryCode: "US",
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
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceAreaCountryCode: "GB" }), true);
  });

  test("whitespace-only filter inputs are not usable", () => {
    assert.equal(hasUsableCriteria("", { ...emptyFilters, basedInCountryCode: "   " }), false);
    assert.equal(hasUsableCriteria("", { ...emptyFilters, serviceAreaCountryCode: "  " }), false);
  });
});
