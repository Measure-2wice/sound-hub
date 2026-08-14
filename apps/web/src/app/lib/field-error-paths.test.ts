/* eslint-disable @typescript-eslint/no-floating-promises */
// Browser field-error ownership tests.
//
// The shared `field-error-paths` module is the single source of truth
// for which field-error paths the `RequiredFilters` panel claims. The
// Codex P2-001 finding flagged that the previous design had two
// independent copies of `CONTROLLED_PATHS` / `isControlledPath` in
// `SearchPage.tsx` and `RequiredFilters.tsx`, so adding a field path
// to only one copy could render an error twice or not at all.
//
// These tests partition every supported required-field path and
// confirm controlled and unmatched errors each render exactly once
// — and that the partition is symmetric (the page's unmatched set is
// exactly the complement of the panel's controlled set).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CONTROLLED_REQUIRED_PATHS,
  isControlledRequiredPath,
  partitionFieldErrors,
} from "./field-error-paths.js";
import type { ApiFieldErrorV1 } from "@soundhub/types";

function errorAt(path: string): ApiFieldErrorV1 {
  return { path, code: "custom", message: `error at ${path}` };
}

describe("isControlledRequiredPath", () => {
  test("returns true for every declared controlled prefix", () => {
    for (const prefix of CONTROLLED_REQUIRED_PATHS) {
      assert.equal(isControlledRequiredPath(prefix), true, `prefix ${prefix} must be controlled`);
    }
  });

  test("returns true for nested paths under a controlled control-level prefix", () => {
    assert.equal(isControlledRequiredPath("required.primaryCategoryKeys.0"), true);
    assert.equal(isControlledRequiredPath("required.independentlyPurchasableServiceKeys.0"), true);
    assert.equal(isControlledRequiredPath("required.serviceModes.0"), true);
    assert.equal(isControlledRequiredPath("required.basedIn.countryCode"), true);
    assert.equal(isControlledRequiredPath("required.serviceArea.countryCode"), true);
  });

  test("returns false for unconsumed nested required paths so the global panel can render them", () => {
    // The bare section-level path IS controlled (rendered by the panel header),
    // but any nested path that has no rendered control MUST fall through to the
    // global panel rather than be silently swallowed by the panel claim.
    assert.equal(isControlledRequiredPath("required"), true);
    assert.equal(isControlledRequiredPath("required.futureField"), false);
    assert.equal(isControlledRequiredPath("required.basedIn.city"), false);
    assert.equal(isControlledRequiredPath("required.serviceArea.region"), false);
  });

  test("returns false for non-controlled paths", () => {
    assert.equal(isControlledRequiredPath("query"), false);
    assert.equal(isControlledRequiredPath("preferred.categoryKeys"), false);
    assert.equal(isControlledRequiredPath("preferred.specialties.0"), false);
    assert.equal(isControlledRequiredPath(""), false);
  });
});

describe("partitionFieldErrors", () => {
  test("partitions a representative set into controlled + unmatched with no overlap or loss", () => {
    const errors: ApiFieldErrorV1[] = [
      errorAt("required.primaryCategoryKeys"),
      errorAt("required.independentlyPurchasableServiceKeys"),
      errorAt("required.serviceModes"),
      errorAt("required.basedIn.countryCode"),
      errorAt("required.serviceArea.countryCode"),
      errorAt("required"),
      errorAt("query"),
      errorAt("preferred.categoryKeys"),
      errorAt("preferred.specialties.0"),
    ];
    const { controlled, unmatched } = partitionFieldErrors(errors);

    assert.equal(controlled.length, 6, "every controlled required error is captured by the panel");
    assert.equal(unmatched.length, 3, "every other error is unmatched");

    // No error appears in both buckets.
    const controlledPaths = new Set(controlled.map((e) => e.path));
    const unmatchedPaths = new Set(unmatched.map((e) => e.path));
    for (const path of controlledPaths) {
      assert.equal(unmatchedPaths.has(path), false, `${path} must not appear in both buckets`);
    }

    // Every controlled path is owned by exactly one predicate.
    for (const path of controlledPaths) {
      assert.equal(isControlledRequiredPath(path), true);
    }
    for (const path of unmatchedPaths) {
      assert.equal(isControlledRequiredPath(path), false);
    }
  });

  test("unconsumed required.* paths fall through to the global panel", () => {
    // Regression for the P1-002 finding: an error at a `required.*` path
    // that has no rendered control MUST land in `unmatched` so the global
    // panel can show it. The predicate cannot claim it just because it
    // shares the `required` prefix.
    const errors: ApiFieldErrorV1[] = [
      errorAt("required.futureField"),
      errorAt("required.basedIn.city"),
    ];
    const { controlled, unmatched } = partitionFieldErrors(errors);
    assert.equal(controlled.length, 0, "no rendered control claims these paths");
    assert.equal(unmatched.length, 2, "global panel renders both");
  });

  test("empty input produces empty partitions", () => {
    const { controlled, unmatched } = partitionFieldErrors<ApiFieldErrorV1>([]);
    assert.deepEqual(controlled, []);
    assert.deepEqual(unmatched, []);
  });
});
