/* eslint-disable @typescript-eslint/no-floating-promises */
// Dashboard audio-samples panel — final-sample confirmation flow contract.
//
// M2 (#86, slice 86F Tenki PR feedback round 3): the panel must
//   1. omit `confirmEligibilityLoss` on the first attempt so the
//      server's authoritative rejection envelope drives the dialog
//      presentation (not the browser's local state),
//   2. include `performRemove` in `handleRemove`'s dependency
//      array so that switching ServiceOfferings re-resolves the
//      closure (otherwise the previous offering's endpoint
//      receives the next DELETE — silent regression),
//   3. NOT consume an `offeringStatus` prop (the server is the
//      single source of truth for "is this the final sample?";
//      pre-classifying in the browser races the server),
//   4. declare `performRemove` BEFORE `handleRemove` (so the
//      dependency is in scope at the point of useCallback).
//
// These are source-regex assertions because the regression is a
// closure / declaration-order invariant that is not observable
// through a single React render. The behavioral switching-offerings
// + final-sample case has no Playwright coverage today; this file
// pins the structural contract that prevents the regression from
// recurring while behavioral coverage is tracked as follow-up. The
// existing service tests at `apps/api/src/services/audio-sample.service.test.ts`
// pin the server-side rejection envelope.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readPanelSource(): string {
  return readFileSync(`${repoRoot}/src/app/dashboard/audio-samples-panel.tsx`, "utf8");
}

describe("dashboard audio-samples panel — slice 86F Tenki PR feedback round 3", () => {
  test("handleRemove depends on performRemove (switching-offerings invariant)", () => {
    const source = readPanelSource();
    // Find the handleRemove useCallback block. The block must
    // list `performRemove` in its dependency array — otherwise
    // switching offerings silently sends the DELETE to the
    // previous offering's endpoint. Capture the block from the
    // `const handleRemove = useCallback(` anchor up to the next
    // semicolon-terminated `)` that closes the useCallback, then
    // extract the deps array from the closing tail.
    const handleStart = source.indexOf("const handleRemove = useCallback(");
    assert.ok(
      handleStart > -1,
      "could not locate `const handleRemove = useCallback(` declaration; structural pin lost",
    );
    const handleTail = source.slice(handleStart);
    // The deps array sits inside the last `[..., ...]` literal
    // before the closing `);` of the useCallback.
    const depsMatch = handleTail.match(/,\s*\[\s*([^\]]+?)\s*\]\s*\)\s*;/);
    assert.ok(
      depsMatch,
      "could not locate handleRemove's useCallback dependency array tail; structural pin lost",
    );
    const deps = (depsMatch[1] ?? "").trim();
    assert.ok(
      /\bperformRemove\b/.test(deps),
      `handleRemove's dependency array must include performRemove so the closure re-binds when the seller switches offerings — got [${deps}]`,
    );
  });

  test("performRemove is declared BEFORE handleRemove (so handleRemove's deps are in scope)", () => {
    const source = readPanelSource();
    const performRemoveIndex = source.indexOf("const performRemove = useCallback(");
    const handleRemoveIndex = source.indexOf("const handleRemove = useCallback(");
    assert.ok(
      performRemoveIndex > -1 && handleRemoveIndex > -1,
      "could not locate performRemove / handleRemove declarations",
    );
    assert.ok(
      performRemoveIndex < handleRemoveIndex,
      `performRemove must be declared before handleRemove so handleRemove's useCallback deps are in scope — performRemove at ${performRemoveIndex}, handleRemove at ${handleRemoveIndex}`,
    );
  });

  test("the panel does NOT consume an `offeringStatus` prop (server is the source of truth)", () => {
    const source = readPanelSource();
    // The interface MUST NOT carry an `offeringStatus` prop. If a
    // future maintainer adds one, the panel would re-classify
    // removals from browser state — racing the server's
    // authoritative `AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED`
    // rejection envelope.
    assert.equal(
      /readonly offeringStatus/.test(source),
      false,
      "the panel must NOT consume an offeringStatus prop — the server is the single source of truth",
    );
    assert.equal(
      /offeringStatus=\{/.test(source),
      false,
      "the panel must NOT be passed an offeringStatus prop from the page — the server is the single source of truth",
    );
  });

  test("the first attempt omits confirmEligibilityLoss so the server's rejection envelope opens the dialog", () => {
    const source = readPanelSource();
    // handleRemove → performRemove(..., { confirmEligibilityLoss: false }).
    // The dialog is opened ONLY when the server returns
    // AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED — not on
    // pre-classified browser state.
    assert.ok(
      /handleRemove[\s\S]*?performRemove\(\s*sample,\s*\{\s*confirmEligibilityLoss:\s*false\s*\}/.test(
        source,
      ),
      "handleRemove's first attempt must call performRemove with confirmEligibilityLoss:false",
    );
    assert.ok(
      /AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED/.test(source),
      "the panel must react to the server's authoritative rejection envelope",
    );
  });
});
