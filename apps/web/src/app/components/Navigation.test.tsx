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
//   4. The seller inbox rows prominently exposed raw internal ids
//      instead of human-readable context (covered by
//      `seller-requests/page.test.tsx`).
//
// Finding #3 — the mobile-menu state ownership defect — is pinned
// here by mounting the real `<Navigation />` inside the real
// `<SessionProvider />` through `react-dom/client` + `act()`. The
// tests drive the production hamburger's actual `onClick`,
// dispatch real `keydown` and `resize` events on the JSDOM `window`,
// click a real mobile `<a>`, and assert on the production panel's
// actual rendered visibility. A deliberate break between the
// production toggle and panel makes the click-open test fail;
// restored wiring passes every case. This is the runtime contract
// for the BG4 mobile-menu fix.
//
// Capability-gating behavior (signed-out, Buyer-only, Seller-only,
// mixed-capability, no-capability) is also pinned from the same
// runtime seam so the destinations one Navigation derives are
// rendered identically in the desktop row and the mobile panel.
//
// The runtime contract for the auth-aware gating is also covered by
// `SessionProvider.test.tsx`.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Bg1PublicUserV1, Bg1SessionInfoV1 } from "@soundhub/types";
import { SessionProvider } from "./SessionProvider";
import { Navigation } from "./Navigation";

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

// A user whose single Workspace carries BOTH Buyer and Seller
// capabilities. Every gated destination should render in both the
// desktop row and the mobile panel for this session.
function mixedCapabilityUser(): Bg1PublicUserV1 {
  return {
    userAccountId: "u-mixed",
    email: "mixed@example.test",
    displayName: "Mixed User",
    identityProvider: "dev",
    workspaces: [
      {
        workspaceId: "ws-mixed",
        slug: "mixed-studio",
        name: "Mixed Studio",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        capabilities: ["Buyer", "Seller"],
      },
    ],
  };
}

// A signed-in user whose workspaces carry neither Buyer nor Seller
// capability. The session is authenticated, but no gated
// destination is eligible, so the hamburger MUST stay hidden and
// neither desktop nor mobile should render any gated link.
function noCapabilityUser(): Bg1PublicUserV1 {
  return {
    userAccountId: "u-nocap",
    email: "nocap@example.test",
    displayName: "No-Capability User",
    identityProvider: "dev",
    workspaces: [
      {
        workspaceId: "ws-nocap",
        slug: "nocap-studio",
        name: "No-Capability Studio",
        workspaceType: "Personal",
        workspaceStatus: "Active",
        capabilities: [],
      },
    ],
  };
}

// Stub `globalThis.fetch` so the real `<SessionProvider />`'s mount
// effect resolves with the chosen user. Any URL the SessionProvider
// does not fetch is rejected with a 404 so a test that
// inadvertently exercises another endpoint fails loudly.
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
// Capability-gating behavior.
//
// The desktop row, the hamburger, and the mobile panel all derive
// from one navigation-destination set built in Navigation. Each
// test below mounts the real production component and asserts on
// the actual rendered DOM — no source-pattern matching, no
// implementation-detail scans. The fixtures cover every relevant
// session shape so a regression that drops a capability check or
// duplicates one into only one surface fails the suite.
// ----------------------------------------------------------------

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

