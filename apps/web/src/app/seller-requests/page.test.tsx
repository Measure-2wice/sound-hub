/* eslint-disable @typescript-eslint/no-floating-promises */
// Seller inbox page source-contract tests.
//
// Background: ticket #62 requires the seller-side inbox that lists
// Pending ProjectRequests and exposes Accept / Decline actions. These
// tests pin the page's authoritative code paths so a refactor cannot
// silently disconnect the seller journey from the BG4 API.
//
// The tests are source-pattern tests: they read the page source and
// assert the wiring (data-testid attributes, session-aware gating,
// capability filter, response shape) without booting React. The
// runtime contract for the Accept / Decline actions is covered by the
// project-requests-client.ts shared module which the page delegates
// to; the route contract is covered by apps/api/src/routes/
// project-requests.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readSellerRequestsPage(): string {
  return readFileSync(`${repoRoot}/src/app/seller-requests/page.tsx`, "utf8");
}

describe("BG4 Seller inbox page source contract", () => {
  test("seller inbox renders the page shell with stable data-testids", () => {
    const source = readSellerRequestsPage();
    for (const testid of [
      "seller-requests-page",
      "seller-requests-header",
      "seller-requests-list-card",
      "seller-requests-empty",
      "seller-requests-loading-list",
      "seller-requests-error",
      "seller-requests-success",
    ]) {
      assert.match(
        source,
        new RegExp(`data-testid="${testid}"`),
        `seller inbox page must render ${testid}`,
      );
    }
  });

  test("seller inbox filters workspaces by Seller capability", () => {
    const source = readSellerRequestsPage();
    assert.match(
      source,
      /capabilities\.includes\("Seller"\)/,
      "seller inbox must filter acting workspaces by Seller capability",
    );
  });

  test("seller inbox exposes Accept and Decline actions per row", () => {
    const source = readSellerRequestsPage();
    assert.match(
      source,
      /data-testid="seller-request-accept"/,
      "seller inbox must render the Accept button",
    );
    assert.match(
      source,
      /data-testid="seller-request-decline"/,
      "seller inbox must render the Decline button",
    );
    assert.match(
      source,
      /statusFilter: "Pending"/,
      "seller inbox must scope its listing to Pending requests",
    );
  });

  test("seller inbox delegates to the project-requests client module", () => {
    const source = readSellerRequestsPage();
    assert.match(
      source,
      /from\s+"\.\.\/lib\/project-requests-client"/,
      "seller inbox must import the shared client module",
    );
    assert.match(
      source,
      /\bacceptProjectRequest\s*\(/,
      "seller inbox must call acceptProjectRequest on Accept",
    );
    assert.match(
      source,
      /\bdeclineProjectRequest\s*\(/,
      "seller inbox must call declineProjectRequest on Decline",
    );
  });

  test("seller inbox refreshes the BG1 SessionProvider on session-invalid responses", () => {
    const source = readSellerRequestsPage();
    assert.match(
      source,
      /onSessionInvalid/,
      "seller inbox must wire the onSessionInvalid callback for the SessionProvider refresh",
    );
    assert.match(
      source,
      /SESSION_INVALID/,
      "seller inbox must detect the SESSION_INVALID code from the safe envelope",
    );
  });
});
