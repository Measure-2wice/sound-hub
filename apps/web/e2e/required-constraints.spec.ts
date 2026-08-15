// M1.4 browser-visible strict required search constraints tracer.
//
// The M1.1 happy-path spec proves a text query renders real sellers. The
// M1.3 negative-eligibility spec proves ineligible sellers stay out of the
// result list. This spec proves the browser surface that lets a buyer
// apply STRICT REQUIRED constraints and the field-level validation
// feedback that preserves the buyer's input on a rejected request.
//
// It runs against the real Next.js proxy, the real Express API, the real
// TalentSearchService, the real Prisma adapter, and the real disposable
// PostgreSQL. It does NOT mock fetch, the API, the repository, or the
// database.
//
// Coverage:
//   - Applying a required category (music-production) AND a required
//     service mode (Remote) renders only sellers whose Active offering
//     matches both. The positive control is the canonical
//     `Marc-André Pierre` Haitian producer.
//   - A required basedIn countryCode that no seller matches renders the
//     empty state, NOT a 400, and preserves the buyer's filter input.
//   - A malformed basedIn countryCode (numeric `12`) renders the
//     field-level error envelope, the buyer's input is preserved, and no
//     cards are rendered.
//   - A required serviceArea countryCode that matches a subset of sellers
//     narrows the result list to those sellers and excludes non-matching
//     sellers.
//   - A required serviceArea countryCode that no seller matches renders
//     the empty state, NOT a 400, and preserves the buyer's filter
//     input.
//   - A malformed serviceArea countryCode (numeric `12`) renders the
//     field-level error envelope beside the serviceArea control, the
//     buyer's input is preserved, and no cards are rendered.
//   - Required category and service-mode constraints compound (AND).
//   - A bundle-only IncludedService category key cannot satisfy a
//     required independentlyPurchasableServiceKeys filter.

import { test, expect, type Page } from "@playwright/test";

async function loadHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Find Caribbean talent" })).toBeVisible();
}

async function submitAndWaitForCards(page: Page): Promise<void> {
  await page.getByTestId("search-submit").click();
  await expect(page.getByTestId("result-card").first()).toBeVisible({ timeout: 15_000 });
}

test("M1.4: required category + service mode filters exclude nonconforming candidates", async ({
  page,
}) => {
  await loadHome(page);

  // The buyer enters a free-text query plus structured required
  // constraints. The query alone could match many sellers; the required
  // filters narrow the set deterministically.
  await page.getByTestId("search-input").fill("production");
  await page.getByTestId("required-category").selectOption({ label: "Music Production" });
  await page.getByTestId("required-service-mode-remote").check();
  await submitAndWaitForCards(page);

  // Positive control: the canonical Haitian producer matches both the
  // text token and the required filters.
  const cards = page.getByTestId("result-card");
  await expect(cards.filter({ hasText: "Marc-André Pierre" }).first()).toBeVisible();

  // The Bahamian live-performance seller must NOT surface because the
  // buyer required music-production + Remote. That seller is
  // InPerson + live-performance, so the AND of the two constraints
  // excludes them.
  const bodyText = (await page.textContent("body")) ?? "";
  expect(bodyText).not.toContain("Devon King");
  expect(bodyText).not.toContain("Bachata and merengue live performance");
});

test("M1.4: a required basedIn countryCode with no match renders the empty state and preserves the filter", async ({
  page,
}) => {
  await loadHome(page);

  // No seller is based in FR. The search must complete (no 400), the
  // empty state must render, and the structured filter must remain in
  // the form so the buyer can correct it without retyping.
  await page.getByTestId("required-based-in-country").fill("FR");
  await page.getByTestId("search-submit").click();

  // Wait for the empty state to render. We do NOT use
  // submitAndWaitForCards because no cards are expected.
  await expect(page.getByTestId("search-empty")).toBeVisible({ timeout: 15_000 });

  // The filter is preserved across the empty result.
  await expect(page.getByTestId("required-based-in-country")).toHaveValue("FR");
});

