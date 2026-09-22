/* eslint-disable @typescript-eslint/no-floating-promises */
// DisciplineChips behavioral coverage (post-#83 visual-parity pass).
//
// What this pins:
//   - The chips row reads ONLY from the canonical
//     `CategoryMetadataItemV1[]` response — never a hard-coded list.
//     A regression that hard-codes the row fails here.
//   - The active chip is marked with `aria-pressed="true"` and a
//     stable `data-testid` derived from the category key so the page
//     can target it.
//   - An empty category list renders nothing (no fabricated taxonomy).
//   - Each chip meets the `min-h-[44px]` / `min-w-[44px]` target size
//     because the post-#83 visual-parity brief standardises 44px
//     interactive targets.

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, test } from "node:test";
import { DisciplineChips } from "./DisciplineChips";
import type { CategoryMetadataItemV1 } from "@soundhub/types";

const CATEGORIES: readonly CategoryMetadataItemV1[] = [
  { key: "music-production", name: "Music Production" },
  { key: "mixing", name: "Mixing" },
  { key: "vocal-arrangement", name: "Vocal Arrangement" },
];

describe("DisciplineChips — post-#83 visual-parity", () => {
  test("renders one chip per canonical category and only per canonical category", () => {
    const html = renderToStaticMarkup(
      <DisciplineChips categories={CATEGORIES} activeKey="" onSelect={() => undefined} />,
    );

    for (const category of CATEGORIES) {
      assert.ok(
        html.includes(`discipline-chip-${category.key}`),
        `chip for canonical category "${category.key}" MUST render`,
      );
      assert.ok(
        html.includes(category.name),
        `chip label MUST be the canonical category name "${category.name}"`,
      );
    }

    // No fabricated taxonomy: the row carries exactly N chips for the
    // canonical N categories. A regression that adds a fourth chip
    // from a hard-coded list fails this.
    const chipMatches = html.match(/data-testid="discipline-chip-/g) ?? [];
    assert.equal(
      chipMatches.length,
      CATEGORIES.length,
      "the chip row MUST render exactly the canonical categories, no more",
    );
  });

  test("active chip carries aria-pressed=true and the data-active attribute", () => {
    const html = renderToStaticMarkup(
      <DisciplineChips
        categories={CATEGORIES}
        activeKey="music-production"
        onSelect={() => undefined}
      />,
    );

    // Capture each chip's full button tag so the assertion is robust to
    // attribute order. The chip's data-testid is unique per category key.
    const activeMatch = html.match(
      /<button[^>]*data-testid="discipline-chip-music-production"[^>]*>[\s\S]*?<\/button>/,
    );
    assert.ok(activeMatch, "the active chip MUST render as a <button>");
    const activeTag = activeMatch[0];
    assert.match(activeTag, /aria-pressed="true"/, "the active chip MUST expose aria-pressed=true");
    assert.match(activeTag, /data-active="true"/, "the active chip MUST expose data-active=true");

    const inactiveMatch = html.match(
      /<button[^>]*data-testid="discipline-chip-mixing"[^>]*>[\s\S]*?<\/button>/,
    );
    assert.ok(inactiveMatch, "the inactive chip MUST render as a <button>");
    const inactiveTag = inactiveMatch[0];
    assert.match(
      inactiveTag,
      /aria-pressed="false"/,
      "non-active chips MUST expose aria-pressed=false",
    );
    assert.match(
      inactiveTag,
      /data-active="false"/,
      "non-active chips MUST expose data-active=false",
    );
  });

  test("renders nothing when the canonical category list is empty (no fabricated taxonomy)", () => {
    const html = renderToStaticMarkup(
      <DisciplineChips categories={[]} activeKey="" onSelect={() => undefined} />,
    );

    assert.equal(
      html,
      "",
      "the chip row MUST render an empty fragment when the canonical category list is empty — never a hard-coded fallback",
    );
  });

  test("every chip meets the WCAG 2.5.5 44px target-size minimum", () => {
    // The post-#83 visual-parity brief standardises 44px interactive
    // targets across the redesigned surface. A regression that drops
    // `min-h-[44px]` / `min-w-[44px]` from a chip fails this test.
    const html = renderToStaticMarkup(
      <DisciplineChips categories={CATEGORIES} activeKey="" onSelect={() => undefined} />,
    );

    assert.ok(
      html.includes("min-h-[44px]") && html.includes("min-w-[44px]"),
      "every chip MUST include the 44px target-size classes for keyboard / touch accessibility",
    );
  });
});
