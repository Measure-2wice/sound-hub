// Regression coverage for Ralph milestone smoke A marker.
// Proves that the deterministic marker value is wired correctly.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RALPH_MILESTONE_SMOKE_A } from "./ralph-milestone-smoke-a.mjs";

describe("RALPH_MILESTONE_SMOKE_A", () => {
  test("equals exactly ralph-milestone-a-ok", () => {
    assert.equal(RALPH_MILESTONE_SMOKE_A, "ralph-milestone-a-ok");
  });
});
