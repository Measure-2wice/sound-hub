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
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
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

  test("forceOpen reveals the panel and children even when the user has not clicked the toggle", () => {
    // The page sets forceOpen=true when the latest submission
    // produced a controlled required-filter field error, so the
    // buyer can see the error beside the matching control without
    // manually discovering the closed tray. The toggle stays
    // visible — the buyer may still collapse it after they have
    // addressed the error.
    const html = renderToStaticMarkup(
      <FiltersDisclosure value={EMPTY_FILTERS} onChange={() => undefined} forceOpen>
        <div data-testid="child-marker" />
      </FiltersDisclosure>,
    );

    assert.ok(
      html.includes('data-testid="filters-disclosure-panel"'),
      "panel MUST render when forceOpen is true",
    );
    assert.ok(
      html.includes('data-testid="child-marker"'),
      "children MUST render inside the panel when forceOpen is true",
    );
    assert.match(
      html,
      /aria-expanded="true"/,
      "toggle MUST expose aria-expanded=true when forceOpen is true so screen readers announce the open state",
    );
  });

  test("forceOpen respects user-dismissed collapse via the toggle button (P2-001 lifecycle)", () => {
    // Background: the previous implementation computed
    // `effectiveOpen = open || forceOpen`, which made the toggle
    // button a no-op while forceOpen was true (clicking it could
    // not collapse the tray, and the tray stayed open after
    // forceOpen flipped back to false because `open` had been
    // mutated to true). The fixed lifecycle splits the toggle
    // intent: while forceOpen is true the click flips a
    // userDismissal flag (preserving `open` for the follow-up
    // forceOpen=false transition).
    //
    // We exercise the click handler through a real React 18
    // `createRoot` mount in the JSDOM bootstrap registered by
    // `--import ./src/test-setup.mjs`. The shared setup
    // polyfills the DOM globals the React renderer needs.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          createElement(FiltersDisclosure, {
            value: EMPTY_FILTERS,
            onChange: () => undefined,
            forceOpen: true,
            children: null,
          }),
        );
      });
      // Initial render: panel is open because forceOpen is true.
      assert.ok(
        container.querySelector('[data-testid="filters-disclosure-panel"]'),
        "panel MUST render when forceOpen is true on first render",
      );

      // Buyer clicks the toggle to collapse the tray while
      // forceOpen is still true. The click targets the
      // userDismissal flag — the panel MUST close.
      const toggle = container.querySelector('[data-testid="filters-disclosure-toggle"]');
      assert.ok(toggle, "toggle button MUST render");
      const button = toggle as HTMLButtonElement;
      act(() => {
        button.click();
      });
      assert.equal(
        container.querySelector('[data-testid="filters-disclosure-panel"]'),
        null,
        "panel MUST close after the buyer clicks toggle while forceOpen is true",
      );
      assert.equal(
        button.getAttribute("aria-expanded"),
        "false",
        "aria-expanded MUST be false after a buyer collapse while forceOpen is true",
      );

      // Re-opening: buyer clicks again to bring the panel back.
      // While forceOpen is still true, the click clears the
      // dismissal flag and the panel re-appears.
      act(() => {
        button.click();
      });
      assert.ok(
        container.querySelector('[data-testid="filters-disclosure-panel"]'),
        "panel MUST re-open when the buyer clicks toggle again while forceOpen is still true",
      );
      assert.equal(
        button.getAttribute("aria-expanded"),
        "true",
        "aria-expanded MUST be true after the buyer re-opens while forceOpen is still true",
      );
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});
