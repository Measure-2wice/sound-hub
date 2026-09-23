/* eslint-disable @typescript-eslint/no-floating-promises */
// Dashboard page contract tests (M2 #82).
//
// Background: Codex review (P1-003, P2-001) flagged two regressions
// on the recovery surface:
//   1. The recovery surface hid valid Organization memberships —
//      a recovery user could not see any current Organization
//      identity, even though existing Organization memberships
//      remain usable via the existing authorization path.
//   2. The recovery copy promised a "support team can review your
//      account" workflow that the functional specification does
//      not provide.
//
// These source-pattern tests pin the dashboard page's recovery
// surface so a refactor cannot silently:
//   - Drop Organization membership visibility.
//   - Expose internal DTO fields (slug, raw capabilities, role
//     vocabulary) just because they exist in the public DTO.
//   - Re-introduce support-process or automated-recovery promises.
//   - Fabricate a navigation affordance for a Workspace that has
//     no supported customer route in #82 scope.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const DASHBOARD_PAGE_SOURCE = readFileSync(
  `${new URL(".", import.meta.url).pathname}page.tsx`,
  "utf8",
);
const ACTIVITY_SECTION_SOURCE = readFileSync(
  `${new URL(".", import.meta.url).pathname}activity-section.tsx`,
  "utf8",
);
const DASHBOARD_SOURCES = `${DASHBOARD_PAGE_SOURCE}\n${ACTIVITY_SECTION_SOURCE}`;

