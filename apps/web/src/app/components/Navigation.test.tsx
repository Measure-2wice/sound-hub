/* eslint-disable @typescript-eslint/no-floating-promises */
// Navigation tests.
//
// Background: the manual acceptance test on
// feat/bg4-persists-projects surfaced four findings:
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
// Finding #3 — the mobile-menu state ownership defect — is pinned by
// two complementary layers in this file:
//
//   - **Runtime interaction tests** mount the real `<Navigation />`
//     inside the real `<SessionProvider />` through
//     `react-dom/client` + `act()`. They drive the production
//     hamburger's actual `onClick`, dispatch real `keydown` and
//     `resize` events on the JSDOM `window`, click a real mobile
//     `<a>`, and assert on the production panel's actual rendered
//     visibility. A deliberate break between the production toggle
//     and panel makes the click-open test fail; restored wiring
//     passes every case. This is the runtime contract for the BG4
//     mobile-menu fix.
//
//   - **Source-pattern tests** pin the structural invariants
//     (lifted state, capability-gated desktop helpers, responsive
//     class layout, overflow guard) so a refactor that re-introduces
//     the original defect — by giving the toggle or the panel its
//     own `useState(false)` — fails the suite immediately, even
//     before the runtime tests run.
//
// The runtime contract for the auth-aware gating is also covered by
// `SessionProvider.test.tsx`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Bg1PublicUserV1, Bg1SessionInfoV1 } from "@soundhub/types";
import { SessionProvider } from "./SessionProvider";
import { Navigation } from "./Navigation";

const repoRoot = `${new URL("../../../../", import.meta.url).pathname}web`;

function readNavigation(): string {
  return readFileSync(`${repoRoot}/src/app/components/Navigation.tsx`, "utf8");
}

// Stable session fixtures. The fields are minimal-but-valid for the
// public schema; only the ones the navigation reads are populated.
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

// Stub `globalThis.fetch` so the real `<SessionProvider />`'s mount
// effect resolves with the chosen user. This is the minimum external
// dependency the user explicitly called out — the existing session
// context/API seam — and avoids reproducing session state inside the
// test. Any URL the SessionProvider does not fetch is rejected with a
// 404 so a test that inadvertently exercises another endpoint fails
// loudly.
function mockSessionEndpoint(user: Bg1PublicUserV1 | null): void {
  const sessionInfo: Bg1SessionInfoV1 = { user };
  const body = JSON.stringify(sessionInfo);
  globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = extractUrl(input);
    if (url.includes("/api/auth/me")) {
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("not stubbed", { status: 404 }));
  };
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

interface MountedNavigation {
  readonly root: Root;
  readonly container: HTMLElement;
}

// Mount the real `<SessionProvider><Navigation /></Navigation />`
// into a fresh JSDOM container, then flush the mount effects inside
// `act()` so the panel's `aria-expanded` / `data-open` reflect the
// initial server-rendered state. Returns the root (so callers can
// unmount) and the container DOM (so assertions can query rendered
// nodes).
async function mountNavigation(args: {
  readonly user: Bg1PublicUserV1 | null;
}): Promise<MountedNavigation> {
  mockSessionEndpoint(args.user);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SessionProvider>
        <Navigation />
      </SessionProvider>,
    );
    // Drain the microtask queue so SessionProvider's mount effect
    // (which awaits `fetchSessionInfo`) commits before we return.
    await Promise.resolve();
  });
  return { root, container };
}

// Per-test teardown. Unmounts the root (so React's event delegation
// is released and the next test gets a clean tree), wipes the body,
// and restores `fetch` so a missing reset cannot leak into another
// test file's process state.
const mounted: Root[] = [];

afterEach(() => {
  while (mounted.length > 0) {
    const root = mounted.pop();
    if (root) {
      act(() => {
        root.unmount();
      });
    }
  }
  document.body.innerHTML = "";
  // @ts-expect-error - intentional: restore Node's built-in fetch.
  delete globalThis.fetch;
});

// ----------------------------------------------------------------
// Runtime interaction tests for the mobile-menu state ownership.
// ----------------------------------------------------------------
//
// The defect we're guarding against: MobileMenuToggle and
// MobileMenuPanel previously each owned their own useState(false).
// Clicking the toggle changed the toggle's local `open` but the
// panel never observed it. The fix lifts the state to Navigation
// and passes `open` + callbacks to the children. These tests mount
// the real Navigation, click the real hamburger, dispatch real
// window events, and observe the real rendered visibility — so a
// production event-wiring regression fails the suite immediately.

