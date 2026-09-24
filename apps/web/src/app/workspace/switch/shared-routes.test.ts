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

describe("M2 #83: deep-link switch target lookup — Active-only gate", () => {
  // Background: a deep link to `/workspace/switch?target=<id>` must
  // NEVER render the `Switch and continue` button for a Suspended
  // or non-Active target. The promotion effect (which sets
  // `pendingTarget` from a query parameter when no pending target
  // is present) already enforces the Active gate; the fallback
  // target lookup (used when the buyer lands directly on the page
  // without an explicit selector click) MUST apply the same gate.
  // Otherwise the page would show a commit button for a target
  // the server refuses to switch to, then silently no-op.

  test('the fallback target lookup filters by `workspaceStatus === "Active"`', () => {
    // The `useMemo` body for `target` is the second such block in
    // the file (the first block is for `queryReturnTo`). We pin the
    // Active-only filter inside that block so a regression that
    // drops the gate fails the suite.
    const targetMemoMatch = CLIENT_SWITCH_SOURCE.match(
      /const\s+target\s*=\s*useMemo\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[\s*pendingTarget\s*,\s*queryTargetId\s*,\s*user\s*\]\s*\)/,
    );
    assert.ok(targetMemoMatch, "the page MUST define a target useMemo");
    assert.match(
      targetMemoMatch[0],
      /workspaceStatus\s*===\s*["']Active["']/,
      'the fallback target lookup MUST filter by `workspaceStatus === "Active"` so a deep link to a Suspended target cannot render the commit button',
    );
    assert.match(
      targetMemoMatch[0],
      /user\.workspaces\.find\s*\(/,
      "the fallback target lookup MUST resolve via `user.workspaces.find(...)` so an inaccessible target returns null",
    );
  });

  test("the page renders the unavailable surface when `target` is null and never the commit button", () => {
    // `target === null` is the documented unavailable-state signal.
    // The page must render the `switch-unavailable` surface AND
    // never the `workspace-switch-continue` button in that branch.
    // There are two `switch-back-to-dashboard` buttons in the
    // source (the signed-out branch + the unavailable branch) — we
    // locate the unavailable branch by anchoring on its
    // `!actingWorkspace || !target` guard and capture only the
    // body up to the matching closing brace of the rendered JSX
    // root (which contains the explicit dashboard action).
    const unavailableBranchMatch = CLIENT_SWITCH_SOURCE.match(
      /if\s*\(\s*!actingWorkspace\s*\|\|\s*!target\s*\)\s*\{[\s\S]*?data-testid="switch-unavailable"[\s\S]*?Return to dashboard[\s\S]*?\}\s*\}/,
    );
    assert.ok(
      unavailableBranchMatch,
      "the page MUST render the `switch-unavailable` surface when `target` is null with a `Return to dashboard` recovery action",
    );
    // The unavailable branch must NOT contain the commit button
    // — its action surface is the `switch-back-to-dashboard`
    // button only.
    assert.ok(
      !unavailableBranchMatch[0].includes("workspace-switch-continue"),
      "the unavailable branch MUST NOT render the `Switch and continue` button",
    );
    assert.ok(
      unavailableBranchMatch[0].includes("switch-back-to-dashboard"),
      "the unavailable branch MUST render the explicit `Return to dashboard` button so the buyer can recover without a silent no-op",
    );
  });
});
