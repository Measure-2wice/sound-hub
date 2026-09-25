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

describe("Workspace-switch page — query-string re-sync behavior (M2 #83 visual-QA regression)", () => {
  // Visual QA caught a P1 regression: after a switch attempt that
  // left `pendingTargetId` set (selector click + browser-back, or
  // selector click + dashboard deep-link before commit settled), a
  // follow-up navigation to `/workspace/switch?target=<other>` kept
  // rendering the stale pending target as "Switch to:". The
  // root cause was a `if (pendingTargetId !== null) return;` short-
  // circuit inside the promotion effect — the effect only re-synced
  // `pendingTargetId` from the URL when the in-memory value was
  // empty. These source-pattern assertions pin the new behavior so
  // the gate cannot silently revert to the null-only check.
  test("promotion effect does NOT short-circuit when pendingTargetId is non-null; it must compare against the resolved candidate", () => {
    // The original gate `if (pendingTargetId !== null) return;` is
    // the precise cause of the regression. A regression that
    // re-introduces it (or any equivalent like `if (pendingTarget)`
    // — note `pendingTarget` is the resolved Workspace, not the id,
    // so the gate would still be wrong) must fail this assertion.
    assert.equal(
      /if\s*\(\s*pendingTargetId\s*!==\s*null\s*\)\s*return\s*;/.test(CLIENT_SWITCH_SOURCE),
      false,
      "promotion effect MUST NOT short-circuit on pendingTargetId !== null; it must re-sync whenever pendingTargetId !== candidate.workspaceId",
    );
    // The replacement gate MUST compare `pendingTargetId` against
    // the resolved `candidate.workspaceId` so a stale id from a
    // previous uncommitted switch can be overwritten.
    assert.match(
      CLIENT_SWITCH_SOURCE,
      /pendingTargetId\s*[!=]==\s*candidate\.workspaceId/,
      "the promotion effect MUST compare pendingTargetId against the resolved candidate.workspaceId",
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

  test("target memo prefers the URL candidate over pendingTarget when the URL resolves to a valid Active Workspace", () => {
    // The memo MUST consult the URL target first when it resolves
    // to a valid Active Workspace, so the first render matches the
    // URL even before the re-sync effect catches up. Otherwise the
    // page flashes the wrong "Switch to:" card for one render.
    // Pin by anchoring on the `target` useMemo body and asserting
    // the URL-candidate lookup appears BEFORE the pendingTarget
    // fallback.
    const memoBodyMatch = CLIENT_SWITCH_SOURCE.match(
      /const target = useMemo\(\(\) => \{[\s\S]*?return null;\s*\}, \[pendingTarget, queryTargetId, user\]\);/,
    );
    assert.ok(memoBodyMatch, "the target useMemo block must be present in the switch page");
    const memoBody = memoBodyMatch[0];
    const queryCandidateIndex = memoBody.search(/queryCandidate/);
    const pendingTargetFallbackIndex = memoBody.search(
      /if\s*\(\s*pendingTarget\s*\)\s*return pendingTarget/,
    );
    assert.ok(
      queryCandidateIndex >= 0,
      "target memo MUST consult the URL candidate (queryCandidate) when it resolves",
    );
    assert.ok(
      pendingTargetFallbackIndex >= 0,
      "target memo MUST still fall back to pendingTarget when the URL has no valid candidate",
    );
    assert.ok(
      queryCandidateIndex < pendingTargetFallbackIndex,
      "target memo MUST prefer the URL candidate over pendingTarget so the first render matches the URL",
    );
  });
});
