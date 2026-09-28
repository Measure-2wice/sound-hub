/* eslint-disable @typescript-eslint/no-floating-promises */
// Phase 2 #85 ServiceOffering visual reconciliation tests.
//
// Background: manual QA of the #85 ServiceOffering editor surfaced
// gaps against the Stitch `soundhub_edit_your_service_{desktop,mobile}`
// exports. Phase 2 closes those gaps WITHOUT changing domain/API
// behavior (no service offering persistence, lifecycle, activation,
// audio privacy, idempotency, or DTO changes). These tests pin the
// presentation-only fixes:
//
//   - Human-facing enum labels (InPerson → In person,
//     StartingAt → Starting at, ContactForQuote → Contact for quote).
//     The serialized API values are unchanged.
//   - Distinct section/card hierarchy with stable section anchor ids
//     matching the desktop and mobile Stitch navigation.
//   - Save draft and Activate service remain visually and
//     semantically distinct.
//   - No regression to the lazy-first-save contract (creating an
//     offering only on the editor's first Save).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const EDIT_PAGE_SOURCE = readFileSync(
  // import.meta.url encodes the literal `[` / `]` characters as
  // %5B / %5D, but the filesystem path uses the literal brackets.
  // `fileURLToPath` decodes them back so the readFileSync resolves
  // against the real on-disk editor file.
  fileURLToPath(new URL("page.tsx", import.meta.url)),
  "utf8",
);