describe("BG4 navigation: capability gating (desktop + mobile share one destination set)", () => {
  test("signed-out session exposes no capability-gated navigation anywhere", async () => {
    const { root, container } = await mountNavigation({ user: null });
    mounted.push(root);
    // No hamburger.
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-toggle"]'),
      null,
      "signed-out session MUST NOT render the hamburger because there are no gated mobile destinations",
    );
    // No panel.
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-panel"]'),
      null,
      "signed-out session MUST NOT render the mobile panel because there is nothing to navigate to",
    );
    // No desktop gated links.
    assert.strictEqual(
      container.querySelector('[data-testid="nav-matchmaker-link"]'),
      null,
      "signed-out session MUST NOT render the Matchmaker desktop link",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-seller-requests-link"]'),
      null,
      "signed-out session MUST NOT render the Seller inbox desktop link",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-audio-samples"]'),
      null,
      "signed-out session MUST NOT render the Audio samples desktop link",
    );
  });

  test("Buyer-only session exposes Matchmaker in the desktop row and the mobile panel", async () => {
    const { root, container } = await mountNavigation({ user: buyerOnlyUser() });
    mounted.push(root);
    // Desktop.
    assert.ok(
      container.querySelector('[data-testid="nav-matchmaker-link"]'),
      "Buyer-only desktop row MUST render the Matchmaker link",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-seller-requests-link"]'),
      null,
      "Buyer-only desktop row MUST NOT render the Seller inbox link",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-audio-samples"]'),
      null,
      "Buyer-only desktop row MUST NOT render the Audio samples link",
    );
    // Mobile: open the panel and check its contents.
    const hamburger = requireNode(container, "nav-mobile-toggle");
    act(() => {
      hamburger.click();
    });
    assert.ok(
      container.querySelector('[data-testid="nav-mobile-matchmaker-link"]'),
      "Buyer-only mobile panel MUST render the Matchmaker link",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-seller-requests-link"]'),
      null,
      "Buyer-only mobile panel MUST NOT render the Seller inbox link",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-audio-samples"]'),
      null,
      "Buyer-only mobile panel MUST NOT render the Audio samples link",
    );
  });

  test("Seller-only session exposes Seller inbox and Audio samples in the desktop row and the mobile panel", async () => {
    const { root, container } = await mountNavigation({ user: sellerOnlyUser() });
    mounted.push(root);
    // Desktop.
    assert.strictEqual(
      container.querySelector('[data-testid="nav-matchmaker-link"]'),
      null,
      "Seller-only desktop row MUST NOT render the Matchmaker link",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-seller-requests-link"]'),
      "Seller-only desktop row MUST render the Seller inbox link",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-audio-samples"]'),
      "Seller-only desktop row MUST render the Audio samples link",
    );
    // Mobile.
    const hamburger = requireNode(container, "nav-mobile-toggle");
    act(() => {
      hamburger.click();
    });
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-matchmaker-link"]'),
      null,
      "Seller-only mobile panel MUST NOT render the Matchmaker link",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-mobile-seller-requests-link"]'),
      "Seller-only mobile panel MUST render the Seller inbox link",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-mobile-audio-samples"]'),
      "Seller-only mobile panel MUST render the Audio samples link",
    );
  });

  test("mixed-capability session exposes every eligible destination in both the desktop row and the mobile panel", async () => {
    const { root, container } = await mountNavigation({ user: mixedCapabilityUser() });
    mounted.push(root);
    // Desktop — all three gated destinations render.
    assert.ok(
      container.querySelector('[data-testid="nav-matchmaker-link"]'),
      "mixed-capability desktop row MUST render the Matchmaker link",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-seller-requests-link"]'),
      "mixed-capability desktop row MUST render the Seller inbox link",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-audio-samples"]'),
      "mixed-capability desktop row MUST render the Audio samples link",
    );
    // Mobile — same three render after the hamburger opens the panel.
    const hamburger = requireNode(container, "nav-mobile-toggle");
    act(() => {
      hamburger.click();
    });
    assert.ok(
      container.querySelector('[data-testid="nav-mobile-matchmaker-link"]'),
      "mixed-capability mobile panel MUST render the Matchmaker link",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-mobile-seller-requests-link"]'),
      "mixed-capability mobile panel MUST render the Seller inbox link",
    );
    assert.ok(
      container.querySelector('[data-testid="nav-mobile-audio-samples"]'),
      "mixed-capability mobile panel MUST render the Audio samples link",
    );
  });

  test("signed-in but no-capability session exposes no gated navigation in either surface", async () => {
    const { root, container } = await mountNavigation({ user: noCapabilityUser() });
    mounted.push(root);
    // No hamburger — the session is authenticated but no gated
    // destination is eligible, so the hamburger must stay hidden
    // (a regression that re-routes the gating through sign-out
    // alone would let the hamburger appear for an authenticated
    // user whose Workspaces carry neither capability).
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-toggle"]'),
      null,
      "no-capability session MUST NOT render the hamburger because no mobile destination is eligible",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-mobile-panel"]'),
      null,
      "no-capability session MUST NOT render the mobile panel because there is nothing to navigate to",
    );
    // No desktop gated links.
    assert.strictEqual(
      container.querySelector('[data-testid="nav-matchmaker-link"]'),
      null,
      "no-capability desktop row MUST NOT render the Matchmaker link",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-seller-requests-link"]'),
      null,
      "no-capability desktop row MUST NOT render the Seller inbox link",
    );
    assert.strictEqual(
      container.querySelector('[data-testid="nav-audio-samples"]'),
      null,
      "no-capability desktop row MUST NOT render the Audio samples link",
    );
  });
});

// ----------------------------------------------------------------
// Mobile-menu state ownership behavior.
//
// The defect we're guarding against: MobileMenuToggle and
// MobileMenuPanel previously each owned their own useState(false).
// Clicking the toggle changed the toggle's local `open` but the
// panel never observed it. The fix lifts the state to Navigation
// and passes `open` + callbacks to the children. These tests mount
// the real Navigation, click the real hamburger, dispatch real
// window events, and observe the real rendered visibility — so a
// production event-wiring regression fails the suite immediately.
// ----------------------------------------------------------------

describe("BG4 navigation: mobile-menu state is lifted to Navigation", () => {
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
