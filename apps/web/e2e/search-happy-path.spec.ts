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
//
// Broader browser-state, retry, unavailable-path, and concurrency coverage
// belongs to issues #7 and #8.

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
});
