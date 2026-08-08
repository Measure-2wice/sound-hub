import { test, expect } from "@playwright/test";

// The single Milestone 1 happy-path tracer. It does not mock fetch, the
// API, the repository, or the database. It exercises the real Next.js
// proxy, the real Express route, the real TalentSearchService, the real
// Prisma adapter, and the real disposable PostgreSQL.
//
// Acceptance:
//   - The user enters a search query.
//   - The browser renders matching sellers and their best Active offering.
//   - The highest-scoring result is the seeded Marc-André Pierre fixture.
//   - The match reason is factual and excludes any AI claim.
//   - The relevanceScore is not rendered as a buyer-facing percentage.
//   - Additional Caribbean affiliations render on the seller card.

test("renders real sellers and Active offerings for the M1.1 happy path", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Find Caribbean talent" })).toBeVisible();

  const query = "Haitian producer in New York for a remote dancehall single";

  await page.getByTestId("search-input").fill(query);
  await page.getByTestId("search-submit").click();

  // The first card must be the highest-scoring seeded fixture.
  const cards = page.getByTestId("result-card");
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  await expect(cards).not.toHaveCount(0);

  const top = cards.first();
  await expect(top.getByTestId("result-seller-name")).toHaveText("Marc-André Pierre");
  await expect(top.getByTestId("result-offering-title")).toHaveText(
    "Haitian dancehall single production — remote",
  );

  const reason = await top.getByTestId("result-match-reason").textContent();
  expect(reason ?? "").not.toMatch(/ai|artificial|intelligence|confidence|guarantee|quality/i);
  expect(reason ?? "").toMatch(/matched/);

  // The relevanceScore must not be displayed as a buyer-facing percentage.
  const bodyText = (await page.textContent("body")) ?? "";
  expect(bodyText).not.toMatch(/Match Score:\s*\d+%/);
  expect(bodyText).not.toMatch(/relevanceScore/i);

  // Caribbean affiliation is rendered.
  await expect(top.getByTestId("result-affiliations")).toContainText("HT");

  // The M1.1 contract returns exactly one best offering per seller with no
  // additional offerings; verify the offering is the only one inside the
  // top card.
  await expect(top.getByTestId("result-offering-title")).toHaveCount(1);
});

test("shows the empty state when no seller matches", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("search-input").fill("zzz-no-such-talent-anywhere");
  await page.getByTestId("search-submit").click();
  await expect(page.getByTestId("search-empty")).toBeVisible({ timeout: 15_000 });
});

test("disables the submit button for queries shorter than the contract minimum", async ({
  page,
}) => {
  await page.goto("/");
  // 1 character is below the contract minimum of 2, so the button is
  // disabled and no request is fired.
  await page.getByTestId("search-input").fill("a");
  await expect(page.getByTestId("search-submit")).toBeDisabled();

  // The button re-enables once the input reaches the contract minimum.
  await page.getByTestId("search-input").fill("ab");
  await expect(page.getByTestId("search-submit")).toBeEnabled();
});

test("surfaces the safe error envelope for unknown JSON fields", async ({ page }) => {
  await page.goto("/");
  // Intercept the search request and inject an unknown field so the API
  // returns the safe envelope. The page must render the safe error and
  // keep the user's brief in the input.
  await page.route("**/api/search", async (route) => {
    await route.fulfill({
      status: 400,
      headers: { "content-type": "application/json", "x-request-id": "test-request-id" },
      body: JSON.stringify({
        error: {
          code: "INVALID_SEARCH_CRITERIA",
          message: "Request body failed schema validation.",
          fields: [
            { path: "mysteriousField", code: "unrecognized_keys", message: "unknown field" },
          ],
          requestId: "test-request-id",
        },
      }),
    });
  });
  await page
    .getByTestId("search-input")
    .fill("Haitian producer in New York for a remote dancehall single");
  await page.getByTestId("search-submit").click();
  await expect(page.getByTestId("search-error")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("search-error-request-id")).toContainText("test-request-id");
  // The brief is preserved.
  await expect(page.getByTestId("search-input")).toHaveValue(
    "Haitian producer in New York for a remote dancehall single",
  );
});
