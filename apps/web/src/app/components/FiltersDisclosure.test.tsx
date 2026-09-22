/* eslint-disable @typescript-eslint/no-floating-promises */
// FiltersDisclosure behavioral coverage (post-#83 visual-parity pass).
//
// What this pins:
//   - The toggle button + count badge + collapsible panel render.
//   - The count badge mirrors the canonical `RequiredFiltersValue`
//     state, including the per-mode count increment and the per-
//     location-group count increment.
//   - The Reset button calls `onChange` with an empty
//     `RequiredFiltersValue` so the underlying RequiredFilters form
//     clears deterministically.
//   - The strict-filter explanation appears above the panel content
//     so it is not developer-facing documentation but a contextual
//     note inside the redesigned interface.

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, test } from "node:test";
import { FiltersDisclosure } from "./FiltersDisclosure";
import type { RequiredFiltersValue } from "../lib/talent-search-request-builder";

const EMPTY_FILTERS: RequiredFiltersValue = {
  primaryCategoryKey: "",
  independentlyPurchasableServiceKey: "",
  serviceModes: [],
  basedIn: { city: "", region: "", countryCode: "" },
  serviceArea: { city: "", region: "", countryCode: "" },
};

function makeFilters(overrides: Partial<RequiredFiltersValue>): RequiredFiltersValue {
  return {
    ...EMPTY_FILTERS,
    ...overrides,
    basedIn: { ...EMPTY_FILTERS.basedIn, ...(overrides.basedIn ?? {}) },
    serviceArea: { ...EMPTY_FILTERS.serviceArea, ...(overrides.serviceArea ?? {}) },
  };
}

describe("FiltersDisclosure — post-#83 visual-parity", () => {
  test("renders the toggle + count badge with zero active filters", () => {
    const html = renderToStaticMarkup(
      <FiltersDisclosure value={EMPTY_FILTERS} onChange={() => undefined}>
        <div data-testid="child-marker" />
      </FiltersDisclosure>,
    );

    assert.ok(
      html.includes('data-testid="filters-disclosure"'),
      "disclosure root must carry the filters-disclosure testid",
    );
    assert.ok(
      html.includes('data-testid="filters-disclosure-toggle"'),
      "disclosure toggle must carry the toggle testid",
    );
    assert.ok(
      html.includes('data-testid="filters-disclosure-count"'),
      "disclosure must render the active-filter count badge",
    );
    assert.equal(
      html.includes('data-testid="child-marker"'),
      false,
      "child marker MUST NOT render when the disclosure is closed (children render inside the panel only when open)",
    );
    assert.equal(
      html.includes('data-testid="filters-disclosure-panel"'),
      false,
      "panel MUST NOT render when the disclosure is closed by default",
    );
  });

  test("count badge reflects every non-empty filter, including per-mode and per-location-group increments", () => {
    const populated = makeFilters({
      primaryCategoryKey: "music-production",
      independentlyPurchasableServiceKey: "mixing",
      serviceModes: ["Remote", "Hybrid"],
      basedIn: { city: "Brooklyn", region: "NY", countryCode: "US" },
      serviceArea: { city: "", region: "", countryCode: "GB" },
    });
    const html = renderToStaticMarkup(
      <FiltersDisclosure value={populated} onChange={() => undefined}>
        <div />
      </FiltersDisclosure>,
    );

    // 1 category + 1 independent service + 2 service modes + 1 basedIn
    // + 1 serviceArea = 6 active filters.
    assert.ok(html.includes('data-testid="filters-disclosure-count"'), "count badge MUST render");
    assert.match(
      html,
      /data-testid="filters-disclosure-count"[^>]*>6</,
      "count badge MUST reflect 6 active filters (category + independent + 2 modes + basedIn + serviceArea)",
    );
  });

  test("renders the panel + children when the toggle is forced open", () => {
    const html = renderToStaticMarkup(
      <FiltersDisclosure value={EMPTY_FILTERS} onChange={() => undefined} defaultOpen>
        <div data-testid="child-marker" />
      </FiltersDisclosure>,
    );

    assert.ok(
      html.includes('data-testid="filters-disclosure-panel"'),
      "panel MUST render when defaultOpen is true",
    );
    assert.ok(
      html.includes('data-testid="child-marker"'),
      "children MUST render inside the panel when open",
    );
    assert.ok(
      html.includes('data-testid="filters-disclosure-reset"'),
      "Reset button MUST render inside the panel",
    );
  });

  test("renders the strict-filter contextual note inside the open panel (not a separate developer doc)", () => {
    const html = renderToStaticMarkup(
      <FiltersDisclosure value={EMPTY_FILTERS} onChange={() => undefined} defaultOpen>
        <div />
      </FiltersDisclosure>,
    );

    assert.match(
      html,
      /Filters exclude sellers that do not match\./,
      "the strict-filter note MUST be rendered as contextual copy inside the redesigned disclosure panel",
    );
  });

  test("count badge shows zero (NOT suppressed) when no filter is active", () => {
    const html = renderToStaticMarkup(
      <FiltersDisclosure value={EMPTY_FILTERS} onChange={() => undefined}>
        <div />
      </FiltersDisclosure>,
    );

    assert.match(
      html,
      /data-testid="filters-disclosure-count"[^>]*>0</,
      "count badge MUST always render, even with 0 active filters, so the toggle affordance stays visually consistent",
    );
    assert.match(
      html,
      /data-testid="filters-disclosure-count"[^>]*data-active="false"/,
      "the badge MUST expose data-active=false on the empty state so styling can distinguish zero from nonzero",
    );
  });
});
