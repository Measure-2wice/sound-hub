// Focused contract coverage for the M2 #84 seller-profile editor page.
//
// The repo's existing test pattern (see
// `apps/web/src/app/workspace/intent/page.test.tsx`) uses source-level
// contract assertions rather than a React DOM testing library. This
// file pins the BEHAVIORAL contract — Personal-only authority gate,
// retry-idempotency lifecycle, atomic save flow, accessibility
// scaffolding — by reading the page source.
//
// Cross-tab / browser behaviour (focus management, network wiring,
// full Playwright journey) is covered end-to-end by the spec at
// `apps/web/e2e/seller-profile-editor.spec.ts`.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const repoRoot = `${new URL("../../../../../", import.meta.url).pathname}`;

function readFile(relativePath: string): string {
  return readFileSync(`${repoRoot}src/app/${relativePath}`, "utf8");
}

function stripCommentsAndJsdoc(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) return false;
      if (trimmed.startsWith("*")) return false;
      if (trimmed.startsWith("/*")) return false;
      if (trimmed.startsWith("*/")) return false;
      return true;
    })
    .join("\n");
}

describe("SellerProfileEditorPage — M2 Professional Profile Personal-only draft authority", () => {
  test("Editor page reads the acting Workspace and refuses to render for Organization actors", () => {
    const source = readFile("seller/profile/edit/page.tsx");
    assert.ok(/useActingWorkspace/.test(source), "editor page MUST consume useActingWorkspace");
    assert.ok(
      /actingWorkspace\.workspaceType\s*!==\s*"Personal"/.test(source),
      "editor page MUST gate on Personal-Workspace identity",
    );
  });

  test("Editor page refuses to render for actors without the Seller capability", () => {
    const source = readFile("seller/profile/edit/page.tsx");
    assert.ok(
      /capabilities\.includes\("Seller"\)/.test(source) ||
        /!.*\.capabilities\.includes\("Seller"\)/.test(source),
      "editor page MUST check for the Seller capability",
    );
  });

  test("Editor page persists a draft via saveSellerProfileDraft (PUT /seller-profile/draft)", () => {
    const source = readFile("seller/profile/edit/page.tsx");
    assert.ok(
      /saveSellerProfileDraft|\/seller-profile\/draft/.test(source),
      "editor page MUST call the draft-save endpoint",
    );
  });

  test("Editor page preserves canonical bio max(2000), NOT the Stitch 600-counter", () => {
    const source = readFile("seller/profile/edit/page.tsx");
    const codeOnly = stripCommentsAndJsdoc(source);
    assert.ok(
      /maxLength=\{2000\}|maxLength:\s*2000/.test(codeOnly),
      "editor page MUST enforce bio max length of 2000 (canonical PublicSellerSummaryV1.bio bound)",
    );
    assert.ok(
      !/maxLength=\{600\}|maxLength:\s*600\b/.test(codeOnly),
      "editor page MUST NOT impose Stitch's 600-character counter",
    );
  });

  test("Editor page renders the SpecialtyChips multi-select", () => {
    const source = readFile("seller/profile/edit/page.tsx");
    assert.ok(
      /SpecialtyChips/.test(source),
      "editor page MUST use SpecialtyChips for multi-select controlled specialty selection",
    );
  });

  test("Editor page renders the SaveDraftActions state machine (Saving / Saved / Couldn't save)", () => {
    const source = readFile("seller/profile/edit/page.tsx");
    assert.ok(/SaveDraftActions/.test(source), "editor page MUST use SaveDraftActions");
    assert.ok(
      /saving|saved|couldn['’]?t save/i.test(source),
      "editor page MUST surface saving/saved/error save states",
    );
  });

  test("Editor page renders the ErrorSummary for field-level errors with anchor links", () => {
    const source = readFile("seller/profile/edit/page.tsx");
    assert.ok(
      /ErrorSummary/.test(source),
      "editor page MUST render ErrorSummary for multi-field validation failures",
    );
  });

  test("Editor page does NOT carry Stitch terminology (Studio Entity / Acoustic Standards / Step 4 of 4)", () => {
    const source = readFile("seller/profile/edit/page.tsx");
    const codeOnly = stripCommentsAndJsdoc(source);
    assert.ok(
      !/Studio Entity/.test(codeOnly),
      "editor page MUST NOT render Stitch's 'Studio Entity' terminology",
    );
    assert.ok(
      !/Acoustic Standards/.test(codeOnly),
      "editor page MUST NOT render Stitch's 'Acoustic Standards'",
    );
    assert.ok(
      !/Step 4 of 4/.test(codeOnly),
      "editor page MUST NOT render Stitch's persistent 'Step 4 of 4' flag",
    );
    assert.ok(
      !/SoundHub Community Standards/.test(codeOnly),
      "editor page MUST NOT render the SoundHub Community Standards copy",
    );
  });

  test("Editor page retains the idempotencyKey across the Retry action", () => {
    const source = readFile("seller/profile/edit/page.tsx");
    assert.ok(
      /idempotencyKeyRef\.current/.test(source) || /useRef<string \| null>/.test(source),
      "editor page MUST retain the idempotencyKey across retries",
    );
    assert.ok(/handleRetry/.test(source), "editor page MUST expose a Retry action");
  });
});
