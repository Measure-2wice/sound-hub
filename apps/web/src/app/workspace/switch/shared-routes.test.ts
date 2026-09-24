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
