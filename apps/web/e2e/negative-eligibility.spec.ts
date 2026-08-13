import { test, expect, type Page } from "@playwright/test";

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
//
// Each probe below pairs a query that would positively select the
// negative fixture if eligibility were not enforced, with a positive
// control (the canonical seller who shares the same category and must
// render under the same query). The positive control is the load-bearing
// assertion that the absence of the negative fixture is non-vacuous:
// a query that returns zero rendered cards would silently pass any
// "title not in bodyText" check, so the positive control is required
// for every probe.

interface StateProbe {
  /** Query that would positively select the negative fixture absent eligibility. */
  query: string;
  /** Rendered-card positive control: the canonical seller for this category. */
  positiveSellerName: string;
  /** Rendered-card positive control: the canonical offering title. */
  positiveOfferingTitle: string;
  /** Stable negative fixture title that must not appear in the rendered cards. */
  negativeTitle: string;
  /** Stable negative fixture seller name that must not appear in the rendered cards. */
  negativeSellerName: string;
}

const STATE_PROBES: readonly StateProbe[] = [
  {
    // Draft SellerProfile, music-production category.
    query: "Music Production",
    positiveSellerName: "Marc-André Pierre",
    positiveOfferingTitle: "Haitian dancehall single production — remote",
    negativeTitle: "Hidden active offering behind draft profile",
    negativeSellerName: "Draft Profile Seller",
  },
  {
    // Suspended SellerProfile, live-performance category.
    query: "Live Performance",
    positiveSellerName: "Selene García",
    positiveOfferingTitle: "Bachata and merengue live performance",
    negativeTitle: "Active offering behind suspended profile",
    negativeSellerName: "Suspended Profile Seller",
  },
  {
    // Suspended Workspace, mixing category.
    query: "Mixing",
    positiveSellerName: "Junior Roberts",
    positiveOfferingTitle: "Dancehall and hip-hop mixing — remote",
    negativeTitle: "Active offering under a suspended workspace",
    negativeSellerName: "Suspended Workspace Seller",
  },
  {
    // Buyer-only workspace (no Seller capability), music-production
    // category.
    query: "Music Production",
    positiveSellerName: "Marc-André Pierre",
    positiveOfferingTitle: "Haitian dancehall single production — remote",
    negativeTitle: "Active offering on a buyer-only workspace",
    negativeSellerName: "Buyer-Only Seller Profile",
  },
  {
    // Draft-only offerings, songwriting category.
    query: "Songwriting",
    positiveSellerName: "Keisha Williams",
    positiveOfferingTitle: "Afrobeats and R&B topline writing — remote",
    negativeTitle: "Draft writing offering",
    negativeSellerName: "Draft-Only Offerings Seller",
  },
  {
    // Paused-only offerings, music-production category.
    query: "Music Production",
    positiveSellerName: "Marc-André Pierre",
    positiveOfferingTitle: "Haitian dancehall single production — remote",
    negativeTitle: "Paused production offering",
    negativeSellerName: "Paused-Only Offerings Seller",
  },
  {
    // Archived-only offerings, mixing category.
    query: "Mixing",
    positiveSellerName: "Junior Roberts",
    positiveOfferingTitle: "Dancehall and hip-hop mixing — remote",
    negativeTitle: "Archived mixing offering",
    negativeSellerName: "Archived-Only Offerings Seller",
  },
];

interface MixedHiddenProbe {
  /** Query that selects the inactive sibling's category (positive control included). */
  query: string;
  /** Positive control: the canonical seller who shares the inactive sibling's category. */
  positiveSellerName: string;
  /** Positive control: the canonical offering title. */
  positiveOfferingTitle: string;
  /** Paused/Archived sibling title that must not appear in the rendered cards. */
  negativeTitle: string;
  /** Mixed-lifecycle seller name that must not appear in the rendered cards. */
  negativeSellerName: string;
}

const MIXED_HIDDEN_PROBES: readonly MixedHiddenProbe[] = [
  {
    // Mixed Active+Paused: the Paused sibling is "Paused songwriting
    // add-on" (category: songwriting). Querying "Songwriting" must
    // surface the canonical Keisha Williams but never the Paused
    // offering nor the Mixed Paused seller.
    query: "Songwriting",
    positiveSellerName: "Keisha Williams",
    positiveOfferingTitle: "Afrobeats and R&B topline writing — remote",
    negativeTitle: "Paused songwriting add-on",
    negativeSellerName: "Mixed Paused Seller",
  },
  {
    // Mixed Active+Archived: the Archived sibling is "Archived
    // production offering" (category: music-production). Querying
    // "Music Production" must surface the canonical Marc-André Pierre
    // but never the Archived offering nor the Mixed Archived seller.
    query: "Music Production",
    positiveSellerName: "Marc-André Pierre",
    positiveOfferingTitle: "Haitian dancehall single production — remote",
    negativeTitle: "Archived production offering",
    negativeSellerName: "Mixed Archived Seller",
  },
];

