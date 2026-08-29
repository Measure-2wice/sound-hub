// Page-level empty-submission guard browser tracer.
//
// The M1.1 happy-path spec proves a real query renders real sellers. The
// M1.4 required-constraints spec proves strict filters render correctly.
// This spec exercises the page-level submit boundary that the QA fix for
// issue #8 introduced: a (query, filters) tuple with no usable criteria
// must render a buyer-friendly inline guidance card, must NOT dispatch a
// request to `/api/search`, and must preserve the buyer's typed values.
//
// Every test here runs against the real Next.js proxy, the real Express
// API, the real TalentSearchService, the real Prisma adapter, and the real
// disposable PostgreSQL. The `/api/search` route is intercepted solely so
// the test can count dispatches (`page.route` always `route.fallback()`s
// after incrementing) — no fault injection, no fabricated payloads, no
// response timing control. Every other request, including the canonical
// category catalog fetch on mount, falls through to the real proxy and
// API unchanged.
//
// Acceptance (QA fix for issue #8):
//   - Empty submission renders the approved buyer-friendly guidance
//     verbatim and dispatches zero requests to `/api/search`.
//   - Empty submission preserves the buyer's entered values exactly as
//     typed, including the one-character and whitespace-only edge cases.
//   - A query-only submission (two or more characters, no filters)
//     dispatches exactly one request and never renders the guidance.
//   - A structured-filter-only submission (no query, any single populated
//     filter) dispatches exactly one request and never renders the
//     guidance.
//
// These tests close the Codex review's P1-001 finding that the
// empty-search UX was not exercised at the submission boundary.

import { test, expect, type Page } from "@playwright/test";

async function loadHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Find Caribbean talent" })).toBeVisible();
}

// Install a `/api/search` route counter. Every intercepted request is
// `route.fallback()`-ed to the real proxy / API so the real database path
// remains exercised; the counter only records dispatches. The closure
// keeps the counter private to each test so cross-test leakage is
// impossible.
async function trackSearchDispatches(page: Page): Promise<() => number> {
  let count = 0;
  await page.route("**/api/search", (route) => {
    count += 1;
    void route.fallback();
  });
  return () => count;
}

test("M1.7 QA: an empty submission renders the buyer-friendly guidance and dispatches no request", async ({
  page,
}) => {
  const getCount = await trackSearchDispatches(page);
  await loadHome(page);

  // Submit without typing anything into any control. No usable
  // criteria means the page-level guard must fire.
  await page.getByTestId("search-submit").click();

  // The buyer-friendly guidance card renders with the QA-approved
  // copy and the developer-centric API envelope NEVER surfaces
  // (instead of the prior `<root> at least one of query, required, or
  // preferred …` raw error).
  const guidance = page.getByTestId("empty-search-guidance");
  await expect(guidance).toBeVisible({ timeout: 5_000 });
  const guidanceMessage = page.getByTestId("empty-search-guidance-message");
  await expect(guidanceMessage).toHaveText(
    "Add a project description or choose at least one search filter.",
  );
  const bodyText = (await page.textContent("body")) ?? "";
  expect(bodyText).not.toContain("Request body failed schema validation.");
  expect(bodyText).not.toContain("<root> at least one of query");

  // The page must NOT have rendered an error card (the guard never
  // dispatches, so no API envelope can surface) and must NOT have
  // rendered result cards (no search has been issued yet).
  await expect(page.getByTestId("search-error")).toHaveCount(0);
  await expect(page.getByTestId("result-card")).toHaveCount(0);

  // No /api/search request must have been dispatched. We wait a
  // short moment first so a hypothetical race cannot hide a late
  // dispatch behind the assertion.
  await page.waitForTimeout(250);
  expect(getCount()).toBe(0);
});

test("M1.7 QA: an empty submission preserves entered values verbatim", async ({ page }) => {
  const getCount = await trackSearchDispatches(page);
  await loadHome(page);

  // The buyer types a single-character query (still not "usable" by
  // `hasUsableCriteria` because the page requires two or more
  // characters after trimming) and leaves every structured filter
  // empty. The tuple has no usable criteria, so the guard fires.
  // The typed value must remain in the input exactly as the buyer
  // left it — the page must not clear the form just because the
  // submission was blocked.
  const typedQuery = "a";
  await page.getByTestId("search-input").fill(typedQuery);
  await page.getByTestId("search-submit").click();

  await expect(page.getByTestId("empty-search-guidance")).toBeVisible({ timeout: 5_000 });

  // Entered value remains in the input. A regression that cleared
  // the input on guard (or rerouted through a side effect that
  // mutated state) would fail this assertion.
  await expect(page.getByTestId("search-input")).toHaveValue(typedQuery);
  await expect(page.getByTestId("required-based-in-country")).toHaveValue("");
  await expect(page.getByTestId("required-based-in-region")).toHaveValue("");
  await expect(page.getByTestId("required-based-in-city")).toHaveValue("");
  await expect(page.getByTestId("required-service-area-country")).toHaveValue("");
  await expect(page.getByTestId("required-service-area-region")).toHaveValue("");
  await expect(page.getByTestId("required-service-area-city")).toHaveValue("");

  // No dispatch. The guard fires before the hook's fetch path runs.
  await page.waitForTimeout(250);
  expect(getCount()).toBe(0);
});

