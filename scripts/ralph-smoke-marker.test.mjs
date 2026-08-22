// Regression coverage for `scripts/ralph-smoke-marker.mjs`.
//
// Verifies that the smoke marker constant is exported and has the
// exact value expected by the Ralph autonomous lifecycle.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RALPH_SMOKE_MARKER } from "./ralph-smoke-marker.mjs";

describe("RALPH_SMOKE_MARKER", () => {
  test("equals exactly 'ralph-smoke-ok'", () => {
    assert.equal(RALPH_SMOKE_MARKER, "ralph-smoke-ok");
  });
});
