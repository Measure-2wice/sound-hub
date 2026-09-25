/* eslint-disable @typescript-eslint/no-floating-promises */
// Shared post-command route contract test (M2 #83 P2-001).
//
// Background: the bounded #83 return-destination set is declared
// ONCE in `@soundhub/types` (`postCommandRouteValuesV1`) and is
// consumed by both:
//   1. the server-side authority boundary
//      (`apps/api/src/lib/post-command-return-destination.ts`), and
//   2. the typed client narrowing helper on the Workspace-switch
//      interstitial (`apps/web/src/app/workspace/switch/page.tsx`).
//
// Without this test, a new route added to the resolver could be
// validly returned by the server but silently rejected by the
// client narrowing helper until the second list was updated in
// lock-step. This test pins the cross-layer consistency so the
// server's authoritative route set and the client's typed helper
// cannot drift.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { postCommandRouteValuesV1 } from "@soundhub/types";

const REPO_ROOT = `${new URL("../../../../../../", import.meta.url).pathname}`;
const SERVER_RESOLVER_SOURCE = readFileSync(
  `${REPO_ROOT}/apps/api/src/lib/post-command-return-destination.ts`,
  "utf8",
);
const CLIENT_SWITCH_SOURCE = readFileSync(
  `${REPO_ROOT}/apps/web/src/app/workspace/switch/page.tsx`,
  "utf8",
);

describe("post-command return routes shared across server + client (M2 #83 P2-001)", () => {
  test("server-side resolver consumes the shared @soundhub/types definition", () => {
    // The server-side resolver MUST NOT redeclare the route
    // list locally; it MUST import it from `@soundhub/types`.
    // A local re-declaration can drift out of sync with the
    // typed client helper.
    assert.match(
      SERVER_RESOLVER_SOURCE,
      /from\s+["']@soundhub\/types["']/,
      "the resolver MUST import from @soundhub/types",
    );
    assert.match(
      SERVER_RESOLVER_SOURCE,
      /postCommandRouteValuesV1/,
      "the resolver MUST consume the shared postCommandRouteValuesV1 list",
    );
  });

  test("client-side switch helper consumes the shared @soundhub/types definition", () => {
    // The Workspace-switch page's typed helper
    // (`toTypedSwitchRoute`) MUST consume the shared definition
    // rather than redeclaring the closed enum. A local list
    // can drift out of sync with the server-side resolver.
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /from\s+["']@soundhub\/types["']/,
      "the switch page MUST import from @soundhub/types",
    );
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /postCommandRouteValuesV1/,
      "the switch page MUST consume the shared postCommandRouteValuesV1 list",
    );
  });

  test("shared route list is closed: it does not contain action endpoints", () => {
    // The bounded set is non-empty AND never contains the `/api/`
    // action prefix (the resolver explicitly rejects action
    // endpoints in step 2 of its algorithm; this test pins the
    // shared definition to the same invariant).
    assert.ok(
      postCommandRouteValuesV1.length > 0,
      "shared route list must enumerate at least one route",
    );
    for (const route of postCommandRouteValuesV1) {
      assert.ok(route.startsWith("/"), `every route MUST be an absolute path (${route})`);
      assert.ok(
        !route.startsWith("/api/"),
        `shared list MUST NOT contain action endpoints (${route})`,
      );
    }
  });
});

// The deep-link Active-only gate is covered end-to-end by the
// Playwright spec at `apps/web/e2e/intent-and-workspace-switch.spec.ts`
// ("P2-002: deep link to a Suspended target renders switch-unavailable
// and does NOT render the commit button" + "P2-002: deep link to an
// inaccessible target (random UUID) renders switch-unavailable and
// does NOT render the commit button"). Those tests drive the real
// browser through the seeded Workspace set and assert the observable
// DOM-visible behaviors (`switch-unavailable` visible, the commit
// button absent, the recovery affordance present) — the spec at
// `docs/specs/milestone-2-reconciled-ux.md:803` requires UX tests
// assert observable behavior rather than React component structure,
// so the superseded source-regex tests have been removed in favor
// of the browser-seam coverage.