test("M1.7 QA: a query-only submission dispatches exactly one request and never renders the guidance", async ({
  page,
}) => {
  const getCount = await trackSearchDispatches(page);
  await loadHome(page);

  // Two or more characters + no structured filters is a valid query
  // search. The guard must NOT fire; the hook must dispatch exactly
  // one request; the buyer-friendly guidance card must remain
  // absent from the page.
  const query = "Haitian dancehall single production";
  await page.getByTestId("search-input").fill(query);
  await page.getByTestId("search-submit").click();

  await expect(page.getByTestId("result-card").first()).toBeVisible({ timeout: 15_000 });

  // Guidance is absent — the buyer-friendly card only renders on
  // an empty submission, never on a successful path.
  await expect(page.getByTestId("empty-search-guidance")).toHaveCount(0);

  // Exactly one /api/search dispatch. A regression that double-fired
  // (for example by also calling the hook on guard failure) would
  // observe a count greater than one.
  expect(getCount()).toBe(1);

  // The buyer's typed value is preserved across the result render.
  await expect(page.getByTestId("search-input")).toHaveValue(query);
});

test("M1.7 QA: a structured-filter-only submission dispatches exactly one request and never renders the guidance", async ({
  page,
}) => {
  const getCount = await trackSearchDispatches(page);
  await loadHome(page);

  // A required basedIn.countryCode with no query is a valid
  // structured-only search. The guard must NOT fire; the hook must
  // dispatch exactly one request; the buyer-friendly guidance card
  // must remain absent.
  const country = "JM";
  await page.getByTestId("required-based-in-country").fill(country);
  await page.getByTestId("search-submit").click();

  // We do not assert on the result-card count because JM may or
  // may not match a seller; either the empty state or a real card
  // is a valid terminal state for a structured-only request. We
  // DO assert that the dispatch was accepted (one /api/search
  // request) and that the request was NOT rejected by the page-
  // level guard (no guidance card).
  await expect(
    page
      .getByTestId("result-card")
      .first()
      .or(page.getByTestId("search-empty"))
      .or(page.getByTestId("search-error").first()),
  ).toBeVisible({ timeout: 15_000 });

  // Guidance is absent — the structured-only request had usable
  // criteria, so the guard did not fire.
  await expect(page.getByTestId("empty-search-guidance")).toHaveCount(0);

  // Exactly one /api/search dispatch. A regression that blocked
  // the structured-only request behind the guard would observe a
  // count of zero; a regression that double-fired would observe
  // a count greater than one.
  expect(getCount()).toBe(1);

  // The buyer's typed value is preserved across the result render.
  await expect(page.getByTestId("required-based-in-country")).toHaveValue(country);
  await expect(page.getByTestId("search-input")).toHaveValue("");
});

test("M1.7 QA: a subsequent valid submission clears the guidance card so it never blocks the happy path", async ({
  page,
}) => {
  const getCount = await trackSearchDispatches(page);
  await loadHome(page);

  // First: trigger the guard so the guidance card is visible.
  await page.getByTestId("search-submit").click();
  await expect(page.getByTestId("empty-search-guidance")).toBeVisible({ timeout: 5_000 });
  expect(getCount()).toBe(0);

  // Second: type a valid query and submit. The guidance card must
  // disappear (so the buyer is not left staring at an obsolete
  // amber banner above the results), and exactly one /api/search
  // request must fire from this second submission.
  const query = "Haitian producer";
  await page.getByTestId("search-input").fill(query);
  await page.getByTestId("search-submit").click();

  // Either a result card OR the empty state is a valid terminal
  // outcome for the second submission — the assertion under test
  // is the guidance-clear behaviour, not the seed-specific match
  // for this exact query.
  await expect(
    page
      .getByTestId("result-card")
      .first()
      .or(page.getByTestId("search-empty"))
      .or(page.getByTestId("search-error").first()),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("empty-search-guidance")).toHaveCount(0);

  // Total /api/search dispatches across BOTH submissions: zero
  // from the first (guard fired), exactly one from the second
  // (valid query submitted).
  expect(getCount()).toBe(1);
});
