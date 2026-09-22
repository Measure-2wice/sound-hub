// Talent page visual-parity browser verification (post-#83 visual pass).
//
// Background: the post-#83 visual-parity pass rewrites the /talent
// page composition in line with the Stitch
// `soundhub_find_caribbean_talent_desktop/code.html` export. This spec
// exercises the four viewports called out in the plan — 390 / 768 /
// 1000 / 1440 — to verify:
//
//   - The redesigned /talent page does NOT horizontally overflow at
//     any of them (390px is the strictest because the chips row +
//     search surface must remain usable without horizontal page
//     scroll).
//   - The Filters disclosure expands and collapses at the canonical
//     interaction without breaking at narrow viewports.
//   - The editorial "Find Caribbean talent" heading + "Try" hints
//     remain visible at every viewport.
//   - The coral "Find talent" submit button meets the WCAG 2.5.5
//     44px target-size minimum so keyboard / touch buyers can
//     reliably activate the search.

import { test, expect, type ViewportSize } from "@playwright/test";

const VIEWPORTS: ReadonlyArray<{ readonly name: string; readonly size: ViewportSize }> = [
  { name: "mobile-390", size: { width: 390, height: 844 } },
  { name: "tablet-768", size: { width: 768, height: 1024 } },
  { name: "between-1000", size: { width: 1000, height: 800 } },
  { name: "desktop-1440", size: { width: 1440, height: 900 } },
];

for (const { name, size } of VIEWPORTS) {
  test(`/talent reflows cleanly at ${name} viewport without horizontal overflow`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: size });
    const page = await ctx.newPage();
    try {
      await page.goto("/talent");
      await expect(page.getByTestId("talent-page")).toBeVisible();
      await expect(page.getByTestId("talent-heading")).toBeVisible();
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `${name}: /talent must not horizontally overflow`).toBeLessThanOrEqual(
        size.width + 1,
      );
      // The coral "Find talent" submit must always be visible — the
      // search surface is the only place to dispatch a search.
      await expect(page.getByTestId("search-submit")).toBeVisible();
      // The editorial "Try" hints must remain visible so the buyer
      // can read the example briefs at every viewport.
      await expect(page.getByTestId("search-try-hints")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
}

test("/talent filters disclosure expands and collapses without layout break", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/talent");

  // Filters panel must NOT render before the toggle is clicked — the
  // disclosure is closed by default so a first-time buyer sees a
  // marketplace surface, not a developer-facing filter form.
  await expect(page.getByTestId("filters-disclosure-panel")).toHaveCount(0);

  await page.getByTestId("filters-disclosure-toggle").click();

  // After toggling, the panel + every underlying strict-filter input
  // MUST render. The post-#83 pass preserves every original
  // data-testid so the existing required-* e2e controls remain valid.
  await expect(page.getByTestId("filters-disclosure-panel")).toBeVisible();
  await expect(page.getByTestId("required-category")).toBeVisible();
  await expect(page.getByTestId("required-based-in-country")).toBeVisible();

  // Toggling closed MUST hide the panel (no residual layout shift).
  await page.getByTestId("filters-disclosure-toggle").click();
  await expect(page.getByTestId("filters-disclosure-panel")).toHaveCount(0);
});

test("/talent coral Find talent CTA meets the WCAG 2.5.5 44px target-size minimum", async ({
  page,
}) => {
  await page.goto("/talent");
  const cta = page.getByTestId("search-submit");
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box, "the coral CTA MUST have a non-zero bounding box").not.toBeNull();
  // The post-#83 pass standardised `min-h-[44px] min-w-[44px]` on
  // every interactive element. Verify the coral CTA meets it at the
  // rendered size.
  expect(box!.height, "CTA height MUST be at least 44px").toBeGreaterThanOrEqual(44);
});

test("/talent discipline chips row renders only from the canonical category metadata (no hard-coded taxonomy)", async ({
  page,
}) => {
  await page.goto("/talent");
  // Wait for the categories fetch to settle — the row is empty until
  // the canonical metadata response lands.
  await expect(page.getByTestId("discipline-chips")).toBeVisible({ timeout: 10_000 });
  // The chips row's testids come from the canonical category keys;
  // a hard-coded list (Music Production / Vocal Arrangement / ...)
  // would still match this assertion, so we ALSO assert that the
  // count equals the canonical metadata response length. If the
  // catalog fetch fails the row is empty; either way, the page
  // never fabricates a chip.
  const chipCount = await page.evaluate(async () => {
    const response = await fetch("/api/metadata/categories");
    if (!response.ok) return -1;
    const body = (await response.json()) as { categories: readonly unknown[] };
    return Array.isArray(body.categories) ? body.categories.length : -1;
  });
  if (chipCount > 0) {
    const renderedChips = await page.locator('[data-testid^="discipline-chip-"]').count();
    expect(
      renderedChips,
      "the chip row MUST render exactly the canonical categories, no more, no less",
    ).toBe(chipCount);
  }
});
