// Focused contract coverage for the M2 #83 intent page. The repo's
// existing test pattern uses source-level contract assertions
// (readFileSync + regex) rather than a React DOM testing library;
// this test file pins the BEHAVIORAL contract — verbatim UI
// rendering, capability-only intent CTA, server-resolved safe
// navigation — by reading the page source.
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

  test("Intent page submits only `intent` (with optional `returnTo` for the validated-return flow; no sellerAcceptance payload)", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The body MAY carry `returnTo` when the URL supplies a
    // validated `?return=`. The schema is `.strict()`; the page
    // never constructs `null` / junk / `sellerAcceptance`.
    assert.ok(
      /const intentBody:\s*IntentRequestV1\s*=/.test(source),
      "page MUST submit an IntentRequestV1 typed payload",
    );
    assert.ok(
      /\{\s*intent,\s*returnTo:\s*validatedReturnTo\s*\}/.test(source),
      "page MUST submit `{ intent, returnTo: validatedReturnTo }` when return is validated",
    );
    assert.ok(
      /\{\s*intent\s*\}/.test(source),
      "page MUST submit `{ intent }` when no return is validated",
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

  test("Intent page reads + validates `?return=` from the URL", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(/useSearchParams\(\)/.test(source), "page reads the query string");
    assert.ok(/validatedReturnTo/.test(source), "page derives `validatedReturnTo` from the URL");
    assert.ok(
      /isLocallyValidReturnPath/.test(source),
      "page uses the local same-origin path validator",
    );
  });

  test("Switch link threads `?return=` through (cross-Workspace continuation)", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /\/workspace\/switch\?target=/.test(source),
      "switch link includes the `target` parameter",
    );
    assert.ok(
      /validatedReturnTo\s*\?\s*`&return=/.test(source),
      "switch link carries the validated `?return=` forward",
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

  // Validated return threading. The switch interstitial reads
  // `?return=` from the URL and threads it through both the
  // commit (Switch and continue) and the cancel paths so the
  // customer's pending destination is reachable even when the
  // explicit-switch step is the only thing they bypassed.
  test("Switch page reads + validates `?return=` and threads it through commit + cancel", () => {
    const source = readFile("workspace/switch/page.tsx");
    assert.ok(/queryReturnTo/.test(source), "switch page derives `queryReturnTo` from the URL");
    assert.ok(
      /isLocallyValidReturnPath/.test(source),
      "switch page uses the local same-origin path validator",
    );
    assert.ok(
      /queryReturnTo\s*\?\?\s*"\/dashboard"/.test(source),
      "switch page defaults to /dashboard when no `?return=` is supplied",
    );
  });
});

describe("Dashboard — capability-truthful copy (§4 / P1-005 / P1-004)", () => {
  // Deals is a Deal-party destination, not a Buyer-only one.
  // Sellers are also Deal parties; the action is available when
  // EITHER capability is present.
  test('Dashboard renders "View your deals" when Buyer OR Seller capability is present', () => {
    const source = readFile("dashboard/page.tsx");
    // The "View your deals" link MUST be inside an `||` guard that
    // matches either capability.
    assert.ok(
      /capabilities\.includes\("Buyer"\)\s*\|\|\s*actingWorkspace\.capabilities\.includes\("Seller"\)/.test(
        source,
      ),
      "View your deals MUST render for Buyer OR Seller acting Workspaces",
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

  // The previous "Profile and service setup unlocks after your
  // first deal" copy reversed the documented M2 journey. The
  // new copy must reflect the forward progression (publish
  // profile + activate service → receive requests). Strip
  // comment lines so the test only asserts on rendered copy.
  test("Dashboard Seller-readiness copy reflects forward journey (no reversed first-deal wording)", () => {
    const source = readFile("dashboard/page.tsx");
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*/"))
      .join("\n");
    assert.ok(
      !/unlocks after your first deal/i.test(codeOnly),
      "dashboard MUST NOT contain the reversed 'unlocks after your first deal' copy",
    );
    assert.ok(
      /Publish your professional profile|Publish|private drafts/i.test(codeOnly),
      "dashboard Seller readiness copy MUST reflect the forward journey",
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

  // The Shell exposes the Deals destination for Buyer OR
  // Seller capability. Sellers are also Deal parties.
  test("Shell exposes Deals destination for Buyer OR Seller capability", () => {
    const source = readFile("components/Shell.tsx");
    assert.ok(
      /capabilities\.includes\("Buyer"\)\s*\|\|\s*capabilities\.includes\("Seller"\)/.test(source),
      "Shell MUST expose Deals when Buyer OR Seller capability is present",
    );
  });
});