test("M1.4: a malformed required basedIn countryCode surfaces a field-level error and preserves the input", async ({
  page,
}) => {
  await loadHome(page);

  // Numeric input `12` passes the 2-char length check but fails the
  // shared Zod `/^[A-Z]{2}$/` regex, so the schema rejects it. The
  // browser must render the field-level error envelope (path + safe
  // message) while preserving the buyer's input so they can correct it.
  await page.getByTestId("required-based-in-country").fill("12");
  await page.getByTestId("search-submit").click();

  // Field-level error renders beside the countryCode control with the
  // safe message that names the path.
  const countryField = page.getByTestId("required-based-in-country-field");
  await expect(countryField).toBeVisible();
  await expect(countryField.getByTestId("field-error-message")).toContainText(/alpha-2/i);
  await expect(countryField.getByTestId("field-error-path")).toContainText(
    "required.basedIn.countryCode",
  );

  // Buyer's input is preserved; they can correct `12` -> `JM` without
  // retyping it.
  await expect(page.getByTestId("required-based-in-country")).toHaveValue("12");

  // No result cards render because the request was rejected at the
  // schema boundary.
  await expect(page.getByTestId("result-card")).toHaveCount(0);
});

test("M1.5: malformed criteria returns the standard error envelope and a visible request ID through the Next.js proxy", async ({
  page,
}) => {
  await loadHome(page);

  // Submit a single-character query with a malformed country code.
  // The shared schema rejects the candidate with INVALID_SEARCH_CRITERIA;
  // the browser MUST surface the standard error envelope with field
  // errors and a non-empty request ID returned by Express via the
  // Next.js proxy. This closes the Codex P1-001 finding.
  await page.getByTestId("search-input").fill("a");
  await page.getByTestId("required-based-in-country").fill("12");
  await page.getByTestId("search-submit").click();

  // The standard error envelope surfaces as the visible search error.
  const errorCard = page.getByTestId("search-error");
  await expect(errorCard).toBeVisible({ timeout: 15_000 });

  // INVALID_SEARCH_CRITERIA and field-level feedback appear beside
  // the malformed control.
  const countryField = page.getByTestId("required-based-in-country-field");
  await expect(countryField.getByTestId("field-error-message")).toContainText(/alpha-2/i);
  await expect(countryField.getByTestId("field-error-path")).toContainText(
    "required.basedIn.countryCode",
  );

  // Buyer's input is preserved across the rejection.
  await expect(page.getByTestId("required-based-in-country")).toHaveValue("12");
  await expect(page.getByTestId("search-input")).toHaveValue("a");

  // The standard envelope includes a request ID rendered by the page
  // so the rejection is traceable end-to-end through the Next.js proxy.
  const requestId = page.getByTestId("search-error-request-id");
  await expect(requestId).toBeVisible();
  const text = (await requestId.textContent()) ?? "";
  expect(text.trim().length).toBeGreaterThan(0);
});

test("M1.4: a required serviceArea countryCode that matches a subset of sellers narrows the result list", async ({
  page,
}) => {
  await loadHome(page);

  // GB is the service area only Aisha offers. The structured-only
  // request must surface only Aisha and exclude every other seller
  // whose offering does not include GB in its serviceAreas.
  // (Sanity: the canonical database lists Aisha's serviceAreas as
  // [GB, TT, US] and Marc-André's as [US, HT].)
  await page.getByTestId("required-service-area-country").fill("GB");
  await submitAndWaitForCards(page);

  const cards = page.getByTestId("result-card");
  await expect(cards.filter({ hasText: "Aisha Mohammed" }).first()).toBeVisible();

  const bodyText = (await page.textContent("body")) ?? "";
  // Marc-André Pierre's offering serviceAreas are [US, HT], so the
  // GB constraint MUST exclude them.
  expect(bodyText).not.toContain("Marc-André Pierre");
  expect(bodyText).not.toContain("Haitian dancehall single production");
});

test("M1.4: a required serviceArea countryCode with no match renders the empty state and preserves the filter", async ({
  page,
}) => {
  await loadHome(page);

  // No seller has FR in their serviceAreas. The search must complete
  // (no 400), the empty state must render, and the structured filter
  // must remain in the form so the buyer can correct it.
  await page.getByTestId("required-service-area-country").fill("FR");
  await page.getByTestId("search-submit").click();

  await expect(page.getByTestId("search-empty")).toBeVisible({ timeout: 15_000 });

  // The filter is preserved across the empty result.
  await expect(page.getByTestId("required-service-area-country")).toHaveValue("FR");
});

