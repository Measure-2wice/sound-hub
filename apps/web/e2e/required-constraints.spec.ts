// M1.4 browser-visible strict required search constraints tracer.
//
// The M1.1 happy-path spec proves a text query renders real sellers. The
// M1.3 negative-eligibility spec proves ineligible sellers stay out of
// the result list. This spec proves the browser surface that lets a
// buyer apply STRICT REQUIRED constraints and the field-level validation
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

test("M1.4: an unknown required category key surfaces a canonical validation error and preserves the input", async ({
  page,
}) => {
  await loadHome(page);

  // The structured select is allow-listed; the custom text input is the
  // buyer's escape hatch for testing unknown canonical values. Sending
  // a non-canonical key triggers the service-layer canonical
  // validation, which surfaces an INVALID_SEARCH_CRITERIA error from
  // the safe envelope. The browser must render the error and preserve
  // the buyer's input so they can correct or remove it.
  await page.getByTestId("required-category").selectOption("");
  await page.getByTestId("required-category-custom").fill("non-existent-category");
  await page.getByTestId("search-submit").click();

  // The global error envelope is rendered with the canonical
  // validation message and the request ID, even when the rejection
  // does not carry a per-field path.
  const errorPanel = page.getByTestId("search-error");
  await expect(errorPanel).toBeVisible();
  await expect(errorPanel.getByTestId("search-error-message")).toContainText(/service category/i);
  await expect(page.getByTestId("search-error-request-id")).toContainText(/Request ID:/);

  // The buyer's input is preserved across the rejection.
  await expect(page.getByTestId("required-category-custom")).toHaveValue("non-existent-category");

  // No result cards render.
  await expect(page.getByTestId("result-card")).toHaveCount(0);
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
    await expect(card.getByTestId("result-category")).toHaveText("Music Production");
    await expect(card.getByTestId("result-service-mode")).toHaveText("Remote");
  }
});