describe("dashboard recovery surface (M2 #82)", () => {
  test("recovery surface renders Organization memberships by name", () => {
    // The recovery surface MUST filter `user.workspaces` to
    // `workspaceType === "Organization"` and render each membership's
    // `name`. This proves recovery users see their existing
    // Organization identity truthfully.
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /user\.workspaces\.filter\([\s\S]*?Organization[\s\S]*?\)/,
      "expected the recovery surface to filter user.workspaces to Organization type",
    );
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /organization\.name/,
      "expected the recovery surface to render organization.name",
    );
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /data-testid="dashboard-recovery-organization"/,
      "expected a stable testid for each recovery Organization membership",
    );
  });

  test("recovery surface does not expose Workspace slug, raw capabilities, or internal role vocabulary", () => {
    // Extract the recovery Organization rendering block and assert
    // it does NOT surface DTO internals that have no customer-facing
    // meaning on the recovery surface.
    const organizationListBlock = DASHBOARD_PAGE_SOURCE.match(
      /dashboard-recovery-organizations-list[\s\S]*?<\/ul>/,
    );
    assert.ok(
      organizationListBlock,
      "expected a dashboard-recovery-organizations-list block in the recovery surface",
    );
    const block = organizationListBlock[0];
    assert.equal(
      block.includes("slug"),
      false,
      "recovery Organization cards must not surface the Workspace slug",
    );
    assert.equal(
      block.includes("capabilities"),
      false,
      "recovery Organization cards must not surface raw capabilities",
    );
    assert.equal(
      block.includes("Owner") || block.includes("Editor"),
      false,
      "recovery Organization cards must not surface internal role vocabulary",
    );
    assert.equal(
      block.includes("role"),
      false,
      "recovery Organization cards must not surface the role field",
    );
  });

  test("recovery surface does not fabricate a navigation affordance to a non-existent Workspace destination", () => {
    // The recovery surface must NOT add a Link or anchor that points
    // at a customer Workspace destination outside #82 scope. The
    // existing acting-Workspace flow is owned by the audio dashboard
    // and is not extended here.
    const organizationListBlock = DASHBOARD_PAGE_SOURCE.match(
      /dashboard-recovery-organizations-list[\s\S]*?<\/ul>/,
    );
    assert.ok(organizationListBlock, "expected the recovery organization list block");
    assert.equal(
      /<a\s|<Link\s/i.test(organizationListBlock[0]),
      false,
      "recovery Organization cards must not contain a Link or anchor to a non-existent Workspace destination",
    );
  });

  test("recovery copy is truthful — no support-process, no sign-in-driven recovery promise", () => {
    // The recovery surface MUST NOT promise a support team, sign-in
    // recovery, or any automated recovery flow that the functional
    // spec does not provide.
    assert.equal(
      /support\s+team/i.test(DASHBOARD_PAGE_SOURCE),
      false,
      "recovery copy must not promise a support team workflow",
    );
    assert.equal(
      /try\s+signing\s+in\s+again|sign[\s-]?in\s+again|repeat\s+the\s+sign[\s-]?in/i.test(
        DASHBOARD_PAGE_SOURCE,
      ),
      false,
      "recovery copy must not promise that repeating sign-in recovers contradictory Workspace state",
    );
    // The truthful neutral language MUST be present. The source
    // wraps the long sentence across multiple lines, so the regex
    // allows whitespace between the fragments.
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /SoundHub couldn(?:&apos;|['’])t safely confirm your Personal Workspace/,
      "expected the truthful 'couldn't safely confirm' language",
    );
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /Your existing[\s\S]*?memberships have not been changed/,
      "expected the truthful 'memberships have not been changed' language",
    );
  });

  test("recovery sign-out is bounded: signingOut state prevents duplicate submissions while pending", () => {
    // The recovery sign-out button MUST carry a `signingOut`
    // state so a customer who double-clicks the button does not
    // launch two parallel sign-out requests, and so the button
    // reflects a pending sign-out to assistive technology.
    const recoveryBlock = DASHBOARD_PAGE_SOURCE.match(
      /function\s+RecoverySurface[\s\S]*?<\/Card>\s*\n\s*\{organizationMemberships[\s\S]*?\)\s*\}\s*\n/,
    );
    assert.ok(recoveryBlock, "expected a RecoverySurface function body");
    const body = recoveryBlock[0];

    // The state hook MUST be declared.
    assert.match(
      body,
      /useState\(\s*false\s*\)/,
      "recovery surface MUST carry a signingOut boolean state",
    );
    assert.match(
      body,
      /const\s*\[\s*signOutError\s*,\s*setSignOutError\s*\]\s*=\s*useState/,
      "recovery surface MUST carry a signOutError state",
    );

    // The click handler MUST guard against duplicate submissions
    // while pending.
    assert.match(
      body,
      /if\s*\(\s*signingOut\s*\)\s*return/,
      "recovery sign-out handler MUST short-circuit when signingOut is true",
    );

    // The handler MUST wrap the async sign-out in a try/catch
    // so a failure surfaces observable UI state instead of
    // silently disappearing as an unhandled rejection.
    assert.match(
      body,
      /try\s*\{[\s\S]*?signOutAndRefresh\(\)[\s\S]*?\}\s*catch/,
      "recovery sign-out handler MUST wrap signOutAndRefresh in try/catch",
    );

    // The catch branch MUST NOT rethrow a raw transport /
    // provider error message; it MUST set a bounded
    // customer-safe message.
    assert.match(
      body,
      /setSignOutError\(/,
      "recovery sign-out handler MUST set a bounded signOutError on failure",
    );

    // The pending state MUST be reset on both the success and
    // failure paths so the button does not get stuck in the
    // "Signing out…" affordance.
    assert.match(
      body,
      /finally\s*\{\s*setSigningOut\(\s*false\s*\)/,
      "recovery sign-out handler MUST reset signingOut in finally",
    );

    // The button MUST carry `disabled={signingOut}` so a
    // repeated click does not queue a second submission.
    const signOutButtonMatch = body.match(
      /<button[\s\S]*?data-testid="dashboard-recovery-sign-out"[\s\S]*?<\/button>/,
    );
    assert.ok(signOutButtonMatch, "expected the recovery sign-out button element");
    assert.match(
      signOutButtonMatch[0],
      /disabled=\{signingOut\}/,
      "the recovery sign-out button MUST be disabled while signingOut",
    );
    assert.match(
      signOutButtonMatch[0],
      /aria-busy=\{signingOut\}/,
      "the recovery sign-out button MUST expose aria-busy while signingOut",
    );
  });

  test("recovery sign-out navigates only on success", () => {
    // The handler MUST navigate to the public surface ONLY
    // inside the success branch. The catch branch MUST NOT
    // navigate — a failed sign-out keeps the customer on the
    // recovery surface so they can retry.
    const recoveryBlock = DASHBOARD_PAGE_SOURCE.match(
      /function\s+RecoverySurface[\s\S]*?<\/Card>\s*\n\s*\{organizationMemberships[\s\S]*?\)\s*\}\s*\n/,
    );
    assert.ok(recoveryBlock, "expected a RecoverySurface function body");
    const body = recoveryBlock[0];

    // Locate the success branch (between `try {` and `catch`).
    const tryMatch = body.match(/try\s*\{([\s\S]*?)\}\s*catch\s*\{([\s\S]*?)\}/);
    assert.ok(tryMatch, "expected a try/catch wrapping the sign-out network call");
    const tryBranch = tryMatch[1] ?? "";
    const catchBranch = tryMatch[2] ?? "";

    // Navigation (router.replace("/")) MUST live in the
    // success branch.
    assert.match(
      tryBranch,
      /router\.replace\(\s*["']\/["']\s*\)/,
      "navigation MUST happen on success, not on failure",
    );

    // The catch branch MUST NOT call router.replace. A failed
    // sign-out keeps the customer on the recovery surface so
    // they can read the error message and retry.
    assert.equal(
      /router\.replace\s*\(/.test(catchBranch),
      false,
      "the catch branch MUST NOT navigate — the customer must remain on the recovery surface so they can retry",
    );

    // The catch branch MUST set a bounded error state.
    assert.match(
      catchBranch,
      /setSignOutError\(/,
      "the catch branch MUST set a bounded signOutError message",
    );
  });

  test("recovery sign-out error is surfaced with role=alert and contains no raw transport/provider text", () => {
    // The recovery surface MUST render the bounded signOutError
    // through the Alert primitive so screen readers announce
    // the failure immediately. Raw transport / provider error
    // text MUST NOT reach the customer.
    const recoveryBlock = DASHBOARD_PAGE_SOURCE.match(
      /function\s+RecoverySurface[\s\S]*?<\/Card>\s*\n\s*\{organizationMemberships[\s\S]*?\)\s*\}\s*\n/,
    );
    assert.ok(recoveryBlock, "expected a RecoverySurface function body");
    const body = recoveryBlock[0];

    // The error region MUST be stable-testid'd and routed
    // through the Alert primitive.
    assert.match(
      body,
      /data-testid="dashboard-recovery-sign-out-error"/,
      "recovery surface MUST render a stable testid on the sign-out error region",
    );
    assert.match(
      body,
      /<Alert[\s\S]*?role="alert"[\s\S]*?variant="failure"/,
      'the sign-out error MUST render through <Alert role="alert" variant="failure">',
    );

    // The customer-facing copy in the catch branch MUST be a
    // bounded sentence; it MUST NOT pass `err.message` or
    // `String(err)` through verbatim.
    assert.equal(
      /setSignOutError\(\s*err\.message\s*\)/.test(body),
      false,
      "the catch branch MUST NOT pass `err.message` through verbatim",
    );
    assert.equal(
      /setSignOutError\(\s*String\(\s*err\s*\)\s*\)/.test(body),
      false,
      "the catch branch MUST NOT pass `String(err)` through verbatim",
    );

    // The bounded message MUST be present in the source.
    assert.match(
      body,
      /Sign-out could not be completed\./,
      "the catch branch MUST set a bounded customer-safe sign-out error message",
    );
  });
});

describe("dashboard loading surface (M2 #82)", () => {
  test('loading branch renders the Alert primitive with role="status" and variant="status"', () => {
    // M2 (#82) visual-QA: the loading branch must use the existing
    // Alert primitive (role="status", variant="status") — never an
    // unbounded floating paragraph. The Alert's data-alert-variant
    // attribute is asserted on the rendered DOM by the Playwright
    // test; this source-pattern assertion pins the call site so a
    // regression that reverts to a plain <p role="status"> without
    // the Alert primitive fails here.
    const loadingBranch = DASHBOARD_PAGE_SOURCE.match(
      /if\s*\(\s*loading\s*\)\s*\{[\s\S]*?\}\s*(?=if\s*\(\s*!user\s*\))/,
    );
    assert.ok(loadingBranch, "expected a `if (loading)` branch in the dashboard page source");
    assert.match(
      loadingBranch[0],
      /<Alert\b[\s\S]*?role="status"/,
      'the loading branch MUST render <Alert role="status">',
    );
    assert.match(
      loadingBranch[0],
      /<Alert\b[\s\S]*?variant="status"/,
      'the loading branch MUST render <Alert variant="status"> so the status surface never carries a gold accent',
    );
  });

  test("loading surface copy is customer-safe — no debug / provider / domain terminology", () => {
    // M2 (#82) visual-QA: the loading surface must NOT expose
    // debug terms (prisma), provider terminology, raw DTO field
    // names, or the opaque Workspace slug pattern. The Playwright
    // assertion pins the rendered DOM; this source-pattern test
    // pins the call site so the customer-safe copy cannot drift
    // back into the customer DOM.
    //
    // The check extracts ONLY the customer-visible JSX strings
    // (the Alert `title` attribute + the children text) so source
    // comments that legitimately discuss the contract do not
    // trip the assertion. The dashboard's other branches — the
    // signed-out, Personal Workspace, and recovery surfaces —
    // are pinned by their own dedicated source-pattern tests.
    const loadingBranch = DASHBOARD_PAGE_SOURCE.match(
      /if\s*\(\s*loading\s*\)\s*\{[\s\S]*?\}\s*(?=if\s*\(\s*!user\s*\))/,
    );
    assert.ok(loadingBranch, "expected a `if (loading)` branch in the dashboard page source");
    const branch = loadingBranch[0];
    const titleAttr = branch.match(/title\s*=\s*"([^"]*)"/);
    assert.ok(titleAttr, 'expected a `title="..."` attribute on the loading Alert');
    const renderedCopy: string = titleAttr[1] ?? "";
    assert.equal(
      /prisma/i.test(renderedCopy),
      false,
      "loading surface copy must not expose debug / implementation terminology",
    );
    assert.equal(
      /provider/i.test(renderedCopy),
      false,
      "loading surface copy must not expose identity-provider terminology",
    );
    assert.equal(
      /personal-c\[a-z0-9\]\+/.test(renderedCopy),
      false,
      "loading surface copy must not expose the opaque Workspace slug shape",
    );
    // The customer-facing "Loading your workspace…" wording MUST
    // appear in the title attribute.
    assert.match(
      renderedCopy,
      /Loading your workspace/,
      "expected the customer-facing 'Loading your workspace…' copy in the loading Alert title",
    );
  });
});