describe("Workspace-switch page — query-string re-sync behavior (M2 #83 visual-QA + Codex P1-001 regressions)", () => {
  // Visual QA caught a P1 regression: after a switch attempt that
  // left `pendingTargetId` set (selector click + browser-back, or
  // selector click + dashboard deep-link before commit settled), a
  // follow-up navigation to `/workspace/switch?target=<other>` kept
  // rendering the stale pending target as "Switch to:". The
  // root cause was a `if (pendingTargetId !== null) return;` short-
  // circuit inside the promotion effect — the effect only re-synced
  // `pendingTargetId` from the URL when the in-memory value was
  // empty. Codex review (P1-001) tightened the contract further:
  // an invalid explicit URL target MUST clear any stale
  // `pendingTargetId` so the user can never commit a Workspace the
  // URL did not actually request. Codex review (P2-001) asked for
  // the duplicated Active lookup to be deduplicated.
  test("promotion effect does NOT short-circuit when pendingTargetId is non-null; it must compare against the resolved candidate", () => {
    // The original gate `if (pendingTargetId !== null) return;` is
    // the precise cause of the visual-QA regression. A regression
    // that re-introduces it must fail this assertion.
    assert.equal(
      /if\s*\(\s*pendingTargetId\s*!==\s*null\s*\)\s*return\s*;/.test(CLIENT_SWITCH_SOURCE),
      false,
      "promotion effect MUST NOT short-circuit on pendingTargetId !== null; it must re-sync whenever pendingTargetId !== queryCandidate.workspaceId",
    );
    // The replacement gate MUST compare `pendingTargetId` against
    // the shared `queryCandidate.workspaceId` so a stale id from a
    // previous uncommitted switch can be overwritten.
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /pendingTargetId\s*[!=]==\s*queryCandidate\.workspaceId/,
      "the promotion effect MUST compare pendingTargetId against the resolved queryCandidate.workspaceId",
    );
    // The Active gate MUST still be applied against `user.workspaces`
    // before any pendingTarget is set — a deep-link to a Suspended
    // or non-Active Workspace must still fall through to the
    // unavailable surface (P2-002 invariant).
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /user\.workspaces\.find\([\s\S]*?queryTargetId[\s\S]*?Active/,
      "the promotion effect MUST validate the URL candidate against user.workspaces (Active gate)",
    );
  });

  test("promotion effect clears stale pendingTargetId when an explicit URL target is present but invalid (P1-001)", () => {
    // When `?target=` is present but does NOT resolve to an
    // accessible Active Workspace, the effect MUST clear any
    // stale `pendingTargetId` via `setPendingTarget(null)` so the
    // user cannot commit a Workspace the URL did not actually
    // request. The previous short-circuit (`if (!candidate)
    // return;`) left the stale value intact and let the target
    // memo fall through to it.
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /setPendingTarget\(null\)/,
      "the promotion effect MUST call setPendingTarget(null) when the explicit URL target does not resolve to an accessible Active Workspace",
    );
    // The clear MUST be guarded by `queryCandidate === null` (the
    // resolved candidate is absent), not by a stale-state check
    // alone. Pin the branch order so a refactor cannot move the
    // clear out of the invalid-target branch.
    const clearBranchMatch = CLIENT_SWITCH_SOURCE.match(
      /if\s*\(\s*queryCandidate\s*===\s*null\s*\)\s*\{[\s\S]*?setPendingTarget\(null\)/,
    );
    assert.ok(
      clearBranchMatch,
      "setPendingTarget(null) MUST live inside the `queryCandidate === null` branch so it only fires for invalid explicit URL targets",
    );
  });

  test("target memo is authoritative about the URL target — does NOT fall back to pendingTarget when `?target=` is present", () => {
    // When `?target=` is present, the memo MUST consult the
    // resolved candidate and MUST NOT fall back to a stale
    // `pendingTarget` — even if the candidate is invalid (which
    // would route to the unavailable surface). The fallback is
    // preserved only when no explicit query target is present
    // (P1-001).
    const memoBodyMatch = CLIENT_SWITCH_SOURCE.match(
      /const target = useMemo\(\(\) => \{[\s\S]*?return null;\s*\}, \[pendingTarget, queryTargetId, queryCandidate\]\);/,
    );
    assert.ok(memoBodyMatch, "the target useMemo block must be present in the switch page");
    const memoBody = memoBodyMatch[0];
    // The memo MUST short-circuit on a present query target and
    // return the resolved candidate (which may be null for an
    // invalid URL target).
    assert.match(
      memoBody,
      /if\s*\(\s*queryTargetId\s*!==\s*null\s*\)\s*return\s+queryCandidate/,
      "target memo MUST return queryCandidate when queryTargetId is present (P1-001 authoritative-query rule)",
    );
    // The pendingTarget fallback MUST appear AFTER the
    // queryTargetId short-circuit so it can only fire when no
    // explicit query target is present.
    const queryShortCircuitIndex = memoBody.search(/if\s*\(\s*queryTargetId\s*!==\s*null\s*\)/);
    const pendingFallbackIndex = memoBody.search(
      /if\s*\(\s*pendingTarget\s*\)\s*return\s+pendingTarget/,
    );
    assert.ok(queryShortCircuitIndex >= 0, "the queryTargetId short-circuit must be present");
    assert.ok(pendingFallbackIndex >= 0, "the pendingTarget fallback must still be present");
    assert.ok(
      pendingFallbackIndex > queryShortCircuitIndex,
      "the pendingTarget fallback MUST be guarded by the queryTargetId short-circuit so a stale pendingTarget cannot leak through when the URL carries an explicit target",
    );
  });

  test("Active query-target resolution is shared between the sync effect and the target memo (P2-001)", () => {
    // Codex review (P2-001) flagged that the same Active-membership
    // lookup was duplicated in the sync effect and target memo.
    // The fix derives one memoized `queryCandidate` and consumes
    // it from both. Pin by asserting there is exactly one
    // `user.workspaces.find(...Active...)` lookup in the file
    // AND that both the effect body and the memo body reference
    // the shared `queryCandidate` variable.
    const lookupCount = (
      CLIENT_SWITCH_SOURCE.match(
        /user\.workspaces\.find\([\s\S]*?workspaceStatus\s*===\s*["']Active["']/g,
      ) ?? []
    ).length;
    assert.equal(
      lookupCount,
      1,
      `the Active-membership lookup MUST be defined exactly once (was duplicated across the effect and the memo); found ${lookupCount}`,
    );
    // Both consumers MUST reference the shared `queryCandidate`
    // variable rather than re-running the lookup inline.
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /const\s+queryCandidate\s*=\s*useMemo/,
      "queryCandidate MUST be a shared useMemo so both consumers share the resolution",
    );
    // The effect body MUST also branch on `queryCandidate === null`
    // to clear stale state on an invalid URL target.
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /queryCandidate\s*===\s*null/,
      "the sync effect MUST branch on queryCandidate === null to clear stale pendingTargetId on an invalid URL target",
    );
  });

  test("switch page renders the commit form truthfully when target is valid even with actingWorkspace === null (P1-001 second iteration)", () => {
    // The no-actor recovery flow (Codex review, P1-001, second
    // iteration) routes the user through the switch interstitial
    // with the target pre-set. The interstitial MUST render the
    // commit form (not the unavailable surface) and name the
    // current/target workspaces truthfully so the user can
    // confirm before the Workspace becomes the actor.
    // The unavailable surface MUST fire only when `target` is
    // null — NOT when `actingWorkspace` is null.
    const unavailableCheckMatch = CLIENT_SWITCH_SOURCE.match(
      /if\s*\(\s*!target\s*\)\s*\{[\s\S]*?data-testid="switch-unavailable"/,
    );
    assert.ok(
      unavailableCheckMatch,
      "the unavailable surface MUST fire when target is null — NOT when actingWorkspace is null (P1-001 second iteration)",
    );
    assert.equal(
      /if\s*\(\s*!actingWorkspace\s*\|\|\s*!target\s*\)/.test(CLIENT_SWITCH_SOURCE),
      false,
      "the unavailable check MUST NOT short-circuit on actingWorkspace === null (P1-001 second iteration)",
    );
    // The "Currently acting as" card MUST render a truthful
    // "(none)" placeholder + a recovery-specific explanatory
    // paragraph when actingWorkspace is null.
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /actingWorkspace\s*\?\s*actingWorkspace\.name\s*:\s*["']\(none\)["']/,
      'the current-acting card MUST render "(none)" when actingWorkspace is null so the user sees truthful context',
    );
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /workspace-switch-current-unset/,
      "the no-actor case MUST surface an explanatory testid so the recovery is a11y-targetable",
    );
  });
});
