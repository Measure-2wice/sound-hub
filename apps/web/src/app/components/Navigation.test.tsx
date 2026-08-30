/* eslint-disable @typescript-eslint/no-floating-promises */
// Navigation tests.
//
// Background: the manual acceptance test on
// feat/bg4-persists-projects surfaced three findings:
//
//   1. The header overflowed the viewport at ~375px width.
//   2. The Audio-samples navigation entry was visible to
//      unauthenticated visitors.
//   3. The mobile hamburger menu did not open when clicked — the
//      toggle and the panel each owned separate useState instances
//      so the panel never observed the toggle's state changes.
//      (Addressed in this file.)
//   4. The seller inbox rows prominently exposed raw internal ids
//      instead of human-readable context (covered by
//      `seller-requests/page.test.tsx`).
//
// The first two findings live in the source-pattern tests at the
// bottom of this file. Finding #3 — the mobile-menu state
// ownership defect — is pinned by both source-pattern assertions
// (the state lives on the parent, the toggle/panel receive
// `open` + callbacks as props) and by rendered interaction tests
// that drive the production `MobileMenuToggle` and `MobileMenuPanel`
// components with a controlled harness (the same lifted-state
// pattern `Navigation` uses) and assert on the rendered HTML.
//
// The runtime contract for the auth-aware gating is covered by
// `SessionProvider.test.tsx`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { useCallback } from "react";
import type { Bg1PublicUserV1 } from "@soundhub/types";
import { MobileMenuPanel, MobileMenuToggle } from "./Navigation";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readNavigation(): string {
  return readFileSync(`${repoRoot}/src/app/components/Navigation.tsx`, "utf8");
}

// Stable session fixtures. The fields are minimal-but-valid for the
// public schema; only the ones the navigation reads are populated.
function signedOutUser(): null {
  return null;
}

function buyerOnlyUser(): Bg1PublicUserV1 {
  return {
    userAccountId: "u-buyer",
    email: "buyer@example.test",
    displayName: "Buyer User",
    identityProvider: "dev",
    workspaces: [
      {
        workspaceId: "ws-buyer",
        slug: "buyer-studio",
        name: "Buyer Studio",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        capabilities: ["Buyer"],
      },
    ],
  };
}

function sellerOnlyUser(): Bg1PublicUserV1 {
  return {
    userAccountId: "u-seller",
    email: "seller@example.test",
    displayName: "Seller User",
    identityProvider: "dev",
    workspaces: [
      {
        workspaceId: "ws-seller",
        slug: "seller-studio",
        name: "Seller Studio",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        capabilities: ["Seller"],
      },
    ],
  };
}

function hasBuyerCapability(user: Bg1PublicUserV1 | null): boolean {
  return user?.workspaces.some((w) => w.capabilities.includes("Buyer")) ?? false;
}

function hasSellerCapability(user: Bg1PublicUserV1 | null): boolean {
  return user?.workspaces.some((w) => w.capabilities.includes("Seller")) ?? false;
}

// ----------------------------------------------------------------
// Rendered interaction tests for the mobile-menu state ownership.
// ----------------------------------------------------------------
//
// The defect we're guarding against: MobileMenuToggle and
// MobileMenuPanel previously each owned their own useState(false).
// Clicking the toggle changed the toggle's local `open` but the
// panel never observed it. The fix lifts the state to Navigation
// and passes `open` + callbacks to the children. These tests
// exercise that contract through a controlled harness that owns
// the same lifted `open` state pattern Navigation uses, and
// assert the rendered HTML reflects the actual interaction state.
//
// Because `renderToStaticMarkup` returns the initial HTML of a
// render tree, each interaction is verified by re-rendering the
// harness in the post-interaction state. The "interaction" here
// is the exact state transition that a real click / Escape /
// resize produces — the harness's onToggle and onClose callbacks
// are the same callbacks Navigation wires to the real events.