describe("dashboard grounded activity + approval readiness (M2 #83 P1-002)", () => {
  // P1-002: the #83 Personal Workspace home must show grounded
  // Requests/Deals summaries where records exist and keep
  // optional permission-to-approve readiness discoverable at low
  // prominence. The dashboard derives from existing repository
  // APIs only — no new persistence.

  test("Personal dashboard renders compact 'Your activity' summary grounded in listProjectRequests + listDeals", () => {
    // `listProjectRequests`/`listDeals` live in `page.tsx` (the
    // load effect); the derived counts (`buyerPendingRequests`,
    // `sellerPendingRequests`, `negotiatingDeals`) and the
    // `dashboard-activity` testid live in `activity-section.tsx`
    // (the extracted section). The dashboard's contract is the
    // composition of both files.
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /listProjectRequests\(/,
      "dashboard reads ProjectRequest records",
    );
    assert.match(DASHBOARD_PAGE_SOURCE, /listDeals\(/, "dashboard reads Deal records");
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /buyerWorkspaceId.*Pending|Pending.*buyerWorkspaceId/,
      "activity section derives a Buyer-pending count from ProjectRequest rows",
    );
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /sellerWorkspaceId.*Pending|Pending.*sellerWorkspaceId/,
      "activity section derives a Seller-pending count from ProjectRequest rows",
    );
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /Negotiating/,
      "activity section derives a Negotiating-Deals count from Deal rows",
    );
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /data-testid="dashboard-activity"/,
      "activity section renders a stable testid on the activity card",
    );
  });

  test("Personal dashboard activity card is omitted entirely on empty / unloaded state (no fabricated feed)", () => {
    // The activity card is rendered conditionally on
    // (records loaded AND at least one count > 0). An empty
    // Workspace must NOT see a fabricated feed. The guard
    // lives in `activity-section.tsx` after the #83
    // P1-001 refactor.
    const showActivityMatch = ACTIVITY_SECTION_SOURCE.match(/showActivity\s*=\s*[\s\S]*?;/);
    assert.ok(showActivityMatch, "expected a showActivity guard");
    assert.match(
      showActivityMatch[0],
      /buyerPendingRequests\s*>\s*0\s*\|\|\s*sellerPendingRequests\s*>\s*0\s*\|\|\s*negotiatingDeals\s*>\s*0/,
      "activity card MUST be conditional on at least one non-zero grounded count",
    );
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /showActivity\s*\?\s*\([\s\S]*?dashboard-activity[\s\S]*?\)\s*:\s*null/,
      "activity card MUST render or be omitted, never an empty fallback",
    );
  });

  // P1-002: approval-readiness is derived per the acting
  // Workspace's actual Deal party. The dashboard MUST surface
  // party-appropriate readiness for both Buyer-only and
  // Seller-only actors; a Seller-only Workspace with a Deal in
  // `AwaitingSellerApproval` MUST see the Seller-side hint.
  test("Personal dashboard derives Buyer-side approval-readiness from a Negotiating Deal the actor owns on the Buyer side", () => {
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /data-testid="dashboard-approval-readiness-buyer"/,
      "activity section MUST render a stable testid on the Buyer-side approval-readiness surface",
    );
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /buyerNeedsApproval\s*=[\s\S]*?actingSide\s*===\s*["']Buyer["']/,
      "Buyer-side readiness MUST be conditioned on the deal's actingSide === 'Buyer'",
    );
    const readinessBlock = ACTIVITY_SECTION_SOURCE.match(
      /\{buyerNeedsApproval\s*\?\s*\(\s*<p\b[\s\S]*?data-testid="dashboard-approval-readiness-buyer"[\s\S]*?<\/p>/,
    );
    assert.ok(readinessBlock, "expected a Buyer-side approval-readiness surface");
    assert.equal(
      /<Link\s|<a\s/i.test(readinessBlock[0]),
      false,
      "approval-readiness surface MUST NOT link to a not-yet-shipped destination",
    );
    assert.match(
      readinessBlock[0],
      /text-muted/,
      "approval-readiness surface MUST render in muted typography to remain low prominence",
    );
  });

  test("Personal dashboard derives Seller-side approval-readiness from a Negotiating Deal the actor owns on the Seller side (P1-002)", () => {
    // P1-002: a Seller-only Workspace with a Negotiating Deal
    // in `AwaitingSellerApproval` MUST see party-appropriate
    // readiness copy. The hint MUST be party-specific — Seller
    // copy cannot leak "buyer approval" wording to a Seller-only
    // actor, and a Seller-only Workspace with NO Seller-side
    // readiness MUST NOT see the Buyer-side hint.
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /data-testid="dashboard-approval-readiness-seller"/,
      "activity section MUST render a stable testid on the Seller-side approval-readiness surface",
    );
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /sellerNeedsApproval\s*=[\s\S]*?actingSide\s*===\s*["']Seller["']/,
      "Seller-side readiness MUST be conditioned on the deal's actingSide === 'Seller'",
    );
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /AwaitingSellerApproval/,
      "Seller-side readiness MUST reference the closed AwaitingSellerApproval state",
    );
    const sellerReadinessBlock = ACTIVITY_SECTION_SOURCE.match(
      /\{sellerNeedsApproval\s*\?\s*\(\s*<p\b[\s\S]*?data-testid="dashboard-approval-readiness-seller"[\s\S]*?<\/p>/,
    );
    assert.ok(sellerReadinessBlock, "expected a Seller-side approval-readiness surface");
    // The Seller-side hint copy MUST NOT mention "buyer approval" —
    // party-appropriate copy is mandatory per P1-002.
    assert.equal(
      /buyer approval/i.test(sellerReadinessBlock[0]),
      false,
      "Seller-side readiness copy MUST NOT mention 'buyer approval'",
    );
    assert.match(
      sellerReadinessBlock[0],
      /seller approval/i,
      "Seller-side readiness copy MUST mention 'seller approval'",
    );
  });

  test("Personal dashboard renders approval-readiness surfaces without inventing persistence (no DealApprover / sellerAcceptance)", () => {
    // P1-002 must NOT introduce new persistence or capability
    // fields. The dashboard reads existing repository records
    // and surfaces grounded counts only.
    const codeOnly = DASHBOARD_PAGE_SOURCE.split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("/*") && !line.trim().startsWith("*/"))
      .join("\n");
    assert.equal(
      /DealApprover|approvalPermission|permissionToApprove/.test(codeOnly),
      false,
      "dashboard MUST NOT introduce new approval-permission persistence",
    );
    assert.equal(
      /sellerAcceptance/.test(codeOnly),
      false,
      "dashboard MUST NOT collect a generic Seller participation acceptance",
    );
  });
});