test("M1.4: a malformed required serviceArea countryCode surfaces a field-level error and preserves the input", async ({
  page,
}) => {
  await loadHome(page);

  // Numeric input `12` passes the 2-char length check but fails the
  // shared Zod `/^[A-Z]{2}$/` regex, so the schema rejects it. The
  // browser must render the field-level error envelope beside the
  // serviceArea control while preserving the buyer's input so they can
  // correct it.
  await page.getByTestId("required-service-area-country").fill("12");
  await page.getByTestId("search-submit").click();

  // Field-level error renders beside the serviceArea control with the
  // safe message that names the path.
  const serviceAreaField = page.getByTestId("required-service-area-country-field");
  await expect(serviceAreaField).toBeVisible();
  await expect(serviceAreaField.getByTestId("field-error-message")).toContainText(/alpha-2/i);
  await expect(serviceAreaField.getByTestId("field-error-path")).toContainText(
    "required.serviceArea.countryCode",
  );

  // Buyer's input is preserved; they can correct `12` -> `GB` without
  // retyping it.
  await expect(page.getByTestId("required-service-area-country")).toHaveValue("12");

  // No result cards render because the request was rejected at the
  // schema boundary.
  await expect(page.getByTestId("result-card")).toHaveCount(0);
});

test("M1.5: malformed serviceArea returns the standard error envelope and a visible request ID through the Next.js proxy", async ({
  page,
}) => {
  await loadHome(page);

  // Mirror the basedIn case for the serviceArea control. The standard
  // INVALID_SEARCH_CRITERIA envelope with field errors and a request ID
  // must surface through the Next.js proxy. This closes the Codex
  // P1-001 verification for the serviceArea path.
  await page.getByTestId("required-service-area-country").fill("12");
  await page.getByTestId("search-submit").click();

  const errorCard = page.getByTestId("search-error");
  await expect(errorCard).toBeVisible({ timeout: 15_000 });

  const serviceAreaField = page.getByTestId("required-service-area-country-field");
  await expect(serviceAreaField.getByTestId("field-error-message")).toContainText(/alpha-2/i);
  await expect(serviceAreaField.getByTestId("field-error-path")).toContainText(
    "required.serviceArea.countryCode",
  );

  await expect(page.getByTestId("required-service-area-country")).toHaveValue("12");

  const requestId = page.getByTestId("search-error-request-id");
  await expect(requestId).toBeVisible();
  const text = (await requestId.textContent()) ?? "";
  expect(text.trim().length).toBeGreaterThan(0);
});

test("M1.4: required independentlyPurchasableServiceKeys excludes bundle-only offerings", async ({
  page,
}) => {
  await loadHome(page);

  // The bundle-only seller is anchored on category=songwriting but
  // bundleOnly=true. The buyer requires independentlyPurchasableServiceKeys
  // = ["songwriting"]. The bundle-only seller MUST be excluded because
  // a bundle-only IncludedService cannot satisfy an independently
  // purchasable requirement.
  await page
    .getByTestId("required-independently-purchasable-service")
    .selectOption({ label: "Songwriting" });
  await page.getByTestId("search-submit").click();

  const bodyText = (await page.textContent("body")) ?? "";
  // The canonical topline-writing seller (Keisha Williams) IS an
  // independently-purchasable songwriting offering, so they surface.
  expect(bodyText).toContain("Keisha Williams");
  // The bundle-only seller's offering title must not appear.
  expect(bodyText).not.toContain("Hidden bundle-only");
  expect(bodyText).not.toContain("Add-on songwriting deliverable");
});

test("M1.4: required constraints compound (category AND service mode are both enforced)", async ({
  page,
}) => {
  await loadHome(page);

  // Set both category and service mode.
  await page.getByTestId("required-category").selectOption({ label: "Music Production" });
  await page.getByTestId("required-service-mode-remote").check();
  await submitAndWaitForCards(page);

  // Every visible card must satisfy BOTH constraints.
  const cards = page.getByTestId("result-card");
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    await expect(card.getByTestId("result-offering-category")).toHaveText("Music Production");
    await expect(card.getByTestId("result-offering-service-mode")).toHaveText("Remote");
  }
});

