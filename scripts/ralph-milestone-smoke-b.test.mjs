// Regression coverage for Ralph milestone smoke B marker.
// Proves that the deterministic marker value is wired correctly.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RALPH_MILESTONE_SMOKE_B } from "./ralph-milestone-smoke-b.mjs";

describe("RALPH_MILESTONE_SMOKE_B", () => {
  test("equals exactly ralph-milestone-b-ok", () => {
    assert.equal(RALPH_MILESTONE_SMOKE_B, "ralph-milestone-b-ok");
  });
});
