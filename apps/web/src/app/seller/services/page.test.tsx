/* eslint-disable @typescript-eslint/no-floating-promises */
// ServiceOffering listing page (M2 #85 entry-flow manual-QA) tests.
//
// The M2 (#85) acceptance criterion and the manual-QA finding both
// require that the #85 ServiceOffering management surface is the
// primary destination for "Your services". Source-pattern assertions
// pin the listing page so a future refactor cannot:
//
//   - Re-point the empty-state copy back at the legacy audio page
//     (`/dashboard/audio`).
//   - Drop the "Create service" affordance from the empty state, so
//     a user with zero offerings cannot reach the lazy-first-save
//     editor (`/seller/services/new/edit`).
//   - Navigate away from the listing on `handleCreate` (the button
//     must always navigate to the editor's "new" path WITHOUT a
//     server call — the durable row is created on the first Save).
//   - Silently pre-create an empty ServiceOffering on listing mount
//     (the editor's POST /draft is gated behind the user's explicit
//     Save, not on page navigation).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SERVICES_PAGE_SOURCE = readFileSync(
  `${new URL(".", import.meta.url).pathname}page.tsx`,
  "utf8",
);

const EDIT_PAGE_SOURCE = readFileSync(
  `${new URL("./[offeringId]/edit/", import.meta.url).pathname}page.tsx`,
  "utf8",
);

const EDITOR_POST_DRAFT_BODY = (() => {
  // The editor's `performSave` calls `createServiceOfferingDraft`
  // only inside the `if (!offeringId || offeringId === "new")`
  // branch, which is reached exclusively from the `handleSave` click
  // handler. The function body MUST be reachable only through the
  // Save button — never through a mount / boot effect. The source
  // pattern below extracts that branch.
  const match = EDIT_PAGE_SOURCE.match(
    /if\s*\(\s*!offeringId\s*\|\|\s*offeringId\s*===\s*["']new["']\s*\)\s*\{[\s\S]*?createServiceOfferingDraft[\s\S]*?\}/,
  );
  return match ? match[0] : "";
})();

describe("seller/services listing page (M2 #85 entry-flow manual-QA)", () => {
  test("the listing page is the M2 (#85) ServiceOffering management surface", () => {
    // The page renders the heading "Your services" — the same
    // label the Shell nav uses — so the navigation destination and
    // the destination page agree.
    assert.match(
      SERVICES_PAGE_SOURCE,
      />\s*Your services\s*</,
      "listing page must render the 'Your services' heading that the Shell nav destination advertises",
    );
  });

  test("the listing page exposes a stable `services-list-create` CTA in the empty state", () => {
    // The empty-state CTA MUST live in the page (a button whose
    // testid is `services-list-create`) so a Seller with zero
    // offerings always has a reachable path into the #85 flow.
    assert.match(
      SERVICES_PAGE_SOURCE,
      /data-testid="services-list-create"/,
      "listing page must expose a stable services-list-create testid on the empty-state CTA",
    );
    assert.match(
      SERVICES_PAGE_SOURCE,
      /services-list-create[\s\S]{0,400}>[\s\S]*?Create\s*service/i,
      "the empty-state CTA MUST be labelled 'Create service'",
    );
  });

  test("handleCreate navigates to the #85 lazy-first-save editor without a server call", () => {
    // M2 (#85) acceptance criterion: empty editor navigation alone
    // must NOT create a durable ServiceOffering row. The handleCreate
    // action navigates the user to the editor's "new" path and does
    // NOT invoke createServiceOfferingDraft — the durable row is
    // created on the first Save inside the editor.
    assert.match(
      SERVICES_PAGE_SOURCE,
      /router\.push\(\s*["']\/seller\/services\/new\/edit["']\s*\)/,
      "handleCreate MUST navigate to /seller/services/new/edit (the lazy-first-save editor)",
    );
    // The listing page MUST NOT import or call createServiceOfferingDraft.
    assert.equal(
      /createServiceOfferingDraft/.test(SERVICES_PAGE_SOURCE),
      false,
      "listing page MUST NOT call createServiceOfferingDraft; the row is created on the editor's first Save",
    );
  });

  test("the empty-state copy does NOT direct users to the legacy audio page", () => {
    // The empty state MUST instruct the user to use the in-page
    // Create service CTA, not the legacy /dashboard/audio route.
    assert.match(
      SERVICES_PAGE_SOURCE,
      /data-testid="services-list-empty"[\s\S]{0,400}Click\s*["']?Create\s*service["']?/i,
      "empty state must reference the visible 'Create service' CTA, not the legacy audio page",
    );
    assert.equal(
      /\/dashboard\/audio/.test(SERVICES_PAGE_SOURCE),
      false,
      "listing page must not surface the legacy /dashboard/audio route as the ServiceOffering destination",
    );
  });

  test("the editor's POST /draft is gated behind explicit Save, never on mount", () => {
    // M2 (#85) acceptance criterion + manual-QA finding: navigating
    // to the editor with `offeringId === "new"` MUST NOT create a
    // durable ServiceOffering row. The createServiceOfferingDraft
    // call site must live ONLY inside the !offeringId branch of
    // performSave (which is invoked from the Save button), and MUST
    // NOT appear in any useEffect / on-mount handler.
    assert.ok(
      EDITOR_POST_DRAFT_BODY.length > 0,
      "expected to locate the createServiceOfferingDraft call site inside the 'new' branch of performSave",
    );
    // Strip the call site block out of the editor source and verify
    // nothing else invokes createServiceOfferingDraft.
    const sourceWithoutCallSite = EDIT_PAGE_SOURCE.replace(EDITOR_POST_DRAFT_BODY, "");
    assert.equal(
      /createServiceOfferingDraft/.test(sourceWithoutCallSite),
      false,
      "createServiceOfferingDraft must be called from EXACTLY ONE site — the 'new' branch of performSave — and never from mount / useEffect",
    );
  });

  test("the listing page never navigates to the legacy audio surface", () => {
    // Pin the legacy /dashboard/audio route so the next refactor
    // cannot silently re-introduce the old discovery-samples
    // destination as a primary ServiceOffering entry.
    assert.equal(
      /\/dashboard\/audio/.test(SERVICES_PAGE_SOURCE),
      false,
      "listing page must not link to /dashboard/audio; the #85 surface is the only entry",
    );
  });
});
