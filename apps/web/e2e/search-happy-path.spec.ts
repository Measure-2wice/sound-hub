import { test, expect } from "@playwright/test";

// The seeded non-null avatar URL is composed from a configurable fixture
// origin (PUBLIC_FIXTURE_ORIGIN) plus the path under
// `apps/web/public/fixtures/...`. Playwright passes the same origin to
// both the seed process and the browser, so the absolute URL the
// browser sees matches what the test asserts below.
const FIXTURE_ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const KEISHA_AVATAR_URL = `${FIXTURE_ORIGIN}/fixtures/sellers/keisha-williams/avatar.svg`;

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
//   - Query-only results surface a qualitative-fit block (P1-001 Codex
//     remediation) via `textCoverage` so the buyer receives both the
//     deterministic `matchReason` evidence and a distinct
//     non-percentage qualitative-fit presentation, exactly as Issue #6
//     requires for the public acceptance criterion.
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

  // Qualitative fit: a factual non-percentage coverage statement derived
  // from the deterministic matched/total counts the search service
  // produces. The happy path issues a query-only request, so the service
  // emits `textCoverage` (the brief-coverage line) and the
  // `result-qualitative-fit` block must be present with the matched-vs-
  // total token fact. Neither percentage nor score-derived confidence
  // band ever surfaces (P1-001 Codex remediation).
  const qualitativeFit = top.getByTestId("result-qualitative-fit-text");
  await expect(qualitativeFit.first()).toBeVisible();
  const qualitativeText = (await qualitativeFit.first().textContent()) ?? "";
  expect(qualitativeText).not.toMatch(/relevanceScore/i);
  expect(qualitativeText).not.toMatch(/\b\d{1,3}%\s*(match|confidence|fit)/i);
  // The matched/total brief-coverage wording is the buyer-facing fact.
  expect(qualitativeText).toMatch(
    /matches \d+ of \d+ words? from your brief|matches all \d+ words? of your brief/i,
  );

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
  await expect(top.getByTestId("result-offering-category")).toHaveText("Music Production");
  await expect(top.getByTestId("result-offering-service-mode")).toHaveText("Remote");
  await expect(top.getByTestId("result-based-in")).toContainText("Brooklyn");
  await expect(top.getByTestId("result-based-in")).toContainText("US");
  await expect(top.getByTestId("result-offering-service-areas")).toContainText("US");
  await expect(top.getByTestId("result-offering-genres")).toContainText("Dancehall");

  // Current location and Caribbean affiliation are labeled distinctly so that
  // residence is never presented as regional connection.
  const cardText = (await top.textContent()) ?? "";
  expect(cardText).toMatch(/Based in:/);
  expect(cardText).toMatch(/Caribbean affiliation:/);
  expect(cardText).toMatch(/Service area:/);

  // Structured, non-binding pricing.
  await expect(top.getByTestId("result-offering-pricing")).toHaveText(
    "Starting at 600.00 USD/track",
  );
  await expect(top.getByTestId("result-offering-pricing-disclaimer")).toContainText("non-binding");
  await expect(top.getByTestId("result-offering-pricing-disclaimer")).toContainText(
    "approved terms",
  );
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
  await expect(mastering.getByTestId("result-offering-pricing")).toHaveText("Not advertised");
  await expect(mastering.getByTestId("result-offering-pricing-disclaimer")).toContainText(
    "non-binding",
  );
  await expect(mastering.getByTestId("result-offering-pricing-disclaimer")).toContainText(
    "approved terms",
  );
  await expect(mastering.getByTestId("result-offering-category")).toHaveText("Mastering");

  // relevanceScore still never surfaces as buyer-facing confidence.
  const bodyText = (await page.textContent("body")) ?? "";
  expect(bodyText).not.toMatch(/Match Score:\s*\d+%/);
  expect(bodyText).not.toMatch(/relevanceScore/i);
  expect(bodyText).not.toMatch(/\b\d{1,3}%\s*(match|confidence)/i);
});

test("presents Fixed pricing and the approved optional seller avatar", async ({ page }) => {
  await page.goto("/");

  // The seeded topline fixture is the canonical Fixed-pricing offering and
  // the canonical non-null `avatarUrl` seller.
  await page.getByTestId("search-input").fill("topline");
  await page.getByTestId("search-submit").click();

  const cards = page.getByTestId("result-card");
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });

  const topline = cards.filter({ hasText: "Afrobeats and R&B topline writing" }).first();
  await expect(topline).toBeVisible();
  await expect(topline.getByTestId("result-seller-name")).toHaveText("Keisha Williams");

  // Fixed pricing renders with the currency's own minor-unit exponent
  // (USD has two), and is still framed as non-binding.
  await expect(topline.getByTestId("result-offering-pricing")).toHaveText(
    "Fixed 1200.00 USD/track",
  );
  await expect(topline.getByTestId("result-offering-pricing-disclaimer")).toContainText(
    "non-binding",
  );
  await expect(topline.getByTestId("result-offering-pricing-disclaimer")).toContainText(
    "approved terms",
  );

  // The approved optional public professional identity includes the avatar.
  // The fixture URL points to a deterministic SVG served from the web app's
  // public/ directory so the browser actually loads it; the naturalWidth
  // check proves the image completed loading rather than rendering as a
  // broken-image placeholder (an attribute-only check would pass even when
  // the browser could not resolve the src).
  const avatar = topline.getByTestId("result-seller-avatar");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("src", KEISHA_AVATAR_URL);
  await expect(avatar).toHaveAttribute("alt", "Keisha Williams profile image");
  const naturalWidth = await avatar.evaluate((img) =>
    img instanceof HTMLImageElement ? img.naturalWidth : 0,
  );
  expect(naturalWidth).toBeGreaterThan(0);

  // The avatar must not leak private identity data alongside it.
  const cardText = (await topline.textContent()) ?? "";
  expect(cardText).not.toMatch(/@|workspace|wallet|embedding/i);
});

test("presents ContactForQuote pricing as non-binding", async ({ page }) => {
  await page.goto("/");

  // The seeded bachata fixture advertises ContactForQuote rather than an
  // amount. It must read as an invitation to discuss, never as a quote.
  await page.getByTestId("search-input").fill("bachata");
  await page.getByTestId("search-submit").click();

  const cards = page.getByTestId("result-card");
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });

  const live = cards.filter({ hasText: "Bachata and merengue live performance" }).first();
  await expect(live).toBeVisible();
  await expect(live.getByTestId("result-offering-pricing")).toHaveText("Contact for quote");
  await expect(live.getByTestId("result-offering-pricing-disclaimer")).toContainText("non-binding");
  await expect(live.getByTestId("result-offering-pricing-disclaimer")).toContainText(
    "approved terms",
  );

  // Sellers with no avatar render no image rather than a broken one.
  await expect(live.getByTestId("result-seller-avatar")).toHaveCount(0);
});
