"use client";

// Specialty multi-select chips (M2 #84).
//
// Background: the Professional Profile editor lets a Seller pick
// one or more controlled Specialties from the canonical catalog
// returned by `GET /api/metadata/seller-profile-taxonomy`. The
// chips are driven by that response — NEVER by a hard-coded
// taxonomy — so the editor stays synchronized with the canonical
// Specialty catalog the API validates against.
//
// This component is the multi-select parallel of `DisciplineChips`
// (which is single-select with a clear-on-re-click affordance). The
// Specialty selection is a multi-select where the parent owns
// the selected set; this component does not own state.
//
// Each chip is a `min-h-[44px]` control so it meets the WCAG 2.5.5
// target-size minimum that post-#83 standardised for every
// interactive element.

"use client";

import type { SellerProfileTaxonomyItemSpecialtyV1 } from "@soundhub/types";

export interface SpecialtyChipsProps {
  readonly specialties: readonly SellerProfileTaxonomyItemSpecialtyV1[];
  readonly selectedKeys: readonly string[];
  readonly onToggle: (key: string) => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

export function SpecialtyChips({
  specialties,
  selectedKeys,
  onToggle,
  disabled = false,
  ariaLabel = "Specialties",
}: SpecialtyChipsProps) {
  if (specialties.length === 0) {
    return null;
  }
  const selectedSet = new Set(selectedKeys);
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex flex-wrap gap-2"
      data-testid="specialty-chips"
    >
      {specialties.map((specialty) => {
        const isSelected = selectedSet.has(specialty.key);
        return (
          <button
            key={specialty.key}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(specialty.key)}
            aria-pressed={isSelected}
            className={`shrink-0 inline-flex items-center gap-2 min-h-[44px] min-w-[44px] px-4 py-2 rounded-md text-sm font-medium transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine disabled:opacity-50 disabled:cursor-not-allowed ${
              isSelected
                ? "bg-aubergine text-canvas"
                : "bg-canvas border border-borderWarm text-ink hover:bg-surface"
            }`}
            data-testid={`specialty-chip-${specialty.key}`}
            data-selected={isSelected ? "true" : "false"}
          >
            <span aria-hidden="true" className="font-bold">
              {isSelected ? "✓" : "+"}
            </span>
            {specialty.name}
          </button>
        );
      })}
    </div>
  );
}