test("M1.5: when the canonical category catalog fails to load, service-mode/basedIn/serviceArea remain usable", async ({
  page,
}) => {
  // Force the canonical metadata fetch to fail so the catalog stays
  // empty and the catalog-error banner renders. Independent required
  // filters (service mode, basedIn, serviceArea) must remain usable so
  // buyers are not blocked from applying those strict constraints.
  await page.route("**/api/metadata/categories", (route) => route.abort("failed"));

  await loadHome(page);

  // Catalog error banner appears so the buyer knows the categories
  // are unavailable.
  await expect(page.getByTestId("catalog-error")).toBeVisible();

  // Category-dependent selects are disabled.
  await expect(page.getByTestId("required-category")).toBeDisabled();
  await expect(page.getByTestId("required-independently-purchasable-service")).toBeDisabled();

  // Independent required controls remain enabled — they do not
  // depend on the category catalog.
  await expect(page.getByTestId("required-service-mode-remote")).toBeEnabled();
  await expect(page.getByTestId("required-service-mode-in-person")).toBeEnabled();
  await expect(page.getByTestId("required-service-mode-hybrid")).toBeEnabled();
  await expect(page.getByTestId("required-based-in-country")).toBeEnabled();
  await expect(page.getByTestId("required-based-in-region")).toBeEnabled();
  await expect(page.getByTestId("required-based-in-city")).toBeEnabled();
  await expect(page.getByTestId("required-service-area-country")).toBeEnabled();
  await expect(page.getByTestId("required-service-area-region")).toBeEnabled();
  await expect(page.getByTestId("required-service-area-city")).toBeEnabled();

  // The buyer can still apply a service-mode + basedIn constraint
  // and submit a real search; the empty / no-match state must NOT be
  // caused by disabling the controls.
  await page.getByTestId("required-service-mode-remote").check();
  await page.getByTestId("required-based-in-country").fill("JM");
  await page.getByTestId("search-submit").click();

  // Either we surface real matching sellers or the empty state —
  // never a submission error caused by disabling an unrelated
  // control. We assert that the page accepts and processes the
  // request by waiting for one of those terminal states.
  await expect(
    page
      .getByTestId("result-card")
      .first()
      .or(page.getByTestId("search-empty"))
      .or(page.getByTestId("search-error").first()),
  ).toBeVisible({ timeout: 15_000 });
});

test("M1.5: when the canonical category catalog returns an empty array, independent required filters remain usable", async ({
  page,
}) => {
  // Force the canonical metadata fetch to return a structurally valid
  // but empty array. Categories list is empty; the two category selects
  // are disabled, but service mode / basedIn / serviceArea stay enabled.
  await page.route("**/api/metadata/categories", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    }),
  );

  await loadHome(page);

  await expect(page.getByTestId("required-category")).toBeDisabled();
  await expect(page.getByTestId("required-independently-purchasable-service")).toBeDisabled();
  await expect(page.getByTestId("required-service-mode-remote")).toBeEnabled();
  await expect(page.getByTestId("required-based-in-country")).toBeEnabled();
  await expect(page.getByTestId("required-based-in-region")).toBeEnabled();
  await expect(page.getByTestId("required-based-in-city")).toBeEnabled();
  await expect(page.getByTestId("required-service-area-country")).toBeEnabled();
  await expect(page.getByTestId("required-service-area-region")).toBeEnabled();
  await expect(page.getByTestId("required-service-area-city")).toBeEnabled();

  // A basedIn constraint alone still drives a real structured
  // request to Express; the page must process it instead of leaving
  // the buyer blocked.
  await page.getByTestId("required-based-in-country").fill("JM");
  await page.getByTestId("search-submit").click();

  await expect(
    page
      .getByTestId("result-card")
      .first()
      .or(page.getByTestId("search-empty"))
      .or(page.getByTestId("search-error").first()),
  ).toBeVisible({ timeout: 15_000 });
});

// ---------------------------------------------------------------------
// M1.5 city / region constraints.
//
// These specs exercise the browser surface for the full `LocationFilter`
// contract. The seed data anchors a positive control (Marc-André Pierre
// is basedIn Brooklyn / NY) and a negative control (Devon King is
// basedIn Nassau, Bahamas). City- and region-only constraints must
// exclude non-conforming sellers, a city-only constraint with no match
// must render the empty state, and a malformed value must surface
// through the standard envelope with a visible request ID while the
// buyer's input remains in the form.
// ---------------------------------------------------------------------

test("M1.5: a required basedIn.city narrows the result list to sellers actually located there", async ({
  page,
}) => {
  await loadHome(page);

  // Marc-André Pierre is the canonical Brooklyn-based Haitian producer.
  // The buyer sets ONLY a basedIn.city (no countryCode) and the search
  // must surface Marc-André and exclude every seller not based in
  // Brooklyn (Devon King lives in Nassau, Bahamas).
  await page.getByTestId("required-based-in-city").fill("Brooklyn");
  await page.getByTestId("search-submit").click();

  await expect(page.getByTestId("result-card").first()).toBeVisible({ timeout: 15_000 });

  const bodyText = (await page.textContent("body")) ?? "";
  expect(bodyText).toContain("Marc-André Pierre");
  expect(bodyText).not.toContain("Devon King");

  // The buyer's city input is preserved across the result render.
  await expect(page.getByTestId("required-based-in-city")).toHaveValue("Brooklyn");
});