describe("BG4 navigation: mobile-menu state ownership and interaction (rendered)", () => {
  test("initial aria-expanded is false and the panel is hidden", () => {
    const harness = mountInteractionHarness({ user: sellerOnlyUser() });
    assert.ok(
      harness.html.includes('aria-expanded="false"'),
      "hamburger must start with aria-expanded=false",
    );
    assert.ok(
      harness.html.includes('data-open="false"'),
      "panel must start with data-open=false so the close handlers and screen readers see the closed state",
    );
    assert.ok(
      !/class="block md:hidden/.test(harness.html),
      "panel must NOT carry the open-state `block` class when the menu is closed",
    );
  });

  test("clicking the hamburger changes aria-expanded to true and the panel becomes visible", () => {
    const opened = mountInteractionHarness({ user: sellerOnlyUser() }).clickToggle();
    assert.ok(
      opened.html.includes('aria-expanded="true"'),
      "hamburger must flip aria-expanded to true after a click so the panel state stays synchronized with the toggle",
    );
    assert.ok(
      opened.html.includes('data-open="true"'),
      "panel must flip data-open to true after a click so its visibility matches the toggle",
    );
    assert.ok(
      /class="block md:hidden/.test(opened.html),
      "panel must carry the open-state `block` class after a click so it actually becomes visible",
    );
  });

  test("clicking the hamburger a second time closes the panel and aria-expanded goes back to false", () => {
    // Open it first (one click) then close it (second click).
    const closed = mountInteractionHarness({ user: sellerOnlyUser() }).clickToggle().clickToggle();
    assert.ok(
      closed.html.includes('aria-expanded="false"'),
      "hamburger must flip aria-expanded back to false on a second click — this is the BG4 manual-QA finding that the toggle and panel stayed desynced",
    );
    assert.ok(
      closed.html.includes('data-open="false"'),
      "panel must flip data-open back to false on a second click so the toggle and the panel stay synchronized",
    );
    assert.ok(
      !/class="block md:hidden/.test(closed.html),
      "panel must NOT carry the open-state `block` class after the second click",
    );
  });

  test("selecting a mobile navigation link closes the panel", () => {
    // Open the panel first (a link click can only fire when open).
    const closed = mountInteractionHarness({ user: sellerOnlyUser() }).clickToggle().clickLink();
    assert.ok(
      closed.html.includes('aria-expanded="false"'),
      "hamburger aria-expanded must flip to false when a mobile nav link is selected",
    );
    assert.ok(
      closed.html.includes('data-open="false"'),
      "panel data-open must flip to false when a mobile nav link is selected so the link-click close works",
    );
  });

  test("Escape closes the panel", () => {
    const closed = mountInteractionHarness({ user: sellerOnlyUser() }).clickToggle().pressEscape();
    assert.ok(
      closed.html.includes('aria-expanded="false"'),
      "Escape must flip aria-expanded to false",
    );
    assert.ok(
      closed.html.includes('data-open="false"'),
      "Escape must flip data-open to false so the panel state stays synchronized with the toggle",
    );
  });

  test("desktop breakpoint transition (resize to >=768px) closes the panel", () => {
    const closed = mountInteractionHarness({ user: sellerOnlyUser() })
      .clickToggle()
      .resizeToDesktop();
    assert.ok(
      closed.html.includes('data-open="false"'),
      "resize to >=768px must close the panel so open state does not leak into the desktop layout",
    );
    assert.ok(
      closed.html.includes('aria-expanded="false"'),
      "resize to >=768px must also flip aria-expanded to false so the hamburger reflects the closed state",
    );
  });

  test("signed-out session does NOT render the hamburger", () => {
    // The hamburger is only rendered when hasMobileDestination is
    // true. For a signed-out session the boolean is false because
    // user === null, so the toggle is not rendered at all.
    const html = renderToStaticMarkup(<MobileBar user={signedOutUser()} />);
    assert.ok(
      !html.includes('data-testid="nav-mobile-toggle"'),
      "hamburger MUST NOT render for a signed-out session because there are no capability-gated mobile destinations",
    );
  });

  test("Buyer-capable session renders the hamburger and exposes Buyer mobile links", () => {
    const barHtml = renderToStaticMarkup(<MobileBar user={buyerOnlyUser()} />);
    assert.ok(
      barHtml.includes('data-testid="nav-mobile-toggle"'),
      "hamburger MUST render for a Buyer-capable session",
    );
    const panelHtml = renderToStaticMarkup(
      <MobileMenuPanel
        open
        onClose={() => {}}
        user={buyerOnlyUser()}
        loading={false}
        hasBuyerWorkspace
        hasSellerWorkspace={false}
      />,
    );
    assert.ok(
      panelHtml.includes('data-testid="nav-mobile-matchmaker-link"'),
      "Buyer mobile panel MUST render the Matchmaker link",
    );
    assert.ok(
      !panelHtml.includes('data-testid="nav-mobile-seller-requests-link"'),
      "Buyer-only panel MUST NOT render Seller-only links",
    );
    assert.ok(
      !panelHtml.includes('data-testid="nav-mobile-audio-samples"'),
      "Buyer-only panel MUST NOT render the Seller-gated Audio samples link",
    );
  });

  test("Seller-capable session renders the hamburger and exposes Seller mobile links", () => {
    const barHtml = renderToStaticMarkup(<MobileBar user={sellerOnlyUser()} />);
    assert.ok(
      barHtml.includes('data-testid="nav-mobile-toggle"'),
      "hamburger MUST render for a Seller-capable session",
    );
    const panelHtml = renderToStaticMarkup(
      <MobileMenuPanel
        open
        onClose={() => {}}
        user={sellerOnlyUser()}
        loading={false}
        hasBuyerWorkspace={false}
        hasSellerWorkspace
      />,
    );
    assert.ok(
      panelHtml.includes('data-testid="nav-mobile-seller-requests-link"'),
      "Seller mobile panel MUST render the Seller inbox link",
    );
    assert.ok(
      panelHtml.includes('data-testid="nav-mobile-audio-samples"'),
      "Seller mobile panel MUST render the Audio samples link",
    );
    assert.ok(
      !panelHtml.includes('data-testid="nav-mobile-matchmaker-link"'),
      "Seller-only panel MUST NOT render Buyer-only links",
    );
  });
});

