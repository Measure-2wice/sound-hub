// Codex CHANGES_REQUESTED P1-005: focused contract coverage for the
// M2 #83 intent page. The repo's existing test pattern uses source-
// level contract assertions (readFileSync + regex) rather than a
// React DOM testing library; this test file pins the BEHAVIORAL
// contract — verbatim UI rendering, capability-only intent CTA,
// server-resolved safe navigation — by reading the page source.
//
// Cross-tab / browser behaviour (arrow keys, focus management,
// network wiring) is covered end-to-end by the Playwright spec
// at apps/web/e2e/intent-and-workspace-switch.spec.ts.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}`;

function readFile(relativePath: string): string {
  return readFileSync(`${repoRoot}src/app/${relativePath}`, "utf8");
}

describe("IntentPage — M2 #83 capability-only contract (#83 re-revision)", () => {
  test("Intent page does NOT fetch a Seller participation terms helper", () => {
    // #83 re-revision: the M2 #83 slice does NOT collect a generic
    // Seller participation/terms acceptance at capability-
    // provisioning time. The page therefore has no
    // fetchSellerParticipationTerms call. Check the CODE only —
    // the file documents the #83 re-revision in comments.
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      !/fetchSellerParticipationTerms/.test(source),
      "intent page MUST NOT call fetchSellerParticipationTerms",
    );
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*/"))
      .join("\n");
    assert.ok(
      !/Seller participation terms|seller.participation/i.test(codeOnly),
      "intent page code MUST NOT render Seller participation acceptance copy",
    );
  });

  test("Intent page submits only the intent value (no sellerAcceptance payload)", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /const intentBody:\s*IntentRequestV1\s*=\s*\{\s*intent\s*\}/.test(source),
      "page MUST submit an IntentRequestV1 carrying only `intent`",
    );
    // Check the CODE (strip JSDoc/comment lines) for sellerAcceptance;
    // the file documents the #83 re-revision decision in comments, but
    // the implementation must not contain the field.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*/"))
      .join("\n");
    assert.ok(
      !/sellerAcceptance/.test(codeOnly),
      "intent page MUST NOT construct a sellerAcceptance payload",
    );
  });

  test("Submit is disabled only until intent is chosen", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /submitDisabled\s*=\s*intent\s*===\s*null\s*\|\|\s*submitting/.test(source),
      "submitDisabled MUST be `intent === null || submitting`",
    );
    assert.ok(
      !/termsAccepted|sellerAcceptanceRequired|sellerBlocked/.test(source),
      "intent page MUST NOT introduce Seller-terms / acceptance gating",
    );
  });

  test("Intent page does NOT invent production legal copy — no Seller terms text", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The page MUST NOT contain any hardcoded Seller legal
    // copy in CODE. #83 re-revision lifts this boundary entirely.
    // The file documents the #83 re-revision decision in comments
    // (which is fine); only code lines are checked.
    const codeLines = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*/"));
    for (const trimmed of codeLines) {
      if (/\b(shall|hereby|terms of service)\b/i.test(trimmed)) {
        assert.fail(`intent page MUST NOT invent production legal copy; found line: ${trimmed}`);
      }
    }
  });

  test("POST success navigates via navigateAfterIntent (server-resolved safeReturnTo only)", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(/import\s*\{\s*navigateAfterIntent/.test(source));
    assert.ok(
      /navigateAfterIntent\(\s*\{\s*router\s*,\s*response\s*\}\s*\)/.test(source),
      "page MUST navigate via the navigateAfterIntent seam with the response",
    );
  });
});

describe("navigateAfterIntent — server-resolved safeReturnTo seam (§5 / P1-005)", () => {
  test("helper consumes only `safeReturnTo` from the response (no client-side validator)", () => {
    const source = readFile("lib/navigate-after-intent.ts");
    assert.ok(/input\.response\.safeReturnTo/.test(source));
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    assert.ok(
      !/response\.user/.test(codeOnly),
      "seam code MUST NOT inspect response.user (server is the resolver authority)",
    );
    assert.ok(
      !/window\.location|location\.search|URLSearchParams/.test(codeOnly),
      "seam code MUST NOT read raw location / URL parameters",
    );
  });

  test("helper defaults to /dashboard when safeReturnTo is null", () => {
    const source = readFile("lib/navigate-after-intent.ts");
    assert.ok(/safeReturnTo\s*\?\?\s*"\/dashboard"/.test(source));
  });
});