interface MixedActiveProbe {
  /** Query that selects only the Active sibling's category. */
  query: string;
  /** The mixed-lifecycle seller who must render under this query. */
  expectedSellerName: string;
  /** The Active sibling offering title that must render under this query. */
  expectedOfferingTitle: string;
}

const MIXED_ACTIVE_PROBES: readonly MixedActiveProbe[] = [
  {
    // Mixed Paused: Active sibling is "Active session vocals for
    // Caribbean releases" (category: session-vocals).
    query: "Session Vocals",
    expectedSellerName: "Mixed Paused Seller",
    expectedOfferingTitle: "Active session vocals for Caribbean releases",
  },
  {
    // Mixed Archived: Active sibling is "Active custom composition for
    // releases" (category: custom-composition).
    query: "Custom Composition",
    expectedSellerName: "Mixed Archived Seller",
    expectedOfferingTitle: "Active custom composition for releases",
  },
];

async function submitSearch(page: Page, query: string) {
  // Navigate home for each probe so any prior rendered state is
  // discarded deterministically. Each probe starts from a known
  // empty-state page.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Find Caribbean talent" })).toBeVisible();
  await page.getByTestId("search-input").fill(query);
  await page.getByTestId("search-submit").click();
  const cards = page.getByTestId("result-card");
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });
  return cards;
}

test("M1.3: every per-state negative eligibility fixture is excluded from the browser-visible result list", async ({
  page,
}) => {
  for (const probe of STATE_PROBES) {
    const cards = await submitSearch(page, probe.query);

    // Positive control: the canonical seller for this category must
    // render under the same query, so the negative absence is
    // non-vacuous. The card filter targets the rendered card list,
    // not the raw body text, so the assertion proves the canonical
    // card actually surfaced.
    const positiveCard = cards.filter({ hasText: probe.positiveSellerName }).first();
    await expect(positiveCard, `positive control missing for query "${probe.query}"`).toBeVisible();
    await expect(positiveCard.getByTestId("result-offering-title")).toHaveText(
      probe.positiveOfferingTitle,
    );

    // Read the entire rendered card list as a single text blob so a
    // single substring assertion covers the negative title and seller
    // name across every card (no per-card indexing required).
    const bodyText = (await page.textContent("body")) ?? "";
    expect(
      bodyText.includes(probe.negativeTitle),
      `negative title "${probe.negativeTitle}" must not appear for query "${probe.query}"`,
    ).toBe(false);
    expect(
      bodyText.includes(probe.negativeSellerName),
      `negative seller name "${probe.negativeSellerName}" must not appear for query "${probe.query}"`,
    ).toBe(false);
  }
});

test("M1.3: mixed Active+Paused and Active+Archived sellers surface only the Active offering", async ({
  page,
}) => {
  // Inactive-sibling probes: the Paused/Archived sibling must be
  // hidden when queried by the inactive sibling's category; the
  // canonical positive control proves the query is non-vacuous.
  for (const probe of MIXED_HIDDEN_PROBES) {
    const cards = await submitSearch(page, probe.query);

    const positiveCard = cards.filter({ hasText: probe.positiveSellerName }).first();
    await expect(positiveCard, `positive control missing for query "${probe.query}"`).toBeVisible();

    const bodyText = (await page.textContent("body")) ?? "";
    expect(
      bodyText.includes(probe.negativeTitle),
      `inactive sibling title "${probe.negativeTitle}" must not appear for query "${probe.query}"`,
    ).toBe(false);
    expect(
      bodyText.includes(probe.negativeSellerName),
      `mixed-lifecycle seller name "${probe.negativeSellerName}" must not appear for query "${probe.query}"`,
    ).toBe(false);
  }

  // Active-sibling probes: the Active sibling must render under a
  // query that selects only the Active category. This is the
  // required positive "only the Active offering renders" half of
  // the mixed-lifecycle contract.
  for (const probe of MIXED_ACTIVE_PROBES) {
    const cards = await submitSearch(page, probe.query);
    const activeCard = cards.filter({ hasText: probe.expectedSellerName }).first();
    await expect(
      activeCard,
      `mixed-lifecycle seller "${probe.expectedSellerName}" must render under query "${probe.query}"`,
    ).toBeVisible();
    await expect(activeCard.getByTestId("result-offering-title")).toHaveText(
      probe.expectedOfferingTitle,
    );
  }
});