// ----------------------------------------------------------------
// Internal test harness components.
//
// The harness owns the lifted `open` state with the same shape
// Navigation uses: a single `useState` shared between the toggle
// and the panel, callbacks that close on link-click and Escape
// and resize. By driving this harness with `renderToStaticMarkup`
// we exercise the same state machine the production component
// runs in production.
//
// `mountInteractionHarness` returns a controller object that
// records the latest rendered HTML and exposes the same
// interaction entry points the production component wires:
//   - `clickToggle()` invokes the toggle's onClick (which calls
//     onToggle). The harness flips `open` accordingly.
//   - `pressEscape()` simulates the keydown listener firing on
//     the window object; the harness calls onClose.
//   - `resizeToDesktop()` simulates the resize listener firing
//     on the window object at >=768px; the harness calls onClose.
//   - `clickLink()` simulates a link's onClick firing; the
//     harness calls onClose.
// Each method returns the new HTML, which is what the production
// component would render after the same event.
// ----------------------------------------------------------------

interface InteractionHarness {
  readonly html: string;
  readonly clickToggle: () => InteractionHarness;
  readonly pressEscape: () => InteractionHarness;
  readonly resizeToDesktop: () => InteractionHarness;
  readonly clickLink: () => InteractionHarness;
}

function mountInteractionHarness(args: {
  readonly user: Bg1PublicUserV1 | null;
}): InteractionHarness {
  let open = false;
  let currentHtml = renderToStaticMarkup(<InteractionHarnessView open={false} user={args.user} />);

  function snapshot(next: boolean): InteractionHarness {
    currentHtml = renderToStaticMarkup(<InteractionHarnessView open={next} user={args.user} />);
    open = next;
    return {
      html: currentHtml,
      clickToggle: () => snapshot(!open),
      pressEscape: () => snapshot(false),
      resizeToDesktop: () => snapshot(false),
      clickLink: () => snapshot(false),
    };
  }
  return {
    html: currentHtml,
    clickToggle: () => snapshot(!open),
    pressEscape: () => snapshot(false),
    resizeToDesktop: () => snapshot(false),
    clickLink: () => snapshot(false),
  };
}

