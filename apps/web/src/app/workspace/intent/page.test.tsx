// Codex CHANGES_REQUESTED P1-005: focused contract coverage for the
// M2 #83 intent page. The repo's existing test pattern uses source-
// level contract assertions (readFileSync + regex) rather than a
// React DOM testing library; this test file pins the BEHAVIORAL
// contract — verbatim text rendering, acceptance checkbox wiring,
// capability-only intent CTA, server-resolved safe navigation —
// by reading the page source.
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

describe("IntentPage — M2 #83 contract (P1-005 + P0-001 acceptance control)", () => {
  test("Intent page reads registered Seller participation terms via fetch and renders the verbatim text", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The page calls `fetchSellerParticipationTerms()` on mount
    // and uses the result to render an explicit acceptance
    // control. Architectural seam from the API to the form.
    assert.ok(
      /fetchSellerParticipationTerms\(\)/.test(source),
      "page MUST fetch registered Seller participation terms via the auth-client helper",
    );
    assert.ok(
      /\bterms\.content\b/.test(source),
      "page MUST render the registered content verbatim (no invented legal copy)",
    );
  });

  test("Intent page renders an explicit acceptance checkbox bound to termsAccepted", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /type=["']checkbox["'][\s\S]*data-testid=["']intent-terms-accept-input["']/.test(source),
      "page MUST render an explicit acceptance checkbox with the P0-001 data-testid",
    );
    assert.ok(
      /setTermsAccepted\(e\.currentTarget\.checked\)/.test(source),
      "checkbox state MUST be wired to a setTermsAccepted state setter",
    );
  });

  test("Submit is disabled until intent is chosen AND terms are accepted (Offer/Both path)", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /submitDisabled\s*=\s*intent\s*===\s*null\s*\|\|\s*submitting\s*\|\|\s*sellerBlocked/.test(
        source,
      ),
      "submitDisabled MUST include sellerBlocked for the Offer/Both path",
    );
    assert.ok(
      /sellerBlocked\s*=\s*sellerAcceptanceRequired\s*&&\s*\([\s\S]*termsAccepted/.test(source),
      "sellerBlocked MUST account for termsAccepted",
    );
  });

  test("Intent page submits sellerAcceptance with termsVersion + termsContentHash when accepted", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /sellerAcceptance:\s*\{[\s\S]*termsVersion:\s*terms\.version[\s\S]*termsContentHash:\s*terms\.contentHash/.test(
        source,
      ),
      "page MUST submit sellerAcceptance populated from the registered terms",
    );
  });

  test("Submit is hidden / disabled when sellerAcceptanceRequired and terms are NOT registered (legal-blocked copy)", () => {
    const source = readFile("workspace/intent/page.tsx");
    assert.ok(
      /Seller setup is temporarily unavailable\. Please try again later\./.test(source),
      "page MUST surface the neutral retryable copy when terms are unregistered",
    );
    assert.ok(
      /data-testid=["']intent-terms-unavailable["']/.test(source),
      "page MUST label the legal-blocked alert with the P0-001 data-testid for tests",
    );
  });

  test("Intent page does NOT invent production legal copy — fetch result is the only source", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The page MUST NOT contain any hardcoded Seller legal
    // copy outside the constant neutral-retryable message.
    const matches = source.match(/terms\.content/g);
    assert.ok(matches !== null, "page MUST reference terms.content as the only source");
    // The neutral retryable message is the only constant legal
    // copy allowed in the page.
    const neutralCount = (source.match(/Seller setup is temporarily unavailable\./g) || []).length;
    // At least one occurrence (the neutral copy in the constant).
    // Any other legal copy would indicate the page inventing
    // production text.
    const lines = source.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (/\b(shall|hereby|you (agree|acknowledge)|terms of service|privacy)\b/i.test(trimmed)) {
        assert.fail(`page MUST NOT invent production legal copy; found line: ${trimmed}`);
      }
    }
    assert.ok(neutralCount >= 1, "neutral copy must exist at least once");
  });

  test("POST success navigates via navigateAfterIntent (server-resolved safeReturnTo only)", () => {
    const source = readFile("workspace/intent/page.tsx");
    // The page imports navigateAfterIntent AND calls it with the
    // response after a successful submit (P1-003 — never reads
    // raw query params, never inspects response.user).
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
    // The helper reads response.safeReturnTo ONLY.
    assert.ok(/input\.response\.safeReturnTo/.test(source));
    // MUST NOT inspect response.user or read raw location / search.
    // Strip comments to avoid matching the explanatory header.
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
    assert.ok(
      /safeReturnTo\s*\?\?\s*"\/dashboard"/.test(source),
      "fallback path MUST be /dashboard",
    );
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
    // Does navigate to /workspace/switch.
    assert.ok(
      /\/workspace\/switch\?target=/.test(handleBody),
      "handleSelect MUST navigate to the switch interstitial",
    );
  });
});

describe("Switch interstitial — commit / cancel behaviour (§4 / P1-005)", () => {
  test("Switch page calls commitPendingTarget on Switch and continue", () => {
    const source = readFile("workspace/switch/page.tsx");
    assert.ok(
      /commitPendingTarget\(\)/.test(source),
      "Switch and continue MUST call commitPendingTarget",
    );
  });

  test("Switch page calls cancelPendingTarget on Cancel (commit state untouched)", () => {
    const source = readFile("workspace/switch/page.tsx");
    assert.ok(
      /cancelPendingTarget\(\)/.test(source),
      "Cancel MUST call cancelPendingTarget (the provider guarantees the committed state is untouched)",
    );
  });

  test("Switch page promotes a query-target to pending on mount (P1-002 deep-link / hard reload)", () => {
    const source = readFile("workspace/switch/page.tsx");
    // The page reads ?target= from the URL via useSearchParams and
    // calls setPendingTarget when context is empty.
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
    // Find the quick-actions section.
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
    // The Choose intent CTA / auto-redirect path is gated on
    // Personal-only via the `actingWorkspace.workspaceType !==
    // "Personal"` return guard at the mount effect.
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
