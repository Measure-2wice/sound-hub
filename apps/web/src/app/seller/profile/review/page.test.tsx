// Focused contract coverage for the M2 Professional Profile review page.
//
// The repo's existing test pattern uses source-level contract
// assertions rather than a React DOM testing library. This file
// pins the BEHAVIORAL contract — read-only preview, confirmation-
// gated Publish, retry-idempotency lifecycle, truthful post-
// publication success state — by reading the page source.
//
// Cross-tab / browser behaviour is covered end-to-end by the spec at
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

describe("SellerProfileReviewPage — M2 Professional Profile publish confirmation + truthful success state", () => {
  test("Review page reads the acting Workspace and refuses to render for Organization actors", () => {
    const source = readFile("seller/profile/review/page.tsx");
    assert.ok(/useActingWorkspace/.test(source), "review page MUST consume useActingWorkspace");
    assert.ok(
      /actingWorkspace\.workspaceType\s*!==\s*"Personal"/.test(source),
      "review page MUST gate on Personal-Workspace identity",
    );
    assert.ok(
      /capabilities\.includes\("Seller"\)/.test(source),
      "review page MUST require the Seller capability",
    );
  });

  test("Review page requires explicit confirmation checkbox before Publish is enabled", () => {
    const source = readFile("seller/profile/review/page.tsx");
    assert.ok(/type="checkbox"/.test(source), "review page MUST render a confirmation checkbox");
    assert.ok(
      /disabled=\{!confirmed/.test(source),
      "Publish button MUST be disabled until the confirmation checkbox is checked",
    );
  });

  test("Review page binds the publish call to a confirmationVersion + idempotencyKey", () => {
    const source = readFile("seller/profile/review/page.tsx");
    assert.ok(
      /CONFIRMATION_VERSION/.test(source) || /m2-profile-publication-v1/.test(source),
      "review page MUST carry the canonical confirmation version",
    );
    assert.ok(/idempotencyKey/.test(source), "review page MUST carry an idempotencyKey");
    assert.ok(
      /generateSellerProfileIdempotencyKey|crypto\.randomUUID/.test(source),
      "review page MUST generate the idempotencyKey when a new publication attempt begins",
    );
  });

  test("Review page retains the idempotencyKey across the Retry action (NOT regenerated)", () => {
    const source = readFile("seller/profile/review/page.tsx");
    assert.ok(
      /idempotencyKeyRef\.current/.test(source) || /useRef<string \| null>/.test(source),
      "review page MUST retain the idempotencyKey across retries",
    );
    assert.ok(/handleRetry/.test(source), "review page MUST expose a Retry action");
  });

  test("Review page renders the truthful post-publication success state", () => {
    const source = readFile("seller/profile/review/page.tsx");
    const codeOnly = stripCommentsAndJsdoc(source);
    assert.ok(
      /No ServiceOffering was created/.test(codeOnly) ||
        /no ServiceOffering was created/i.test(codeOnly),
      "review page MUST tell the user no ServiceOffering was created",
    );
    assert.ok(
      /Your services are not yet available to buyers/.test(codeOnly) ||
        /not yet available to buyers/i.test(codeOnly),
      "review page MUST tell the user services are not yet available to buyers",
    );
    assert.ok(
      /Create your first service|create.*first.*service/i.test(codeOnly),
      "review page MUST point at the next step: create the first service",
    );
  });

  test("Review page does NOT carry Stitch terminology", () => {
    const source = readFile("seller/profile/review/page.tsx");
    const codeOnly = stripCommentsAndJsdoc(source);
    assert.ok(!/Studio Entity/.test(codeOnly));
    assert.ok(!/Acoustic Standards/.test(codeOnly));
    assert.ok(!/Step 4 of 4/.test(codeOnly));
    assert.ok(!/SoundHub Community Standards/.test(codeOnly));
    assert.ok(!/Editorial Dossier/.test(codeOnly));
    assert.ok(!/Acoustic Studio Registry/.test(codeOnly));
  });

  test("Review page renders a published-time stamp and a Continue CTA", () => {
    const source = readFile("seller/profile/review/page.tsx");
    assert.ok(/publishedAt/.test(source), "review page MUST surface the publishedAt timestamp");
    assert.ok(
      /Continue/.test(source),
      "review page MUST expose a Continue CTA on the success surface",
    );
  });
});