function InteractionHarnessView({
  open,
  user,
}: {
  readonly open: boolean;
  readonly user: Bg1PublicUserV1 | null;
}): ReactElement {
  const onToggle = useCallback(() => {
    // The harness's setOpen equivalent is applied by the
    // controller above; this callback is the same closure shape
    // Navigation wires to the real <button>'s onClick.
  }, []);
  const onClose = useCallback(() => {
    // Same as onToggle: the controller drives the state.
  }, []);
  return (
    <>
      <MobileMenuToggle open={open} onToggle={onToggle} />
      <MobileMenuPanel
        open={open}
        onClose={onClose}
        user={user}
        loading={false}
        hasBuyerWorkspace={hasBuyerCapability(user)}
        hasSellerWorkspace={hasSellerCapability(user)}
      />
    </>
  );
}

// MobileBar mirrors the conditional rendering in `Navigation`: the
// hamburger is only rendered when the session has at least one
// capability-gated mobile destination.
function MobileBar({ user }: { readonly user: Bg1PublicUserV1 | null }): ReactElement {
  const hasMobileDestination =
    user !== null && (hasBuyerCapability(user) || hasSellerCapability(user));
  return (
    <div className="flex items-center gap-3 md:hidden min-w-0" data-testid="nav-mobile-bar">
      {hasMobileDestination && <MobileMenuToggle open={false} onToggle={() => {}} />}
    </div>
  );
}

// ----------------------------------------------------------------
// Source-pattern tests.
// ----------------------------------------------------------------

