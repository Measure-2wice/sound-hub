/* eslint-disable @typescript-eslint/no-floating-promises */
// `assert.equal(...)` returns `void` in @types/node but the project's
// flat config treats it as a floating promise; this file's assertions
// are pure synchronous comparisons and need the suppression above.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

// Unit tests for the `isRetriableErrorCode` predicate.
//
// The predicate owns the buyer-facing decision of whether a given
// safe-envelope error code warrants a retry affordance. The page
// reads this exact function to render (or skip) the retry button;
// a refactor that adds or removes a code MUST update both this
// test and the page so the contract stays locked.
//
// The contract pins:
//   - 503 SEARCH_UNAVAILABLE → retriable (transient infra failure)
//   - 500 SEARCH_FAILED → retriable (recoverable on resubmission)
//   - 400 INVALID_SEARCH_CRITERIA / INVALID_JSON → NOT retriable
//     (the buyer's input must change before another submission
//     makes sense; the field-level error UI already guides them)
//   - 415 UNSUPPORTED_MEDIA_TYPE → NOT retriable (the request
//     format must change)
//   - 429 SEARCH_RATE_LIMITED → NOT retriable (the buyer must wait;
//     a retry would re-trigger the limit)
//   - null / unknown / empty → NOT retriable

import { isRetriableErrorCode } from "./useSearch";

describe("isRetriableErrorCode", () => {
  test("returns true for SEARCH_UNAVAILABLE", () => {
    assert.equal(isRetriableErrorCode("SEARCH_UNAVAILABLE"), true);
  });

  test("returns true for SEARCH_FAILED", () => {
    assert.equal(isRetriableErrorCode("SEARCH_FAILED"), true);
  });

  test("returns false for INVALID_SEARCH_CRITERIA", () => {
    assert.equal(isRetriableErrorCode("INVALID_SEARCH_CRITERIA"), false);
  });

  test("returns false for INVALID_JSON", () => {
    assert.equal(isRetriableErrorCode("INVALID_JSON"), false);
  });

  test("returns false for UNSUPPORTED_MEDIA_TYPE", () => {
    assert.equal(isRetriableErrorCode("UNSUPPORTED_MEDIA_TYPE"), false);
  });

  test("returns false for SEARCH_RATE_LIMITED", () => {
    assert.equal(isRetriableErrorCode("SEARCH_RATE_LIMITED"), false);
  });

  test("returns false for null", () => {
    assert.equal(isRetriableErrorCode(null), false);
  });

  test("returns false for an unknown code", () => {
    assert.equal(isRetriableErrorCode("SOMETHING_NEW"), false);
  });
});