describe("ActingWorkspaceSelector — #83 context model (§4 / P1-005)", () => {
  test("handleSelect does NOT write localStorage (it only calls setPendingTarget)", () => {
    const source = readFile("components/ActingWorkspaceSelector.tsx");
    const handleSelectMatch = source.match(/(?:const|function)\s+handleSelect\b[\s\S]*?\n {2}\};?/);
    assert.ok(handleSelectMatch, "handleSelect must exist");
    const handleBody = String(handleSelectMatch)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    assert.ok(
      /setPendingTarget\(targetId\)/.test(handleBody),
      "handleSelect MUST call setPendingTarget (no localStorage write on select)",
    );
    assert.ok(
      !/localStorage|writeRemembered/.test(handleBody),
      "handleSelect code MUST NOT write localStorage before explicit confirmation",
    );
    assert.ok(
      /\/workspace\/switch\?target=/.test(handleBody),
      "handleSelect MUST navigate to the switch interstitial",
    );
  });
});

describe("Switch interstitial — commit / cancel behaviour (§4 / P1-005)", () => {
  test("Switch page calls commitPendingTarget on Switch and continue", () => {
    const source = readFile("workspace/switch/page.tsx");
    assert.ok(/commitPendingTarget\(\)/.test(source));
  });

  test("Switch page calls cancelPendingTarget on Cancel (commit state untouched)", () => {
    const source = readFile("workspace/switch/page.tsx");
    assert.ok(/cancelPendingTarget\(\)/.test(source));
  });

  test("Switch page promotes a query-target to pending on mount (P1-002 deep-link / hard reload)", () => {
    const source = readFile("workspace/switch/page.tsx");
    assert.ok(/useSearchParams\(\)/.test(source), "page reads query string via useSearchParams");
    assert.ok(
      /setPendingTarget\(\s*candidate\.workspaceId\s*\)/.test(source) ||
        /setPendingTarget\(candidate\.workspaceId\)/.test(source),
      "page promotes membership-validated query target into pending state",
    );
    assert.ok(
      /workspaceStatus.*Active/.test(source) || /status === "Active"/.test(source),
      "page only promotes ACTIVE Workspaces",
    );
  });
});

describe("Dashboard — capability-truthful copy (§4 / P1-005 / P1-004)", () => {
  test('Dashboard renders "View your deals" only when Buyer capability is present', () => {
    const source = readFile("dashboard/page.tsx");
    assert.ok(
      /actingWorkspace\.capabilities\.includes\("Buyer"\)[\s\S]*?\/\s*deals/.test(source),
      "View your deals MUST only render for Buyer-acting Workspaces",
    );
  });

  test("Dashboard Seller-readiness copy does NOT expose internal ticket numbers (#84, #85)", () => {
    const source = readFile("dashboard/page.tsx");
    assert.ok(
      !/(#84|#85)/.test(source),
      "dashboard copy MUST NOT expose internal ticket numbers to customers (Codex P1-004)",
    );
    assert.ok(
      /Selling your services|Manage your services|ServiceOffering|services are set up/i.test(
        source,
      ),
      "dashboard Seller copy MUST remain capability-aware and customer-safe",
    );
  });

  test("Dashboard never renders Choose-intent CTA when actor is Organization", () => {
    const source = readFile("dashboard/page.tsx");
    assert.ok(
      /actingWorkspace\.workspaceType\s*!==\s*"Personal"/.test(source),
      "Choose intent CTA / auto-redirect MUST only fire when actor is Personal",
    );
  });
});

describe("Shell — capability-truthful destinations (§4 / P1-005 / P1-004)", () => {
  test("Shell reads actingWorkspace from useActingWorkspace (NOT user.workspaces[0])", () => {
    const source = readFile("components/Shell.tsx");
    assert.ok(
      /useActingWorkspace\(\)/.test(source) && /actingWorkspace/.test(source),
      "Shell MUST derive destinations from the acting-Workspace provider",
    );
    assert.ok(
      !/user\.workspaces\[0\]/.test(source),
      "Shell MUST NOT pick the first workspace from user.workspaces array",
    );
  });
});