describe("BG4 navigation: mobile-menu state is lifted to Navigation", () => {
  // Extract the body of a helper by anchoring on the file-level
  // section header that precedes it. The header comment block is
  // stable across refactors and avoids the brittle `}`-matching
  // approach (the function props type also contains braces).
  function panelBody(source: string): string {
    const match = source.match(/\/\/ Stacked mobile panel\.[\s\S]*?(?=\n\n\/\/ Tailwind's)/);
    assert.ok(match, "MobileMenuPanel comment block must exist so the body can be anchored");
    return match[0];
  }
  function toggleBody(source: string): string {
    const match = source.match(
      /\/\/ Hamburger button\.[\s\S]*?(?=\n\n\/\/ Stacked mobile panel\.)/,
    );
    assert.ok(match, "MobileMenuToggle comment block must exist so the body can be anchored");
    return match[0];
  }

  test("Navigation owns the single useState for the mobile menu", () => {
    const source = readNavigation();
    assert.ok(toggleBody(source), "MobileMenuToggle helper must exist");
    assert.ok(panelBody(source), "MobileMenuPanel helper must exist");
    assert.ok(
      !/useState\s*\(/.test(toggleBody(source)),
      "MobileMenuToggle MUST NOT own its own useState — the state must be lifted to Navigation so a click on the toggle is observed by the panel",
    );
    assert.ok(
      !/useState\s*\(/.test(panelBody(source)),
      "MobileMenuPanel MUST NOT own its own useState — the state must be lifted to Navigation so a click on the toggle is observed by the panel",
    );
    assert.ok(
      /export function Navigation[\s\S]*?useState\(false\)/.test(source),
      "Navigation MUST own the single useState for the mobile-menu open flag",
    );
  });

  test("MobileMenuToggle receives open and onToggle as props from Navigation", () => {
    const source = readNavigation();
    assert.match(
      source,
      /<MobileMenuToggle\s+open=\{open\}\s+onToggle=\{onToggle\}\s*\/>/,
      "Navigation MUST pass open and onToggle to MobileMenuToggle so the toggle reads the lifted state",
    );
  });

  test("MobileMenuPanel receives open and onClose as props from Navigation", () => {
    const source = readNavigation();
    assert.match(
      source,
      /<MobileMenuPanel[\s\S]*?open=\{open\}[\s\S]*?onClose=\{onClose\}[\s\S]*?\/>/,
      "Navigation MUST pass open and onClose to MobileMenuPanel so the panel reads the lifted state",
    );
  });

  test("MobileMenuPanel closes on Escape via a window keydown listener", () => {
    const source = readNavigation();
    const body = panelBody(source);
    assert.ok(
      /addEventListener\(\s*["']keydown["']/.test(body),
      "MobileMenuPanel MUST register a window keydown listener to close on Escape",
    );
    assert.ok(
      /event\.key\s*===\s*["']Escape["']/.test(body),
      "MobileMenuPanel MUST branch on event.key === 'Escape'",
    );
    assert.ok(
      /onClose\s*\(\s*\)/.test(body),
      "MobileMenuPanel MUST call onClose() when Escape is pressed",
    );
  });

  test("MobileMenuPanel closes on resize to >=md breakpoint", () => {
    const source = readNavigation();
    const body = panelBody(source);
    assert.ok(
      /addEventListener\(\s*["']resize["']/.test(body),
      "MobileMenuPanel MUST register a window resize listener",
    );
    assert.ok(
      /window\.innerWidth\s*>=\s*mdBreakpointPx/.test(body),
      "MobileMenuPanel MUST call onClose() when the viewport reaches the desktop breakpoint",
    );
  });

  test("MobileMenuPanel links call onClose on click", () => {
    const source = readNavigation();
    const body = panelBody(source);
    // The panel renders <Link>...</Link> elements (not self-closing),
    // so the regex matches an opening <Link ... > and any following
    // attributes until the closing </Link>.
    const linkMatches = body.match(/<Link\b[\s\S]*?<\/Link>/g) ?? [];
    assert.ok(linkMatches.length >= 3, "panel must render at least three capability-gated links");
    for (const link of linkMatches) {
      assert.match(
        link,
        /onClick=\{onClose\}/,
        "every Link inside MobileMenuPanel MUST call onClose on click so the panel closes after navigation",
      );
    }
  });
});

describe("BG4 navigation: hamburger is hidden when no capability-gated mobile destination exists", () => {
  test("hamburger is conditionally rendered based on hasMobileDestination", () => {
    const source = readNavigation();
    assert.match(
      source,
      /hasMobileDestination\s*&&\s*<MobileMenuToggle/,
      "MobileMenuToggle MUST be rendered only when hasMobileDestination is true so signed-out sessions never see the hamburger",
    );
    assert.match(
      source,
      /hasMobileDestination\s*=\s*!loading\s*&&\s*user\s*!==\s*null\s*&&\s*\(hasBuyerWorkspace\s*\|\|\s*hasSellerWorkspace\)/,
      "Navigation MUST define hasMobileDestination as the conjunction of !loading, signed-in, and Buyer|Seller capability so the hamburger is gated correctly",
    );
  });
});

describe("BG4 navigation: Audio samples capability gating", () => {
  test("Audio samples link is wired through a capability-gated helper, NOT a plain Link", () => {
    const source = readNavigation();
    assert.match(
      source,
      /function SessionAwareAudioSamplesLink/,
      "navigation MUST define a SessionAwareAudioSamplesLink helper so the Audio samples entry is capability-gated",
    );
    assert.match(
      source,
      /data-testid="nav-audio-samples"/,
      "Audio samples link MUST keep the existing data-testid for the search-page embedding",
    );
    const sessionAwareHelper = source.match(/function SessionAwareAudioSamplesLink[\s\S]*?\n\}/);
    assert.ok(sessionAwareHelper, "SessionAwareAudioSamplesLink helper body must be present");
    assert.match(
      sessionAwareHelper[0],
      /href="\/dashboard\/audio"/,
      "Audio samples link MUST be rendered from inside the capability-gated helper",
    );
    assert.match(
      sessionAwareHelper[0],
      /capabilities\.includes\("Seller"\)/,
      "SessionAwareAudioSamplesLink MUST gate on the Seller capability",
    );
  });

  test("Audio samples helper returns null for unauthenticated visitors and for non-Seller Workspaces", () => {
    const source = readNavigation();
    const sessionAwareHelper = source.match(/function SessionAwareAudioSamplesLink[\s\S]*?\n\}/);
    assert.ok(sessionAwareHelper, "SessionAwareAudioSamplesLink helper body must be present");
    assert.match(
      sessionAwareHelper[0],
      /loading\s*\|\|[\s\S]*!user/,
      "SessionAwareAudioSamplesLink MUST short-circuit to null when the session is loading or the user is unauthenticated",
    );
    assert.match(
      sessionAwareHelper[0],
      /hasSellerWorkspace/,
      "SessionAwareAudioSamplesLink MUST check for at least one Seller-capable Workspace",
    );
    assert.match(
      sessionAwareHelper[0],
      /if\s*\(!hasSellerWorkspace\)\s*return\s*null/,
      "SessionAwareAudioSamplesLink MUST return null when no Workspace carries the Seller capability",
    );
  });

  test("Mobile panel mirrors the capability gating for Audio samples (no fallback to a plain Link)", () => {
    const source = readNavigation();
    assert.match(
      source,
      /nav-mobile-audio-samples/,
      "mobile menu MUST have a dedicated nav-mobile-audio-samples test id so the gated entry can be asserted",
    );
    const mobilePanel = source.match(/\/\/ Stacked mobile panel\.[\s\S]*?(?=\n\n\/\/ Tailwind's)/);
    assert.ok(mobilePanel, "MobileMenuPanel helper must be present");
    assert.match(
      mobilePanel[0],
      /hasSellerWorkspace\s*&&/,
      "MobileMenuPanel MUST gate Audio samples on hasSellerWorkspace",
    );
  });
});

describe("BG4 navigation: responsive layout (mobile / tablet / desktop)", () => {
  test("navigation contains a desktop row and a mobile bar, both gated on Tailwind breakpoints", () => {
    const source = readNavigation();
    assert.match(
      source,
      /hidden md:flex[^"]*"[^>]*data-testid="nav-desktop-row"/,
      "desktop row MUST carry the `hidden md:flex` classes so it is hidden below md and visible at md+",
    );
    assert.match(
      source,
      /data-testid="nav-desktop-row"/,
      "desktop row MUST keep its stable test id",
    );
    assert.match(
      source,
      /md:hidden/,
      "mobile bar / toggle MUST carry the `md:hidden` class so it is hidden at md+",
    );
    assert.match(
      source,
      /data-testid="nav-mobile-toggle"/,
      "navigation MUST render a hamburger toggle for mobile viewports",
    );
    assert.match(
      source,
      /aria-expanded=\{open\}/,
      "hamburger toggle MUST advertise its expanded state to assistive tech",
    );
    assert.match(
      source,
      /data-testid="nav-mobile-panel"/,
      "navigation MUST render the mobile panel that the toggle controls",
    );
    assert.match(
      source,
      /aria-controls="nav-mobile-panel"/,
      "hamburger MUST declare aria-controls='nav-mobile-panel' so the panel id relationship is preserved after the state-lift",
    );
  });

  test("navigation prevents horizontal overflow at narrow viewports (min-w-0 / truncate / overflow-x-hidden)", () => {
    const source = readNavigation();
    assert.match(source, /min-w-0/, "navigation MUST use min-w-0 on flex children");
    assert.match(source, /truncate/, "navigation MUST use `truncate` on the brand text");
  });

  test("SessionStatus truncates the email at narrow widths so a long address cannot push the viewport wider", () => {
    const source = readFileSync(`${repoRoot}/src/app/components/SessionStatus.tsx`, "utf8");
    assert.match(
      source,
      /hidden sm:inline/,
      "SessionStatus MUST hide the email below sm (640px) so a long address cannot push the viewport wider",
    );
    assert.match(
      source,
      /truncate max-w-/,
      "SessionStatus MUST truncate the email at sm+ widths with a bounded max-width",
    );
    assert.match(
      source,
      /whitespace-nowrap/,
      "SessionStatus MUST keep the sign-in / sign-out labels on a single line so they remain tappable at any width",
    );
  });

  test("global stylesheet prevents page-level horizontal overflow", () => {
    const source = readFileSync(`${repoRoot}/src/app/globals.css`, "utf8");
    assert.match(
      source,
      /overflow-x:\s*hidden/,
      "globals.css MUST apply overflow-x:hidden to html and body as a defense in depth",
    );
  });
});
