import { test, expect } from "@playwright/test";

// M1.3 browser-visible eligibility tracer.
//
// The M1.1 happy-path spec proves the canonical sellers render
// correctly. This spec complements it by proving every excluded
// state stays out of the browser-visible result list. It runs
// against the real Next.js proxy, the real Express API, the real
// TalentSearchService, the real Prisma adapter, and the real
// disposable PostgreSQL; it does NOT mock fetch, the API, the
// repository, or the database.
//
// The seed's NEGATIVE_FIXTURES array adds deterministic excluded-state
// rows with stable IDs (see packages/db/prisma/seed.ts). The
// canonical sellers and the negative fixtures are the same fixtures
// the API/repository integration tests use; this is the browser-side
// end of that chain.

// Distinct title substrings for every negative fixture offering, so
// we can assert they never reach the rendered card list.
const NEGATIVE_OFFERING_TITLES = [
  // Draft profile (workspace and offering are eligible, profile is not)
  "Hidden active offering behind draft profile",
  // Suspended profile
  "Active offering behind suspended profile",
  // Suspended workspace
  "Active offering under a suspended workspace",
  // Buyer-only workspace
  "Active offering on a buyer-only workspace",
  // Draft-only offerings
  "Draft writing offering",
  // Paused-only offerings
  "Paused production offering",
  // Archived-only offerings
  "Archived mixing offering",
  // Mixed-lifecycle Paused sibling (must not surface)
  "Paused songwriting add-on",
  // Mixed-lifecycle Archived sibling (must not surface)
  "Archived production offering",
];

// Sellers whose professional name is on a hidden fixture; we never
// expect them in the browser-visible card list either.
const NEGATIVE_SELLER_NAMES = [
  "Draft Profile Seller",
  "Suspended Profile Seller",
  "Suspended Workspace Seller",
  "Buyer-Only Seller Profile",
  "Draft-Only Offerings Seller",
  "Paused-Only Offerings Seller",
  "Archived-Only Offerings Seller",
];

test("M1.3: every negative eligibility fixture is excluded from the browser-visible result list", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Find Caribbean talent" })).toBeVisible();

  // Issue a broad query that would match every negative fixture's
  // primary category if eligibility were not enforced.
  const query = "production";
  await page.getByTestId("search-input").fill(query);
  await page.getByTestId("search-submit").click();

  const cards = page.getByTestId("result-card");
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });

  // Read the entire rendered card list as a single text blob so a
  // single substring assertion covers every negative title or seller
  // name across all cards (instead of relying on per-card indexing
  // which the current M1 UI does not guarantee).
  const bodyText = (await page.textContent("body")) ?? "";

  for (const title of NEGATIVE_OFFERING_TITLES) {
    expect(
      bodyText.includes(title),
      `negative offering title "${title}" must not appear in the browser-visible result list`,
    ).toBe(false);
  }

  for (const name of NEGATIVE_SELLER_NAMES) {
    expect(
      bodyText.includes(name),
      `negative seller name "${name}" must not appear in the browser-visible result list`,
    ).toBe(false);
  }
});

test("M1.3: a structured query for music-production never surfaces a Draft or Suspended seller", async ({
  page,
}) => {
  await page.goto("/");

  // Send a structured-only request that explicitly requires the
  // music-production category. Without eligibility, the Draft-profile
  // and Suspended-profile sellers would qualify. The browser must
  // show only the canonical published sellers and the mixed-lifecycle
  // Active siblings. The direct API probe (via the Next.js proxy)
  // is the most reliable browser-visible check for this slice: it
  // exercises the same proxy rewrite the search form would use,
  // returns the canonical public response shape, and surfaces any
  // eligibility regression at the route boundary.
  const response = await page.request.post("/api/search", {
    headers: { "Content-Type": "application/json" },
    data: { required: { primaryCategoryKeys: ["music-production"] } },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    results: Array<{ seller: { sellerId: string } }>;
  };
  const sellerIds = body.results.map((r) => r.seller.sellerId);

  // None of the negative seller profile IDs may appear.
  for (const negativeId of [
    "sp-negative-draft-profile",
    "sp-negative-suspended-profile",
    "sp-negative-suspended-workspace",
    "sp-negative-buyer-only",
    "sp-negative-draft-offerings",
    "sp-negative-paused-offerings",
    "sp-negative-archived-offerings",
  ]) {
    expect(sellerIds, `${negativeId} must not surface in the public response`).not.toContain(
      negativeId,
    );
  }
});
