"use client";

// Discipline chips (post-#83 visual-parity pass).
//
// Background: the Stitch design surfaces a horizontal scrolling row of
// craft categories so a buyer can scope a search by discipline in one
// click. The chips are driven by the canonical `GET /api/metadata/categories`
// response — NEVER by a hard-coded taxonomy — so the on-page chips stay
// synchronized with the canonical category catalog the API validates
// against. The page is the only reader of these chips; the chips never
// invent a category the API has not confirmed.
//
// Behavior:
//   - Clicking a chip toggles the corresponding `primaryCategoryKey`:
//     clicking a chip that is already active clears the filter (the
//     underlying state is owned by the page, not by this component).
//   - The chips are presented as a horizontally scrollable strip so
//     the row never causes horizontal page overflow at narrow viewports
//     (the existing `overflow-x-hidden` rule on `html, body` is the
//     defense in depth; this row's `overflow-x-auto` is the
//     presentation guarantee).
//   - Each chip is a `min-h-[44px]` control so it meets the WCAG 2.5.5
//     target-size minimum that the post-#83 visual-parity pass
//     standardised for every interactive element.

import type { CategoryMetadataItemV1 } from "@soundhub/types";

export interface DisciplineChipsProps {
  readonly categories: readonly CategoryMetadataItemV1[];
  readonly activeKey: string;
  readonly onSelect: (key: string) => void;
}

export function DisciplineChips({ categories, activeKey, onSelect }: DisciplineChipsProps) {
  if (categories.length === 0) {
    return null;
  }
  return (
    <nav
      aria-label="Discipline shortcuts"
      className="flex items-center gap-2 overflow-x-auto pb-1"
      data-testid="discipline-chips"
    >
      {categories.map((category) => {
        const isActive = category.key === activeKey;
        return (
          <button
            key={category.key}
            type="button"
            onClick={() => onSelect(isActive ? "" : category.key)}
            aria-pressed={isActive}
            className={`shrink-0 whitespace-nowrap inline-flex items-center gap-2 min-h-[44px] min-w-[44px] px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine ${
              isActive
                ? "bg-aubergine text-canvas"
                : "bg-canvas border border-borderWarm text-ink hover:bg-surface"
            }`}
            data-testid={`discipline-chip-${category.key}`}
            data-active={isActive ? "true" : "false"}
          >
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-seaGlass" : "bg-muted/40"}`}
            />
            {category.name}
          </button>
        );
      })}
    </nav>
  );
}