describe("service-offering editor — Phase 2 visual reconciliation (#85)", () => {
  test("exposes human-facing display labels for the InPerson / StartingAt / ContactForQuote enums", () => {
    // Presentation-only labels. The serialized API enum values
    // (`InPerson`, `StartingAt`, `ContactForQuote`, `Fixed`) MUST
    // still be the underlying radio `value`s; only the visible
    // text changes for the seller.
    assert.match(
      EDIT_PAGE_SOURCE,
      /InPerson:\s*"In person"/,
      "SERVICE_MODE_LABEL must map InPerson → 'In person' (no longer the raw enum identifier)",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /StartingAt:\s*"Starting at"/,
      "PRICING_KIND_LABEL must map StartingAt → 'Starting at'",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /ContactForQuote:\s*"Contact for quote"/,
      "PRICING_KIND_LABEL must map ContactForQuote → 'Contact for quote'",
    );
  });

  test("renders six stable, anchorable section ids matching the Stitch section index", () => {
    // The desktop sidebar and mobile jump anchor to these ids; a
    // refactor that removes or renames them will silently break
    // section navigation.
    for (const id of [
      "section-overview",
      "section-delivery",
      "section-pricing",
      "section-work-samples",
      "section-optional",
      "section-activation",
    ]) {
      assert.match(
        EDIT_PAGE_SOURCE,
        new RegExp(`["']${id}["']`),
        `editor must declare section anchor id '${id}' for sidebar / mobile-jump navigation`,
      );
    }
  });

  test("renders a desktop section index and a mobile section jump", () => {
    // Desktop sidebar nav (>= lg).
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-section-nav"/,
      "desktop section index must expose a stable testid for visual-QA selectors",
    );
    // Mobile jump button (< lg).
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-mobile-section-jump"/,
      "mobile section jump must expose a stable testid for visual-QA selectors",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /aria-controls="service-offering-edit-section-menu"/,
      "mobile jump button must control the section-menu nav by id",
    );
  });

  test("keeps Save draft and Activate service visually and semantically distinct", () => {
    // Two distinct buttons, two distinct colors (aubergine save,
    // coral activate per the M2 marketplace-progression palette
    // rule), two distinct testids, and the explicit Activate
    // confirmation path is preserved.
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-save-draft"[\s\S]{0,800}>[\s\S]{0,80}Save draft/,
      "Save draft must render with its own testid and visible 'Save draft' label",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-activate"[\s\S]{0,800}>[\s\S]{0,80}Activate service/,
      "Activate service must render with its own testid and visible 'Activate service' label",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /bg-aubergine[\s\S]{0,200}data-testid="service-offering-edit-save-draft"|data-testid="service-offering-edit-save-draft"[\s\S]{0,200}bg-aubergine/,
      "Save draft button must use the aubergine save color",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /bg-coral[\s\S]{0,200}data-testid="service-offering-edit-activate"|data-testid="service-offering-edit-activate"[\s\S]{0,200}bg-coral/,
      "Activate service button must use the coral marketplace-progression color",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-activate-confirm"/,
      "Activate service must remain an explicit confirmation surface",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /testId: "service-offering-edit-activate-confirm-button"|data-testid="service-offering-edit-activate-confirm-button"/,
      "Activate confirmation must keep its own confirm button testid",
    );
    // Activate is gated by `canActivate`; Save is not.
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-activate"[\s\S]{0,1200}disabled=\{[\s\S]{0,120}!canActivate|disabled=\{[\s\S]{0,120}!canActivate[\s\S]{0,800}data-testid="service-offering-edit-activate"/,
      "Activate service button must be disabled when readiness is incomplete",
    );
  });

  test("keeps explicit-save feedback (no autosave claim) in the editor header", () => {
    // The phase 2 visual reconciliation adds a header save-status
    // row. It must NEVER claim autosave / continuous sync.
    assert.match(
      EDIT_PAGE_SOURCE,
      /Draft saved explicitly/,
      "header must surface the explicit-save confirmation string the seller already trusts",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /Changes save only when you choose Save draft/,
      "header must tell the seller that nothing saves without an explicit click",
    );
  });

  test("preserves the lazy-first-save contract: createServiceOfferingDraft is gated behind explicit Save only", () => {
    // The fix from M2 (#85) PR-review feedback (round 3) must not
    // regress: opening the editor with offeringId === "new" must
    // NOT create a durable ServiceOffering row. The
    // createServiceOfferingDraft call site must remain inside the
    // `if (!offeringId || offeringId === "new")` branch of
    // performSave and must NOT be invoked by any useEffect or
    // on-mount handler.
    const inPerformSave = /performSave[\s\S]{0,4000}createServiceOfferingDraft/.test(
      EDIT_PAGE_SOURCE,
    );
    assert.ok(inPerformSave, "createServiceOfferingDraft must be reachable only from performSave");
    // No useEffect body must INVOKE the call (an `await
    // createServiceOfferingDraft(` would be a regression).
    // Pin the absence of an `await createServiceOfferingDraft` /
    // `= createServiceOfferingDraft` / `createServiceOfferingDraft(`
    // call inside a useEffect block.
    assert.equal(
      /useEffect\([\s\S]{0,3000}createServiceOfferingDraft\(\{/.test(EDIT_PAGE_SOURCE),
      false,
      "createServiceOfferingDraft must not be invoked from any useEffect body",
    );
    // The call site remains in performSave's `new`-branch.
    assert.match(
      EDIT_PAGE_SOURCE,
      /if\s*\(\s*!offeringId\s*\|\|\s*offeringId\s*===\s*["']new["']\s*\)\s*\{[\s\S]{0,400}createServiceOfferingDraft\(\{/,
      "performSave's !offeringId branch must be the call site for createServiceOfferingDraft",
    );
  });

  test("exposes a profile-identity context chip in the editor header", () => {
    // The Stitch desktop intent surfaces a "Profile identity" chip
    // beside the editor header. Phase 2 preserves that without
    // changing the acting-workspace model.
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-profile-identity"[\s\S]{0,800}Profile identity/,
      "editor header must surface the acting-Workspace identity chip for the seller",
    );
  });

  test("exposes a draft-status pill (Private draft / Available) with both icon and text", () => {
    // Status treatment must never depend on color alone per the M2
    // UX addendum.
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-status"[\s\S]{0,1000}"Private draft"|"Available"/,
      "status pill must render either the 'Private draft' or 'Available' text alongside the icon",
    );
  });

  test("renders the activation readiness section with honest complete / pending rows", () => {
    // The activation readiness section must use semantic
    // data-testids so manual-QA can verify the readiness state.
    // The ReadinessRow component lower-cases the title and slugifies
    // it, so we pin the helper definition plus the visible row
    // titles it receives.
    assert.match(
      EDIT_PAGE_SOURCE,
      /service-offering-edit-readiness-\$\{title[\s\S]{0,200}replace\(/,
      "ReadinessRow must produce a stable readiness-row testid from the title",
    );
    for (const title of [
      "Title and description entered",
      "Primary category selected",
      "Delivery mode defined",
      "Pricing configured",
    ]) {
      assert.match(
        EDIT_PAGE_SOURCE,
        new RegExp(`title="${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
        `activation readiness must include a row titled '${title}'`,
      );
    }
    // The readiness banner must honestly state either "Ready to
    // activate" or "Not yet ready to activate".
    assert.match(
      EDIT_PAGE_SOURCE,
      /Ready to activate|Not yet ready to activate/,
      "activation readiness must include a clear ready/pending banner",
    );
  });

  test("preserves the existing field / error testids (no regression to lazy first-save or the linked error summary)", () => {
    // Existing Playwright / source-pattern assertions rely on
    // these testids remaining stable.
    for (const id of [
      "service-offering-edit-input-title",
      "service-offering-edit-input-description",
      "service-offering-edit-input-category",
      "service-offering-edit-input-amount",
      "service-offering-edit-input-unit",
      "service-offering-edit-input-service-area-country",
      "service-offering-edit-sample-upload-form",
      "service-offering-edit-sample-submit",
      "service-offering-edit-sample-confirmation",
    ]) {
      assert.match(
        EDIT_PAGE_SOURCE,
        new RegExp(`data-testid="${id}"`),
        `editor must continue to expose data-testid='${id}'`,
      );
    }
    // The ErrorSummary component receives the testid as a prop;
    // pin the wired value rather than the JSX attribute.
    assert.match(
      EDIT_PAGE_SOURCE,
      /testId="service-offering-edit-error-summary"/,
      "editor must continue to wire the linked error summary's testid",
    );
  });

  test("does not introduce a wizard or change the buildDraftPayload payload shape", () => {
    // Phase 2 is presentation-only. The single-page editor surface
    // must remain a single page (no "next step" wizard buttons),
    // and no new persistent fields appear.
    assert.equal(
      /Next step|Continue to step/i.test(EDIT_PAGE_SOURCE),
      false,
      "editor must not become a wizard — the existing single-page editor shape is preserved",
    );
    // The existing buildDraftPayload payload keys remain exactly
    // the contract-approved set.
    for (const key of [
      "title",
      "description",
      "primaryCategoryKey",
      "serviceMode",
      "pricing",
      "genreTags",
      "idempotencyKey",
    ]) {
      assert.match(
        EDIT_PAGE_SOURCE,
        new RegExp(`\\b${key}\\b`),
        `existing draft payload field '${key}' must remain present in buildDraftPayload`,
      );
    }
  });

  test("renders no Material Symbols ligature names as visible text", () => {
    // Phase 2 #85 Manual QA Round 2 — Finding 1: the app's
    // Material Symbols font is NOT loaded, so every
    // `material-symbols-outlined` span fell back to its ligature
    // text (e.g. literal `arrow_back`, `cloud_done`,
    // `radio_button_unchecked`). The fix removes every
    // `material-symbols-outlined` reference in the editor +
    // SaveDraftActions and replaces them with inline SVG icons
    // (or removes decorative glyphs that duplicate the adjacent
    // text). No ligature name may appear as visible text.
    assert.equal(
      /material-symbols-outlined/.test(EDIT_PAGE_SOURCE),
      false,
      "editor must not reference material-symbols-outlined (the icon font is not loaded)",
    );
    // None of the historical ligature names may appear as bare
    // string content (the previous source had each ligature as
    // the text content of a `<span className="material-symbols-outlined">`).
    const forbiddenLigatures = [
      "arrow_back",
      "cloud_done",
      "wifi",
      "domain",
      "sync_alt",
      "check_circle",
      "pending",
      "radio_button_unchecked",
      "save",
      "arrow_forward",
      "verified",
      "expand_more",
      "info",
      "lock",
      "close",
      "cloud_off",
      "cloud",
      "sync",
    ];
    for (const lig of forbiddenLigatures) {
      assert.equal(
        new RegExp(`>${lig}<`).test(EDIT_PAGE_SOURCE),
        false,
        `editor must not render the literal ligature '${lig}' as visible text`,
      );
    }
    // The editor imports the inline SVG Icon module instead.
    assert.match(
      EDIT_PAGE_SOURCE,
      /from ["']\.\.\/\.\.\/\.\.\/\.\.\/components\/ui\/Icon["']/,
      "editor must import the inline SVG Icon module",
    );
    // SaveDraftActions (a shared component) must no longer
    // reference the icon font either.
    const SAVE_DRAFT_ACTIONS_SOURCE = readFileSync(
      fileURLToPath(new URL("../../../../components/SaveDraftActions.tsx", import.meta.url)),
      "utf8",
    );
    assert.equal(
      /material-symbols-outlined/.test(SAVE_DRAFT_ACTIONS_SOURCE),
      false,
      "SaveDraftActions must not reference material-symbols-outlined (the icon font is not loaded)",
    );
  });

  test("resumed-draft editor does not say 'Draft not saved yet'", () => {
    // Phase 2 #85 Manual QA Round 3 — save-status fidelity.
    // Manual QA found that opening an already-persisted Draft
    // (e.g. /seller/services/<id>/edit after a first Save + nav)
    // still rendered the header "Draft not saved yet · Changes
    // save only when you choose Save draft." The status row must
    // distinguish a *new* (never-saved) editor from a *resumed*
    // draft, and from a dirty edit of a resumed draft. The
    // implementation captures a baseline from the persisted
    // ServiceOffering row at bootstrap and after every
    // successful Save, then compares the live form to that
    // baseline to derive `hasPersistedDraft` and `isDirty`.
    assert.match(
      EDIT_PAGE_SOURCE,
      /draftBaseline/,
      "editor must capture a draftBaseline snapshot for save-status fidelity",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /snapshotFromOffering/,
      "editor must build the baseline directly from the ServiceOffering response (not from form state)",
    );
    // The status row must branch on `hasPersistedDraft` /
    // `isDirty` — it cannot unconditionally render "Draft not
    // saved yet".
    assert.match(
      EDIT_PAGE_SOURCE,
      /hasPersistedDraft[\s\S]{0,400}Draft saved/,
      "save-status row must render 'Draft saved' for resumed drafts that have no unsaved edits",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /isDirty[\s\S]{0,400}Unsaved changes/,
      "save-status row must render 'Unsaved changes' for resumed drafts the seller has edited",
    );
    // The new-editor fallback ("Draft not saved yet") must NOT be
    // the unconditional default: it must be reachable only when
    // `!hasPersistedDraft` (i.e. zero baseline). We pin that the
    // conditional chain ends with the never-persisted fallback.
    assert.match(
      EDIT_PAGE_SOURCE,
      /hasPersistedDraft\s*\?\s*"Draft saved"\s*:\s*"Draft not saved yet"/,
      "save-status row must reserve 'Draft not saved yet' for the new-editor path only",
    );
  });

  test("new-editor path still surfaces 'Draft not saved yet' before first Save", () => {
    // The Round 3 fix must NOT regress the original explicit-
    // save guarantee: opening /seller/services/new/edit with no
    // prior offering must show "Draft not saved yet" so the
    // seller understands nothing has been persisted yet.
    assert.match(
      EDIT_PAGE_SOURCE,
      /Draft not saved yet/,
      "new-editor header must still surface 'Draft not saved yet' before the first Save",
    );
    // The baseline must start unset (null) so the
    // `hasPersistedDraft` branch picks the never-saved fallback.
    assert.match(
      EDIT_PAGE_SOURCE,
      /useState<DraftFieldsSnapshot \| null>\(null\)/,
      "draftBaseline must be initialized to null (never persisted) on first render",
    );
  });

  test("existing persisted draft values still hydrate correctly on resume", () => {
    // Lazy-first-save + resume round-trip: opening an existing
    // ServiceOffering must hydrate title / description / category
    // / service mode / service area / pricing / pricingAmount /
    // pricingUnit / genreTags from the API response, AND capture
    // the baseline. The Round 3 fix must not regress the
    // original hydration path (which the prior PR rounds pinned).
    const hydrateCalls = [
      /setTitle\(o\.title\)/,
      /setDescription\(o\.description\)/,
      /setPrimaryCategoryKey\(o\.primaryCategoryKey\)/,
      /setServiceMode\(o\.serviceMode\)/,
      /setServiceAreaCountry\(o\.serviceAreas\[0\]\.countryCode\)/,
      /setPricingKind\(o\.pricing\.kind\)/,
      // Phase 2 #85 Manual QA Round 9 — pricing unit hydration
      // bug. The editor's pricing-unit <select value={pricingUnit}>
      // matches `taxonomy.pricingUnits[i].key`, so the resume
      // path must hydrate `pricingUnit` from `o.pricing.unitId`.
      // The Round 9 API fix surfaces the public `PricingUnit.key`
      // (not the internal FK cuid) in `unitId`, so this
      // hydration call now lands the public key in local React
      // state and the <option value={u.key}> matches.
      /setPricingUnit\(o\.pricing\.unitId\)/,
      /setGenreTags\(\[\.\.\.o\.genreTags\]\)/,
    ];
    for (const call of hydrateCalls) {
      assert.match(EDIT_PAGE_SOURCE, call, `existing-path hydration must call ${call.source}`);
    }
    // The baseline capture must happen on the same bootstrap
    // path (i.e. after the hydration setState calls).
    assert.match(
      EDIT_PAGE_SOURCE,
      /setTitle\(o\.title\)[\s\S]{0,2000}setDraftBaseline\(snapshotFromOffering\(o\)\)/,
      "resume bootstrap must capture the baseline immediately after hydrating the fields",
    );
  });

  test("editor <audio> uses crossOrigin='use-credentials' so the HttpOnly session cookie rides the cross-origin media fetch", () => {
    // Phase 2 #85 Manual QA Round 4 — private audio playback.
    // Without `crossorigin="use-credentials"` on the `<audio>`
    // element the browser strips the HttpOnly session cookie
    // from the cross-origin media fetch to the API origin, the
    // owner-side `/play` route returns SESSION_INVALID, and the
    // browser raises `Runtime NotSupportedError`. Pin the
    // camelCase React form (`crossOrigin="use-credentials"`) on
    // the per-sample `<audio>` element so the cookie rides the
    // request.
    assert.match(
      EDIT_PAGE_SOURCE,
      /<audio[\s\S]{0,1500}crossOrigin="use-credentials"/,
      "editor <audio> must set crossOrigin='use-credentials' so the HttpOnly session cookie is sent to the cross-origin API",
    );
  });

  test("editor <audio> registers an onError handler that surfaces a graceful inline message", () => {
    // The `<audio>` element must call `markSamplePlaybackFailure`
    // (or equivalent) on its `onError` so a CORP/CORS/auth/network
    // failure renders a clean inline alert instead of an uncaught
    // runtime error, an unhandled Promise rejection, or a Next.js
    // dev-overlay red box. The element stays mounted (the
    // controls remain tabbable) but the failure message below it
    // is the authoritative affordance.
    assert.match(
      EDIT_PAGE_SOURCE,
      /service-offering-edit-sample-player"[\s\S]{0,1500}onError=/,
      "editor <audio> must attach an onError handler",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /service-offering-edit-sample-player-error/,
      "editor must render a fallback message via testid service-offering-edit-sample-player-error",
    );
  });

  test("post-activation readiness banner is suppressed when offering.status === 'Active' (no Draft readiness copy on a live service)", () => {
    // Phase 2 #85 Manual QA Round 5 — post-activation
    // truthfulness. The previous readiness banner was driven by
    // `canActivate` alone, so an `Active` service rendered
    // "Not yet ready to activate" on top of "Every requirement
    // row is READY". The fix gates the readiness banner on
    // `!isActive` so an `Active` offering (or any post-Draft
    // lifecycle) never sees the Draft-readiness affirmation or
    // negation.
    assert.match(
      EDIT_PAGE_SOURCE,
      /isActive\s*=\s*offering\?\.status\s*===\s*["']Active["']/,
      "editor must derive isActive from offering?.status BEFORE any early return",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /service-offering-edit-readiness-banner"[\s\S]{0,4000}!isActive\s*\?\s*\([\s\S]{0,200}\)/,
      "the readiness banner must be gated on !isActive (suppressed post-activation)",
    );
  });

  test("post-activation header description renders the live copy when offering.status === 'Active'", () => {
    // The previous header description unconditionally claimed the
    // service was "private until you activate it" with "Buyers
    // cannot see this service in search or send project
    // requests" — false on an `Active` offering. The header
    // now branches on `isActive` and the new copy is exposed
    // via data-testid "service-offering-edit-active-description"
    // so manual QA can verify the live copy.
    assert.match(
      EDIT_PAGE_SOURCE,
      /isActive\s*\?\s*\([\s\S]{0,400}service-offering-edit-active-description/,
      "header description must surface isActive branch + active-description testid",
    );
    assert.doesNotMatch(
      EDIT_PAGE_SOURCE,
      /isActive[\s\S]{0,200}Buyers cannot see this service in[\s\S]{0,400}service-offering-edit-active-description/,
      "private/Buyers-cannot-see copy must NOT be in the isActive branch",
    );
  });

  test("post-activation persistent 'Service activated' banner renders the persisted activatedAt timestamp", () => {
    // The transient `showActivateSummary` alert only fires during
    // the in-session activate response. After a refresh the
    // transient state is gone but the offering's persisted
    // `activatedAt` is still there — the page must surface that
    // timestamp too, sourced from the ServiceOfferingOwnerViewV1
    // `activatedAt` field (not invented).
    assert.match(
      EDIT_PAGE_SOURCE,
      /service-offering-edit-active-banner[\s\S]{0,400}offering\?\.activatedAt/,
      "active-banner must source its activation timestamp from offering.activatedAt (persisted field, not invented)",
    );
  });

  test("Draft + complete / incomplete requirements still renders the readiness banner (no regression)", () => {
    // The readiness banner text and the per-requirement list
    // must remain reachable for Draft offerings so an
    // incomplete Draft still surfaces an honest
    // "Not yet ready to activate" and a complete Draft still
    // surfaces an honest "Ready to activate".
    assert.match(
      EDIT_PAGE_SOURCE,
      /Ready to activate|Not yet ready to activate/,
      "Draft-only readiness banner copy must remain reachable",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /"Title and description entered"|"Primary category selected"|"Delivery mode defined"|"Pricing configured"/,
      "Draft readiness per-requirement rows must remain reachable",
    );
  });

  test("Save draft and Activate service action bar is absent when offering.status === 'Active'", () => {
    // The previous QA round pinned that `data-testid="service-offering-edit-save-draft"`
    // and `data-testid="service-offering-edit-activate"` are NOT
    // present on an Active offering. Pin the existing
    // gate against `offering?.status !== "Active"` so a future
    // regression that re-introduces a Save/Activate action bar
    // on a live service fails this suite.
    assert.match(
      EDIT_PAGE_SOURCE,
      /offering\?\.status\s*!==\s*["']Active["']/,
      "action bar must still gate Save + Activate on offering?.status !== 'Active'",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /service-offering-edit-save-draft/,
      "Save draft testid must remain reachable from the NOT-Active branch",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /service-offering-edit-activate/,
      "Activate service testid must remain reachable from the NOT-Active branch",
    );
  });

  test("Profile identity chip sources the published Professional Profile name when available", () => {
    // Phase 2 #85 Manual QA Round 2 — Finding 3: the header chip
    // previously showed the acting Workspace name (e.g.
    // `My Workspace`), which was misleading because the chip is
    // labelled `PROFILE IDENTITY`. The fix fetches the seller's
    // Professional Profile alongside the offering bootstrap and
    // surfaces `identity.professionalName` when present. The
    // acting-Workspace name remains as an honest screen-reader
    // announcement, not as the visible text.
    assert.match(
      EDIT_PAGE_SOURCE,
      /fetchSellerProfile\(\{[\s\S]{0,200}workspaceId: actingWorkspace\.workspaceId/,
      "editor must fetch the Professional Profile alongside the offering bootstrap",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /sellerProfile\?\.identity\?\.professionalName/,
      "editor must read the published Professional Profile name from identity.professionalName",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-profile-identity-name"[\s\S]{0,400}professionalName/,
      "visible chip text must be the Professional Profile name (not the acting Workspace name)",
    );
    // The chip must announce the acting-Workspace name to
    // assistive technology so screen readers still surface the
    // Workspace context the seller is acting under.
    assert.match(
      EDIT_PAGE_SOURCE,
      /sr-only[\s\S]{0,400}Acting Workspace/,
      "profile identity chip must announce the acting Workspace via sr-only text",
    );
  });

  test("desktop section rail renders truthful 'Activation' / 'Available' copy when offering.status === 'Active' (no 'Ready to activate' on a live service)", () => {
    // Phase 2 #85 Manual QA Round 6 — final post-activation copy
    // cleanup. The desktop sticky section index rendered a bottom
    // helper block ("Activation readiness / Ready to activate")
    // derived from `canActivateEarly` only, so an Active service
    // still showed "Ready to activate" even though the lifecycle
    // is already past that step and the requirements have been
    // acted on. The fix branches the rail's heading + value on
    // `isActive` so an Active offering renders
    // "Activation / Available" using existing product terminology
    // (the rail never invents Pause / re-activation behavior).
    // `isActive` is plumbed into `DesktopSectionNav` as a prop
    // because the rail is a stateless helper — the lifecycle
    // signal is sourced once (BEFORE any early return) and
    // threaded into both the rail and the bottom helper copy.
    assert.match(
      EDIT_PAGE_SOURCE,
      /function DesktopSectionNav\(\{[\s\S]{0,400}readonly isActive: boolean/,
      "DesktopSectionNav must accept an isActive prop so the rail can branch the bottom helper block on lifecycle",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /isActive\s*\?\s*["']Activation["']\s*:\s*["']Activation readiness["']/,
      "desktop rail heading must branch on isActive: 'Activation' for Active, 'Activation readiness' for Draft",
    );
    // The Active value MUST be the literal "Available" — the
    // canonical active-state summary already used by the editor's
    // status pill — and MUST be evaluated before the Draft
    // complete/pending chain so a live service never falls
    // through to "Ready to activate" / "Pending — see Activation
    // readiness".
    assert.match(
      EDIT_PAGE_SOURCE,
      /isActive\s*\?\s*["']Available["']\s*:\s*[\s\S]{0,200}["']Ready to activate["']/,
      "desktop rail value must branch on isActive with 'Available' first, then Draft complete/pending",
    );
  });

  test("desktop section rail preserves Draft 'Activation readiness' / 'Ready to activate' / 'Pending' copy (no regression)", () => {
    // The Round 6 fix must NOT regress the Draft presentation:
    // an incomplete Draft must still surface "Activation
    // readiness / Pending — see Activation readiness" and a
    // complete Draft must still surface "Activation readiness /
    // Ready to activate". The conditional still contains the
    // Draft strings; only the Active branch is new.
    assert.match(
      EDIT_PAGE_SOURCE,
      /isActive\s*\?\s*["']Activation["']\s*:\s*["']Activation readiness["']/,
      "Draft path of the rail heading must still render 'Activation readiness'",
    );
    assert.match(
      EDIT_PAGE_SOURCE,
      /["']Ready to activate["'][\s\S]{0,300}["']Pending — see Activation readiness["']/,
      "Draft complete/pending value pair must remain reachable in the rail",
    );
  });

  test("bottom helper copy presents truthful active-state copy when offering.status === 'Active' (no Save-draft / Activate-service future-action language on a live service)", () => {
    // Phase 2 #85 Manual QA Round 6 — final post-activation copy
    // cleanup. The footer paragraph previously described
    // activation as a future action unconditionally ("Save draft
    // preserves progress; Activate service makes this service
    // visible to buyers"), which is false on an Active offering
    // (and would also imply the rail's "Available" is wrong).
    // The fix branches the helper paragraph on `!isActive` and
    // surfaces truthful existing-terminology copy ("This service
    // is live and accepting ProjectRequests") on the isActive
    // branch — a single sentence that restates the persisted
    // lifecycle without inventing Pause / re-activation
    // semantics. Pause and re-activation remain out of scope
    // for #85.
    assert.match(
      EDIT_PAGE_SOURCE,
      /!isActive\s*\?\s*\([\s\S]{0,500}Save draft preserves progress[\s\S]{0,500}\)\s*:\s*\([\s\S]{0,300}live[\s\S]{0,200}accepting ProjectRequests/,
      "bottom helper copy must branch on !isActive: Draft path keeps Save/Activate helper, Active path renders truthful 'live and accepting ProjectRequests'",
    );
    // Pin the active-state helper string verbatim so a future
    // refactor that swaps the existing-terminology copy for
    // invented Pause / re-activation language fails this suite.
    assert.match(
      EDIT_PAGE_SOURCE,
      /This service is live and accepting ProjectRequests\./,
      "Active-state helper copy must restate the persisted lifecycle in existing product terminology",
    );
  });

  test("section-nav sidebar / mobile-jump item normalizes to 'Activation' for Active offerings (rail item name branches on lifecycle)", () => {
    // Phase 2 #85 Manual QA Round 7 — final active-state
    // truthfulness. The `sectionNavEarly` derivation feeds both
    // the desktop sidebar nav row and the mobile section-jump
    // items, so the rename to `name: isActive ? "Activation" :
    // "Activation readiness"` covers both surfaces in one fix.
    // Active services must surface "Activation" in the rail so
    // the sidebar item agrees with the section card heading
    // (which already says "Activation" for Active — Round 5).
    // Draft services must still say "Activation readiness".
    assert.match(
      EDIT_PAGE_SOURCE,
      /name:\s*isActive\s*\?\s*["']Activation["']\s*:\s*["']Activation readiness["']/,
      "sectionNavEarly.activation.name must branch on isActive: 'Activation' for Active, 'Activation readiness' for Draft",
    );
    // The mobile jump's section names come from the same
    // `sectionNav` array, so the single pin in sectionNavEarly
    // covers both surfaces. Pin that `MobileSectionJump`
    // renders section names from the sections prop (it must not
    // hardcode "Activation readiness" anywhere in its body, so a
    // future refactor that hardcodes the Draft-name inside the
    // mobile jump cannot silently regress Active state).
    assert.doesNotMatch(
      EDIT_PAGE_SOURCE,
      /function MobileSectionJump[\s\S]{0,5000}Activation readiness/,
      "MobileSectionJump must not hardcode 'Activation readiness' — section names must come from the sections prop",
    );
  });

  test("header save-status row is hidden when offering.status === 'Active' (no 'Draft saved' / 'Save draft' language on a live service)", () => {
    // Phase 2 #85 Manual QA Round 7. The previous header row
    // unconditionally claimed the lifecycle was a Draft ("Draft
    // saved · Changes save only when you choose Save draft.")
    // — a contradiction on an Active offering, where no Save
    // draft action exists and the lifecycle is no longer Draft.
    // The fix gates the entire row (status text + SaveDraftActions)
    // on `!isActive` so an Active page renders nothing in that
    // slot. The AVAILABLE status pill (top right), the active
    // description (header), and the persistent "Service
    // activated" banner (section 06) already convey the truthful
    // lifecycle state using existing product terminology — no
    // new terminology is introduced.
    assert.match(
      EDIT_PAGE_SOURCE,
      /!isActive\s*\?\s*\([\s\S]{0,500}service-offering-edit-save-status[\s\S]{0,5000}SaveDraftActions[\s\S]{0,500}\)\s*:\s*null/,
      "save-status row (status text + SaveDraftActions) must be gated on !isActive so it is absent for Active offerings",
    );
    // The status string "Draft saved" must NEVER appear in the
    // Active render path. The save-status row block is the only
    // site that produces that string, and the row is now
    // gated; assert it does not appear inside an isActive branch.
    assert.doesNotMatch(
      EDIT_PAGE_SOURCE,
      /isActive[\s\S]{0,2000}Draft saved/,
      "the 'Draft saved' status string must not appear in any isActive render branch",
    );
    // The helper string "Changes save only when you choose Save
    // draft." must also not appear in any isActive render
    // branch — it tells the user to click a button that does
    // not exist on an Active offering.
    assert.doesNotMatch(
      EDIT_PAGE_SOURCE,
      /isActive[\s\S]{0,2000}Changes save only when you choose Save draft/,
      "the 'Changes save only when you choose Save draft.' helper must not appear in any isActive render branch",
    );
  });

  test("Active offering uses 'Service details' page heading, not 'Edit your service'", () => {
    // Phase 2 #85 Manual QA Round 8 — final active read-only
    // presentation. The page heading swaps from the authoring-
    // mode label ("Edit your service") to the read-only-mode
    // label ("Service details") for Active offerings. The
    // conditional uses existing product terminology; no Pause /
    // Edit live / Republish / Reactivate concepts are
    // introduced. Draft offerings must continue to render
    // "Edit your service" unchanged.
    assert.match(
      EDIT_PAGE_SOURCE,
      /isActive\s*\?\s*["']Service details["']\s*:\s*["']Edit your service["']/,
      "page heading must branch on isActive: 'Service details' for Active, 'Edit your service' for Draft",
    );
  });

  test("Active form controls (sections 01–05) carry the native disabled attribute, not just blocked event handlers", () => {
    // Phase 2 #85 Manual QA Round 8 — final active read-only
    // presentation. The brief is explicit: "Use normal
    // disabled/read-only HTML semantics as appropriate. Do not
    // merely block event handlers while leaving controls
    // visually interactive." The `disabled={isActive}` binding
    // must be present on every editable control in sections
    // 01–05. Native `disabled` is the standard HTML semantic
    // for read-only controls; the browser styles it
    // consistently, screen readers announce it, and form-
    // submission pipelines skip it.
    //
    // Each control is pinned independently — a single broad
    // regex would silently swallow regressions that drop the
    // binding on one input.
    const controls = [
      {
        // Inputs that ship with a literal-string testid.
        kind: "literal" as const,
        testId: "service-offering-edit-input-title",
        label: "service title input",
      },
      {
        kind: "literal" as const,
        testId: "service-offering-edit-input-description",
        label: "service description textarea",
      },
      {
        kind: "literal" as const,
        testId: "service-offering-edit-input-category",
        label: "primary category select",
      },
      {
        // The delivery-mode radios render their testid via a
        // template literal (`service-offering-edit-mode-${m}`)
        // so the prefix is the only stable pin.
        kind: "template-prefix" as const,
        testIdPrefix: "service-offering-edit-mode-",
        label: "delivery mode radio (Remote / InPerson / Hybrid)",
      },
      {
        kind: "literal" as const,
        testId: "service-offering-edit-input-service-area-country",
        label: "service-area country select",
      },
      {
        // Pricing radios also use a template literal.
        kind: "template-prefix" as const,
        testIdPrefix: "service-offering-edit-pricing-",
        label: "pricing radio (Fixed / StartingAt / ContactForQuote)",
      },
      {
        kind: "literal" as const,
        testId: "service-offering-edit-input-amount",
        label: "pricing base-amount input",
      },
      {
        kind: "literal" as const,
        testId: "service-offering-edit-input-unit",
        label: "pricing unit select",
      },
      {
        kind: "literal" as const,
        testId: "service-offering-edit-input-genre-tags",
        label: "genre affinity tags input",
      },
    ];
    for (const { kind, testId, testIdPrefix, label } of controls) {
      // The `disabled={isActive}` binding must appear within
      // ~700 chars before the data-testid attribute (covers
      // the JSX attribute block; the input opens then the
      // binding follows within the same JSX element).
      // String.raw avoids the double-escaping inside JS template
      // literals when the testid attribute itself uses a JSX
      // template literal (e.g. `` service-offering-edit-mode-${m} ``).
      // The full template-literal testid shape in the source is
      // `` `prefix-${var}` `` — there are TWO `}` (one closes the
      // `${...}` expression inside the template literal, the
      // other closes the JSX attribute expression).
      const re =
        kind === "literal"
          ? new RegExp(
              `disabled\\s*=\\s*\\{\\s*isActive\\s*\\}[\\s\\S]{0,700}data-testid="${testId}"`,
            )
          : new RegExp(
              String.raw`disabled\s*=\s*\{\s*isActive\s*\}[\s\S]{0,700}data-testid=\{\`` +
                testIdPrefix +
                String.raw`\$\{[^}]+\}\`\}`,
            );
      assert.match(
        EDIT_PAGE_SOURCE,
        re,
        `${label} must carry disabled={isActive} so it is read-only for Active offerings`,
      );
    }
  });

  test("Active work-sample playback remains available; Remove is disabled; the upload form is absent", () => {
    // Phase 2 #85 Manual QA Round 8 — final active read-only
    // presentation. The brief is explicit:
    //   - existing private sample playback may remain available
    //     to the owner
    //   - do NOT allow uploading another sample
    //   - do NOT allow removing an existing sample
    //   - do NOT expose media-confirmation controls for a new
    //     upload
    //   - do not implement the post-activation audio-removal /
    //     eligibility behavior here
    //
    // The <audio> element MUST remain in the source (the audio
    // player is the existing private playback affordance).
    assert.match(
      EDIT_PAGE_SOURCE,
      /<audio[\s\S]{0,2000}crossOrigin="use-credentials"/,
      "existing private <audio> playback must remain available for Active offerings",
    );
    // The Remove control must be disabled for Active offerings.
    assert.match(
      EDIT_PAGE_SOURCE,
      /disabled=\{\s*isActive\s*\|\|[\s\S]{0,80}removeConfirmId[\s\S]{0,600}data-testid="service-offering-edit-sample-remove"/,
      "sample Remove button must be disabled when isActive (or while remove is in flight)",
    );
    // The upload form (label input + file input +
    // media-confirmation checkbox + submit button) MUST be
    // gated on `!isActive`. Pin that the conditional appears
    // OUTSIDE the upload form's `<form>` open tag (so the form
    // is conditionally rendered, not just disabled).
    assert.match(
      EDIT_PAGE_SOURCE,
      /!isActive\s*&&\s*samples\.length\s*<\s*3\s*&&\s*\([\s\S]{0,500}data-testid="service-offering-edit-sample-upload-form"/,
      "sample upload form must be absent for Active offerings (the !isActive gate renders nothing)",
    );
    // The media-confirmation checkbox is INSIDE the upload
    // form, so it disappears together with the form.
    assert.match(
      EDIT_PAGE_SOURCE,
      /data-testid="service-offering-edit-sample-upload-form"[\s\S]{0,4000}data-testid="service-offering-edit-sample-confirmation"/,
      "media-confirmation checkbox lives inside the upload form (absent for Active together with the form)",
    );
  });

  test("Draft offering remains fully editable: every disabled binding above is gated on isActive, not unconditional", () => {
    // Phase 2 #85 Manual QA Round 8 — preserve Draft behavior.
    // The brief is explicit: "For Draft offerings, everything
    // must remain editable exactly as it is now." Each
    // `disabled={isActive}` binding MUST evaluate to falsy on
    // a Draft offering (`isActive === false`). The simplest
    // structural pin is that the binding appears nowhere as a
    // constant `true` — and the existing testids remain
    // reachable from the source (no removal of the Draft path).
    assert.doesNotMatch(
      EDIT_PAGE_SOURCE,
      /disabled\s*=\s*\{\s*true\s*\}/,
      "no editable control may be unconditionally disabled — every disabled binding must be gated on isActive",
    );
    // The existing field testids remain in the source (not
    // removed by the read-only fix). Each input testid below
    // appears in the source code; the conditional gate
    // doesn't strip the input — it just disables it on Active.
    for (const id of [
      "service-offering-edit-input-title",
      "service-offering-edit-input-description",
      "service-offering-edit-input-category",
      "service-offering-edit-input-amount",
      "service-offering-edit-input-unit",
      "service-offering-edit-input-service-area-country",
      "service-offering-edit-input-genre-tags",
      "service-offering-edit-sample-upload-form",
      "service-offering-edit-sample-confirmation",
      "service-offering-edit-sample-submit",
    ]) {
      assert.match(
        EDIT_PAGE_SOURCE,
        new RegExp(`data-testid="${id}"`),
        `Draft editable control '${id}' must remain reachable (not removed by the read-only fix)`,
      );
    }
    // The Save draft and Activate service action-bar testids
    // are already gated on `offering?.status !== "Active"` in
    // Round 5 — pin the gate remains intact so a future
    // refactor cannot re-introduce Activate / Save buttons on
    // an Active offering.
    assert.match(
      EDIT_PAGE_SOURCE,
      /offering\?\.status\s*!==\s*["']Active["']/,
      "Save draft + Activate action bar gate must remain on offering?.status !== 'Active'",
    );
    // The new heading conditional evaluates to "Edit your
    // service" on Draft offerings.
    assert.match(
      EDIT_PAGE_SOURCE,
      /isActive\s*\?\s*["']Service details["']\s*:\s*["']Edit your service["']/,
      "Draft path must continue to render 'Edit your service' heading",
    );
    // The new read-only notice must render ONLY for Active
    // offerings (gated on isActive, with a : null fallback so
    // the Draft path renders nothing).
    assert.match(
      EDIT_PAGE_SOURCE,
      /isActive\s*\?\s*\([\s\S]{0,400}service-offering-edit-read-only-notice[\s\S]{0,200}\)\s*:\s*null/,
      "read-only notice must render only for Active offerings (isActive ?: null ternary)",
    );
  });
});