describe("dashboard grounded activity error surface (M2 #83 P2-002)", () => {
  // P2-002: a failure from either list request cannot be
  // presented as a truthful empty Workspace. The dashboard
  // carries independent load/error state per collection and
  // surfaces a small recoverable error card so an API failure
  // is distinguishable from a genuinely empty Workspace.

  test("dashboard uses Promise.allSettled (not Promise.all) so a single failure does not discard the other list", () => {
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /Promise\.allSettled\(/,
      "dashboard MUST use Promise.allSettled to preserve independent load state",
    );
    assert.equal(
      /Promise\.all\(\s*\[\s*listProjectRequests\([^)]+\)\s*,\s*listDeals\(/m.test(
        DASHBOARD_PAGE_SOURCE,
      ),
      false,
      "dashboard MUST NOT use Promise.all around the two list calls (it would discard one on the other's failure)",
    );
  });

  test("dashboard carries independent error state per collection (requestsLoadError + dealsLoadError)", () => {
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /requestsLoadError/,
      "dashboard MUST carry independent requestsLoadError state",
    );
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /dealsLoadError/,
      "dashboard MUST carry independent dealsLoadError state",
    );
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /setRequestsLoadError\(\s*true\s*\)/,
      "dashboard MUST set requestsLoadError on a requests list failure",
    );
    assert.match(
      DASHBOARD_PAGE_SOURCE,
      /setDealsLoadError\(\s*true\s*\)/,
      "dashboard MUST set dealsLoadError on a deals list failure",
    );
  });

  test("dashboard surfaces a small recoverable error card when grounded activity cannot be loaded", () => {
    assert.match(
      DASHBOARD_SOURCES,
      /data-testid="dashboard-activity-error"/,
      "dashboard MUST render a stable testid on the recoverable error card",
    );
    // The error card copy MUST mention "Couldn't load" or
    // equivalent so the customer can distinguish a broken API
    // from a genuinely empty Workspace.
    assert.match(
      DASHBOARD_SOURCES,
      /Couldn(?:&apos;|['’])t load your activity/,
      "dashboard error card MUST surface a 'couldn't load' message",
    );
    assert.match(
      DASHBOARD_SOURCES,
      /Refresh the page/,
      "dashboard error card MUST surface a recoverable retry hint",
    );
  });

  test("dashboard preserves a successful response when the other list fails (P2-002 partial-failure)", () => {
    // P2-002: a partial-failure scenario must NOT discard the
    // successful list's response. The source MUST guard each
    // `setState` call independently of the other branch, so a
    // successful requests/deals payload survives a failure of
    // the other list.
    //
    // The implementation uses `Promise.allSettled` and branches
    // on each result's `status`, so a failure in one branch
    // cannot block the other branch's `setState` call. The
    // surrounding `if (reqResult.status === "fulfilled")` /
    // `if (dealResult.status === "fulfilled")` branches are
    // structurally independent in the source.
    const fulfilledBranches = DASHBOARD_PAGE_SOURCE.match(/status\s*===\s*["']fulfilled["']/g);
    assert.ok(fulfilledBranches, "expected Promise.allSettled fulfilled branches");
    assert.equal(
      fulfilledBranches.length,
      2,
      "dashboard MUST have one fulfilled branch per collection (independent load state)",
    );
  });
});

describe("dashboard cross-Workspace stale state (M2 #83 P1-001)", () => {
  // P1-001: switching the acting Workspace MUST NOT cause the
  // previously-loaded Workspace's grounded activity to render
  // against the new actor. The dashboard binds loaded state to
  // the Workspace that produced it and renders nothing for an
  // actor whose fetch has not yet resolved.
  //
  // The behavior is exercised at the React boundary by
  // `apps/web/src/app/dashboard/activity-section.test.tsx`
  // (rendering tests). These source-pattern tests pin the
  // gate logic so a regression that removes the
  // `loadedForWorkspaceId` tracking fails here before reaching
  // the behavior layer.

  test("dashboard tracks loadedForWorkspaceId alongside the loaded activity state", () => {
    assert.match(
      DASHBOARD_SOURCES,
      /loadedForWorkspaceId/,
      "dashboard MUST carry loadedForWorkspaceId state to bind loaded activity to the actor that produced it",
    );
    assert.match(
      DASHBOARD_SOURCES,
      /setLoadedForWorkspaceId\(/,
      "dashboard MUST update loadedForWorkspaceId when the fetch settles",
    );
  });

  test("dashboard clears loadedForWorkspaceId on actor change so stale state cannot render", () => {
    // The effect body MUST clear `loadedForWorkspaceId` (and
    // its companion state) at the start of each fetch, so the
    // FIRST render after an actor switch sees the cleared
    // state and the rendered section returns `null`.
    const clearBlock = DASHBOARD_SOURCES.match(/setLoadedForWorkspaceId\(\s*null\s*\)/);
    assert.ok(
      clearBlock,
      "dashboard MUST clear loadedForWorkspaceId on each fetch start to prevent stale rendering",
    );
  });

  test("dashboard renders the activity section through a P1-001 cross-Workspace gate (loadedForWorkspaceId === actingWorkspace.workspaceId)", () => {
    // The behavior test file (`activity-section.test.tsx`) is
    // the canonical guarantee of the cross-Workspace gate at
    // the rendered-DOM level. This source-pattern assertion
    // pins the gate's presence in the dashboard's source so a
    // refactor cannot silently re-introduce cross-Workspace
    // stale state.
    assert.match(
      ACTIVITY_SECTION_SOURCE,
      /loadedForWorkspaceId\s*!==\s*actingWorkspace\.workspaceId/,
      "activity section MUST gate grounded activity on loadedForWorkspaceId === actingWorkspace.workspaceId",
    );
  });
});
