"use client";

// Filters disclosure wrapper (post-#83 visual-parity pass).
//
// Background: the Stitch `soundhub_find_caribbean_talent_desktop/code.html`
// hides the structured required filters behind a single "Filters" button
// (with an active-filter count badge) and expands a clean tray on click.
// The page used to expose every strict-filter input inline so a first-
// time buyer was presented with nine raw fields at once — clearly a
// developer-facing surface, not a marketplace surface.
//
// Behavior preserved (M2 #83): every underlying field, its `data-testid`,
// its field-error rendering, and its request-payload semantics are owned
// by `RequiredFilters.tsx`. This wrapper only adds the disclosure chrome
// (toggle button + count badge + collapsible tray + Apply / Reset) and
// delegates the rest. The `setFilters` callback therefore receives the
// same `RequiredFiltersValue` it received before; no schema drift is
// possible from this wrapper.
//
// Count badge contract:
//   - Count is computed from the canonical `RequiredFiltersValue` (not
//     from any re-derived state) so the count always matches the
//     payload the API will receive on the next submit. The same
//     `hasUsableCriteria` predicate that powers the page-level empty-
//     submission guard is reused here so the two stay in lockstep.
//   - The count excludes empty/whitespace trimmed sub-fields so the
//     badge never displays "5" while the underlying filters are all
//     blank.

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import {
  hasUsableCriteria,
  isLocationFilterValueNonEmpty,
  type RequiredFiltersValue,
} from "../lib/talent-search-request-builder";

export interface FiltersDisclosureProps {
  readonly value: RequiredFiltersValue;
  readonly onChange: (next: RequiredFiltersValue) => void;
  /**
   * The structured filter surface — every field, its `data-testid`,
   * its `fieldErrors` rendering. This wrapper does not own or render
   * the fields themselves.
   */
  readonly children: ReactNode;
  /**
   * Optional forced-open state for tests or for the page to render
   * the disclosure expanded by default.
   */
  readonly defaultOpen?: boolean;
  /**
   * Force the disclosure panel open when this flag is true. The
   * page passes `true` when the latest submission produced a
   * controlled required-filter field error, so the buyer can see
   * the error beside the matching control without manually
   * discovering the closed tray.
   *
   * Lifecycle (Tenki review, P2-001): `forceOpen` is a one-shot
   * surfacing signal — flipping it to `true` opens the tray;
   * flipping it back to `false` honors the buyer's manual
   * choice captured under `open`. While `forceOpen` is true the
   * buyer may still collapse the tray (the toggle button is the
   * user-facing affordance for that) — the collapse is captured
   * in `userDismissedForce`, not by mutating `open`, so the
   * follow-up `forceOpen=false` reverts to the buyer's prior
   * `open` choice (default-closed) rather than to the
   * post-collapse state.
   *
   * Defaults to false to preserve the closed-by-default Stitch
   * composition; the page is the sole authority for when a
   * visible error warrants surfacing the tray.
   */
  readonly forceOpen?: boolean;
}

function countActiveFilters(filters: RequiredFiltersValue): number {
  let count = 0;
  if (filters.primaryCategoryKey.length > 0) count += 1;
  if (filters.independentlyPurchasableServiceKey.length > 0) count += 1;
  count += filters.serviceModes.length;
  if (isLocationFilterValueNonEmpty(filters.basedIn)) count += 1;
  if (isLocationFilterValueNonEmpty(filters.serviceArea)) count += 1;
  return count;
}

export function FiltersDisclosure({
  value,
  onChange,
  children,
  defaultOpen = false,
  forceOpen = false,
}: FiltersDisclosureProps) {
  // Lifecycle (Tenki review, P2-001): `forceOpen` opens the tray
  // while it is true. The buyer may collapse the tray via the
  // toggle — that click flips `userDismissedForce`, NOT `open`,
  // so the buyer's manual `open` choice (default-closed) is
  // preserved when `forceOpen` flips back to false. A subsequent
  // error (forceOpen re-asserting true) resets the dismissal so
  // the new error surfaces the tray.
  const [open, setOpen] = useState(defaultOpen);
  const [userDismissedForce, setUserDismissedForce] = useState(false);
  // Reset `userDismissedForce` on every `forceOpen` transition.
  // The deps array intentionally uses only `forceOpen` — `open`
  // and the dismiss flag themselves must NOT trigger this effect.
  useEffect(() => {
    setUserDismissedForce(false);
  }, [forceOpen]);
  const toggleId = useId();
  const effectiveOpen = forceOpen ? !userDismissedForce : open;

  const activeCount = countActiveFilters(value);
  // `hasUsableCriteria` accepts a query string but the count is purely
  // about the structured filter set. Passing an empty query is the
  // canonical way to evaluate just the filter half of the predicate.
  const filtersAreUsable = hasUsableCriteria("", value);

  const handleReset = useCallback(() => {
    onChange({
      primaryCategoryKey: "",
      independentlyPurchasableServiceKey: "",
      serviceModes: [],
      basedIn: { city: "", region: "", countryCode: "" },
      serviceArea: { city: "", region: "", countryCode: "" },
    });
  }, [onChange]);

  // Toggle handler (Tenki review, P2-001): the click always flips
  // the visible `effectiveOpen` state regardless of which branch
  // drives it. While `forceOpen` is true, the click targets the
  // dismissal flag (so the buyer's prior `open` choice stays
  // intact for the follow-up `forceOpen=false` transition); once
  // `forceOpen` releases, the click targets `open` directly.
  const handleToggle = useCallback(() => {
    if (forceOpen) {
      setUserDismissedForce((dismissed) => !dismissed);
    } else {
      setOpen((value) => !value);
    }
  }, [forceOpen]);

  return (
    <section data-testid="filters-disclosure" aria-label="Search filters">
      <button
        type="button"
        id={toggleId}
        aria-expanded={effectiveOpen}
        aria-controls={`${toggleId}-panel`}
        onClick={handleToggle}
        className="inline-flex items-center gap-2 min-h-[44px] min-w-[44px] px-4 py-2.5 rounded-lg bg-canvas border border-borderWarm text-ink hover:bg-surface focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine transition-colors"
        data-testid="filters-disclosure-toggle"
      >
        <span aria-hidden="true" className="text-seaGlass">
          ⌕
        </span>
        <span className="font-medium">Filters</span>
        <span
          className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-aubergine text-canvas text-xs font-semibold"
          data-testid="filters-disclosure-count"
          data-active={activeCount > 0 ? "true" : "false"}
        >
          {activeCount}
        </span>
        <span
          aria-hidden="true"
          className={`text-muted transition-transform ${effectiveOpen ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>

      {effectiveOpen && (
        <div
          id={`${toggleId}-panel`}
          className="mt-3 bg-canvas border border-borderWarm rounded-xl p-5 lg:p-6"
          data-testid="filters-disclosure-panel"
        >
          <div className="flex items-start justify-between gap-3 mb-4">
            <p className="text-xs text-muted">
              Filters exclude sellers that do not match. They are strict requirements, not
              preferences, and are not relaxed on empty results.
            </p>
            <button
              type="button"
              onClick={handleReset}
              disabled={!filtersAreUsable}
              className="shrink-0 inline-flex items-center justify-center min-h-[44px] px-3 py-1.5 rounded-md text-xs uppercase tracking-wider font-semibold text-muted hover:text-aubergine disabled:opacity-40 disabled:hover:text-muted focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
              data-testid="filters-disclosure-reset"
            >
              Reset
            </button>
          </div>
          {children}
        </div>
      )}
    </section>
  );
}