// Helper: query a node by its stable testid; throw if absent so the
// assertion message names the missing element.
function requireNode(container: HTMLElement, testid: string): HTMLElement {
  const node = container.querySelector(`[data-testid="${testid}"]`);
  assert.ok(
    node,
    `expected rendered node with data-testid="${testid}" inside the mounted Navigation`,
  );
  return node as HTMLElement;
}

describe("BG4 navigation: real interaction tests mount the production component", () => {
  test("signed-out session does NOT render the hamburger", async () => {
    const { root, container } = await mountNavigation({ user: null });
    mounted.push(root);
    const hamburger = container.querySelector('[data-testid="nav-mobile-toggle"]');
    assert.strictEqual(
      hamburger,
      null,
      "hamburger MUST NOT render for a signed-out session because there are no capability-gated mobile destinations",
    );
  });

  test("Buyer-capable session renders the hamburger and clicking it reveals Matchmaker (not Seller inbox / Audio samples)", async () => {
    const { root, container } = await mountNavigation({ user: buyerOnlyUser() });
    mounted.push(root);
    const hamburger = requireNode(container, "nav-mobile-toggle");
    assert.strictEqual(
      hamburger.getAttribute("aria-expanded"),
      "false",
      "hamburger must start with aria-expanded=false",
    );
    act(() => {
      hamburger.click();
    });
    assert.strictEqual(
      hamburger.getAttribute("aria-expanded"),
      "true",
      "clicking the real hamburger must flip aria-expanded to true",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-mobile-matchmaker-link"]'),
      "Buyer panel MUST render the Matchmaker link after open",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-seller-requests-link"]'),
      null,
      "Buyer-only panel MUST NOT render Seller inbox",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-audio-samples"]'),
      null,
      "Buyer-only panel MUST NOT render the Seller-gated Audio samples link",
    );
  });

  test("Seller-capable session renders the hamburger and clicking it reveals Seller inbox and Audio samples (not Matchmaker)", async () => {
    const { root, container } = await mountNavigation({ user: sellerOnlyUser() });
    mounted.push(root);
    const hamburger = requireNode(container, "nav-mobile-toggle");
    act(() => {
      hamburger.click();
    });
    assert.ok(
      container.querySelector('[data-testid="nav-mobile-seller-requests-link"]'),
      "Seller panel MUST render the Seller inbox link after open",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-mobile-audio-samples"]'),
      "Seller panel MUST render the Audio samples link after open",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-matchmaker-link"]'),
      null,
      "Seller-only panel MUST NOT render Buyer-only Matchmaker",
    );
  });

  test("initial aria-expanded is false and the panel is hidden", async () => {
    const { root, container } = await mountNavigation({ user: sellerOnlyUser() });
    mounted.push(root);
    const hamburger = requireNode(container, "nav-mobile-toggle");
    const panel = requireNode(container, "nav-mobile-panel");
    assert.strictEqual(
      hamburger.getAttribute("aria-expanded"),
      "false",
      "hamburger must start with aria-expanded=false",
    );
    assert.strictEqual(
      panel.getAttribute("data-open"),
      "false",
      "panel must start with data-open=false so the close handlers and screen readers see the closed state",
    );
    assert.ok(
      panel.classList.contains("hidden"),
      "panel must carry the standalone `hidden` class when closed",
    );
    assert.ok(
      !panel.classList.contains("block"),
      "panel must NOT carry the standalone `block` class when closed",
    );
  });

  test("clicking the real hamburger changes aria-expanded to true and the panel becomes visible", async () => {
    const { root, container } = await mountNavigation({ user: sellerOnlyUser() });
    mounted.push(root);
    const hamburger = requireNode(container, "nav-mobile-toggle");
    const panel = requireNode(container, "nav-mobile-panel");
    act(() => {
      hamburger.click();
    });
    assert.strictEqual(
      hamburger.getAttribute("aria-expanded"),
      "true",
      "hamburger must flip aria-expanded to true after a real click so the panel state stays synchronized with the toggle",
    );
    assert.strictEqual(
      panel.getAttribute("data-open"),
      "true",
      "panel must flip data-open to true after a real click so its visibility matches the toggle",
    );
    assert.ok(
      !panel.classList.contains("hidden"),
      "panel must NOT carry the standalone `hidden` class when open (the `md:hidden` responsive variant is not the same token)",
    );
    assert.ok(
      panel.classList.contains("block"),
      "panel must carry the standalone `block` class when open so it actually becomes visible",
    );
  });

  test("clicking the hamburger a second time closes the panel and aria-expanded goes back to false", async () => {
    const { root, container } = await mountNavigation({ user: sellerOnlyUser() });
    mounted.push(root);
    const hamburger = requireNode(container, "nav-mobile-toggle");
    const panel = requireNode(container, "nav-mobile-panel");
    // Open it first (one click) then close it (second click).
    act(() => {
      hamburger.click();
    });
    assert.strictEqual(
      hamburger.getAttribute("aria-expanded"),
      "true",
      "precondition: first click must open the panel",
    );
    act(() => {
      hamburger.click();
    });
    assert.strictEqual(
      hamburger.getAttribute("aria-expanded"),
      "false",
      "second click must flip aria-expanded back to false — this is the BG4 manual-QA finding that the toggle and panel stayed desynced",
    );
    assert.strictEqual(
      panel.getAttribute("data-open"),
      "false",
      "second click must flip data-open back to false so the toggle and the panel stay synchronized",
    );
    assert.ok(
      panel.classList.contains("hidden"),
      "panel must carry the standalone `hidden` class after the second click",
    );
  });

  test("clicking a real mobile navigation link closes the panel", async () => {
    const { root, container } = await mountNavigation({ user: sellerOnlyUser() });
    mounted.push(root);
    const hamburger = requireNode(container, "nav-mobile-toggle");
    const panel = requireNode(container, "nav-mobile-panel");
    act(() => {
      hamburger.click();
    });
    const link = requireNode(container, "nav-mobile-seller-requests-link");
    // Clicking the link fires its production `onClick={onClose}`
    // handler — the same handler that drives the production
    // panel-close-on-navigation behaviour. We do not call
    // `preventDefault()` because Next.js Link's own handler does so
    // before invoking the router; if Next.js's router call throws
    // (it does, because no router is mounted) the synchronous
    // `onClose` still ran first.
    act(() => {
      try {
        link.click();
      } catch {
        // Next.js Link calls useRouter().push() which fails without
        // a mounted Next.js router; the production panel's onClose
        // already executed before that call, so the close assertion
        // below is the contract we care about.
      }
    });
    assert.strictEqual(
      hamburger.getAttribute("aria-expanded"),
      "false",
      "mobile nav link click must flip aria-expanded to false",
    );
    assert.strictEqual(
      panel.getAttribute("data-open"),
      "false",
      "mobile nav link click must flip data-open to false so the link-click close works",
    );
  });

  test("Escape closes the panel", async () => {
    const { root, container } = await mountNavigation({ user: sellerOnlyUser() });
    mounted.push(root);
    const hamburger = requireNode(container, "nav-mobile-toggle");
    const panel = requireNode(container, "nav-mobile-panel");
    act(() => {
      hamburger.click();
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    assert.strictEqual(
      hamburger.getAttribute("aria-expanded"),
      "false",
      "Escape must flip aria-expanded to false",
    );
    assert.strictEqual(
      panel.getAttribute("data-open"),
      "false",
      "Escape must flip data-open to false so the panel state stays synchronized with the toggle",
    );
  });

  test("resize to desktop breakpoint (>=768px) closes the panel", async () => {
    const { root, container } = await mountNavigation({ user: sellerOnlyUser() });
    mounted.push(root);
    const hamburger = requireNode(container, "nav-mobile-toggle");
    const panel = requireNode(container, "nav-mobile-panel");
    act(() => {
      hamburger.click();
    });
    // JSDOM's default `window.innerWidth` is 1024; dispatching a
    // resize event fires the production listener and the production
    // branch `window.innerWidth >= mdBreakpointPx` (768) is true, so
    // the panel must close.
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    assert.strictEqual(
      hamburger.getAttribute("aria-expanded"),
      "false",
      "resize to >=768px must also flip aria-expanded to false so the hamburger reflects the closed state",
    );
    assert.strictEqual(
      panel.getAttribute("data-open"),
      "false",
      "resize to >=768px must close the panel so open state does not leak into the desktop layout",
    );
  });
});

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
    assert.ok(match, "MobileMenuToggle helper must exist so the body can be anchored");
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
