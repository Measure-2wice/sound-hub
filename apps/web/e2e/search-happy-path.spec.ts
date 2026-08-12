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

  // M1.2: the approved public seller and offering fields are presented as
  // distinct concepts. Specialty, ServiceCategory, current location, service
  // area, and service mode must each be separately legible rather than
  // collapsed into one line.
  await expect(top.getByTestId("result-specialties")).toContainText("Producer");
  await expect(top.getByTestId("result-category")).toHaveText("Music Production");
  await expect(top.getByTestId("result-service-mode")).toHaveText("Remote");
  await expect(top.getByTestId("result-based-in")).toContainText("Brooklyn");
  await expect(top.getByTestId("result-based-in")).toContainText("US");
  await expect(top.getByTestId("result-service-areas")).toContainText("US");
  await expect(top.getByTestId("result-genres")).toContainText("Dancehall");

  // Current location and Caribbean affiliation are labeled distinctly so that
  // residence is never presented as regional connection.
  const cardText = (await top.textContent()) ?? "";
  expect(cardText).toMatch(/Based in:/);
  expect(cardText).toMatch(/Caribbean affiliation:/);
  expect(cardText).toMatch(/Service area:/);

  // Structured, non-binding pricing.
  await expect(top.getByTestId("result-pricing")).toContainText("Starting at");
  await expect(top.getByTestId("result-pricing")).toContainText("USD");
  await expect(top.getByTestId("result-pricing-disclaimer")).toContainText("non-binding");
});

test("presents every pricing presentation as non-binding, including offerings with no advertised price", async ({
  page,
}) => {
  await page.goto("/");

  // The seeded mastering fixture advertises no pricing at all. The absent case
  // is a distinct presentation and must still carry the non-binding framing
  // rather than silently rendering nothing.
  await page.getByTestId("search-input").fill("mastering");
  await page.getByTestId("search-submit").click();

  const cards = page.getByTestId("result-card");
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });

  const mastering = cards.filter({ hasText: "Streaming-ready mastering" }).first();
  await expect(mastering).toBeVisible();
  await expect(mastering.getByTestId("result-pricing")).toHaveText("Not advertised");
  await expect(mastering.getByTestId("result-pricing-disclaimer")).toContainText("non-binding");
  await expect(mastering.getByTestId("result-category")).toHaveText("Mastering");

  // relevanceScore still never surfaces as buyer-facing confidence.
  const bodyText = (await page.textContent("body")) ?? "";
  expect(bodyText).not.toMatch(/Match Score:\s*\d+%/);
  expect(bodyText).not.toMatch(/relevanceScore/i);
  expect(bodyText).not.toMatch(/\b\d{1,3}%\s*(match|confidence)/i);
});