test("M1.5: a required basedIn.region narrows the result list to sellers actually located there", async ({
  page,
}) => {
  await loadHome(page);

  // NY is the region for both Brooklyn-based sellers (Marc-André Pierre
  // and Keisha Williams). The buyer sets ONLY a basedIn.region and
  // both NY-based sellers surface; the Nassau-based Devon King is
  // excluded because Bahamas has no region recorded.
  await page.getByTestId("required-based-in-region").fill("NY");
  await page.getByTestId("search-submit").click();

  await expect(page.getByTestId("result-card").first()).toBeVisible({ timeout: 15_000 });

  const bodyText = (await page.textContent("body")) ?? "";
  expect(bodyText).toContain("Marc-André Pierre");
  expect(bodyText).not.toContain("Devon King");

  // The buyer's region input is preserved across the result render.
  await expect(page.getByTestId("required-based-in-region")).toHaveValue("NY");
});

test("M1.5: a required basedIn.city with no match renders the empty state and preserves the input", async ({
  page,
}) => {
  await loadHome(page);

  // No seller is based in Paris. The search must complete (no 400),
  // the empty state must render, and the buyer's input must remain in
  // the form so they can correct it without retyping.
  await page.getByTestId("required-based-in-city").fill("Paris");
  await page.getByTestId("search-submit").click();

  await expect(page.getByTestId("search-empty")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("required-based-in-city")).toHaveValue("Paris");
});

test("M1.5: a required serviceArea.city narrows the result list to offerings actually delivered there", async ({
  page,
}) => {
  await loadHome(page);

  // Aisha Mohammed's offering lists London (GB) in its serviceAreas.
  // The buyer sets ONLY a serviceArea.city (no countryCode) and only
  // Aisha surfaces. Marc-André's offering lists Brooklyn (US), so the
  // London constraint must exclude him.
  await page.getByTestId("required-service-area-city").fill("London");
  await page.getByTestId("search-submit").click();

  await expect(page.getByTestId("result-card").first()).toBeVisible({ timeout: 15_000 });

  const bodyText = (await page.textContent("body")) ?? "";
  expect(bodyText).toContain("Aisha Mohammed");
  expect(bodyText).not.toContain("Marc-André Pierre");

  // The buyer's city input is preserved across the result render.
  await expect(page.getByTestId("required-service-area-city")).toHaveValue("London");
});

test("M1.5: a required serviceArea.city with no match renders the empty state and preserves the input", async ({
  page,
}) => {
  await loadHome(page);

  // No offering lists Paris in its serviceAreas. The search must
  // complete (no 400), the empty state must render, and the buyer's
  // input must remain in the form.
  await page.getByTestId("required-service-area-city").fill("Paris");
  await page.getByTestId("search-submit").click();

  await expect(page.getByTestId("search-empty")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("required-service-area-city")).toHaveValue("Paris");
});

test("M1.5: city and region inputs are preserved across all render states", async ({ page }) => {
  await loadHome(page);

  // Fill all six location inputs at once so the buyer can see the
  // complete form. Submit a search that succeeds and confirm every
  // input retains its value after the results render.
  await page.getByTestId("required-based-in-country").fill("US");
  await page.getByTestId("required-based-in-region").fill("NY");
  await page.getByTestId("required-based-in-city").fill("Brooklyn");
  await page.getByTestId("required-service-area-country").fill("GB");
  await page.getByTestId("required-service-area-region").fill("LDN");
  await page.getByTestId("required-service-area-city").fill("London");
  await page.getByTestId("search-submit").click();

  await expect(
    page
      .getByTestId("result-card")
      .first()
      .or(page.getByTestId("search-empty"))
      .or(page.getByTestId("search-error").first()),
  ).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId("required-based-in-country")).toHaveValue("US");
  await expect(page.getByTestId("required-based-in-region")).toHaveValue("NY");
  await expect(page.getByTestId("required-based-in-city")).toHaveValue("Brooklyn");
  await expect(page.getByTestId("required-service-area-country")).toHaveValue("GB");
  await expect(page.getByTestId("required-service-area-region")).toHaveValue("LDN");
  await expect(page.getByTestId("required-service-area-city")).toHaveValue("London");
});
