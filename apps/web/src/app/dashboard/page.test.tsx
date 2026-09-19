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
});
