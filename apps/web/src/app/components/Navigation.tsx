"use client";

// Top navigation. Renders the SoundHub title plus a sign-in / sign-out
// affordance backed by the BG1 authentication API.
//
// The Matchmaker entry is Buyer-gated; the Seller requests and
// Audio-samples entries are Seller-gated. All three hide themselves
// for unauthenticated visitors and for users whose workspaces do
// not carry the required capability. The server component shell
// never emits the gated links, so an unauthenticated visitor at a
// narrow viewport never sees Audio samples and cannot navigate to
// /dashboard/audio by tapping its link.
//
// Both surfaces — the desktop row at >=md and the mobile panel
// below md — render the SAME navigation destinations derived once
// from the { user, loading } session state. The desktop row maps
// the destinations inline; the mobile panel maps them too, with
// the panel-specific close-on-click and the `nav-mobile-` test-id
// prefix. This keeps capability gating in lock-step: a change to
// the rules happens in `deriveNavigationDestinations`, not in
// three scattered places.
//
// The shell is responsive:
//   - mobile (<md): the inline links collapse into a hamburger
//     menu that opens a stacked panel below the header. The brand
//     and sign-in/out affordance stay visible at all widths so
//     users can always sign out.
//   - tablet/desktop (>=md): the inline links render side by side
//     in a single row.
//
// Horizontal overflow is prevented by:
//   - `overflow-x-hidden` on the panel container (defense in depth
//     against long-wrapped content).
//   - `min-w-0` on the inner flex children so a long email cannot
//     force the row wider than the viewport. SessionStatus itself
//     truncates the email with `truncate` so an unwrapped
//     `user@…` address cannot blow up the header.
//
// Mobile-menu state ownership:
// The `open` flag for the hamburger panel lives on the nearest
// shared owner (`Navigation`) so the toggle and the panel read the
// SAME state instance. Prior to this fix each component owned its
// own `useState(false)` and the panel never opened when the
// hamburger was clicked — a BG4 manual-QA finding. The toggle now
// receives `open` + `onToggle`, the panel receives `open` +
// `onClose`, and the panel wires its close handlers (Escape,
// resize-to-desktop, and a per-link click) to that single callback.
//
// SessionStatus owns the visible sign-in / sign-out affordance.
// The Matchmaker, Seller-requests, and Audio-samples entries share
// one derived destination list so the desktop row, the hamburger
// visibility, and the mobile panel all read from the same set.
// Routes themselves also enforce server-side authorization (the
// audio samples page already does), but the client-side gating
// here is what prevents a signed-out user from ever seeing the
// link.

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bg1PublicUserV1 } from "@soundhub/types";
import { useSession } from "./SessionProvider";
import { SessionStatus } from "./SessionStatus";

type NavigationDestination = {
  readonly href: Route;
  readonly label: string;
  readonly testId: string;
};

// One authoritative derivation: given the current session, produce
// the navigation destinations the user is eligible to see. Both
// the desktop row and the mobile panel render from this same set
// — there is no per-surface recomputation of capability scans, so
// a regression that drops a capability check cannot surface in
// only one of the two surfaces.
//
// Authorization remains a server / application concern; this is
// presentation-only narrowing.
function deriveNavigationDestinations({
  user,
  loading,
}: {
  readonly user: Bg1PublicUserV1 | null;
  readonly loading: boolean;
}): readonly NavigationDestination[] {
  if (loading || !user) return [];
  const hasBuyerWorkspace = user.workspaces.some((w) => w.capabilities.includes("Buyer"));
  const hasSellerWorkspace = user.workspaces.some((w) => w.capabilities.includes("Seller"));
  // `as const` narrows each href to its literal string type so the
  // generated Next.js `RouteImpl<string>` accepts it when the
  // destination is later handed to `<Link>`. Without `as const` the
  // variable's widened `string` type fails the Link overload.
  const out: NavigationDestination[] = [];
  if (hasBuyerWorkspace) {
    out.push({
      href: "/matchmaker",
      label: "Matchmaker",
      testId: "nav-matchmaker-link",
    });
  }
  if (hasSellerWorkspace) {
    out.push({
      href: "/seller-requests",
      label: "Seller inbox",
      testId: "nav-seller-requests-link",
    });
    out.push({
      href: "/dashboard/audio",
      label: "Audio samples",
      testId: "nav-audio-samples",
    });
  }
  // Deals (ticket #74). A Deal always has a Buyer-capable side and a
  // Seller-capable side, so either capability makes a user eligible to
  // hold Deals. Signed-out users and users whose current memberships
  // expose neither capability never reach this line.
  //
  // Navigation visibility is presentation only: `/deals` and
  // `GET /api/deals` authorize independently against current
  // membership for the exact acting Workspace.
  if (hasBuyerWorkspace || hasSellerWorkspace) {
    out.push({
      href: "/deals",
      label: "Deals",
      testId: "nav-deals-link",
    });
  }
  return out;
}

export function Navigation() {
  const { user, loading } = useSession();

  // Single source of truth for capability-gated navigation. Both
  // desktop and mobile render from this same list so a change in
  // capability rules shows up in both surfaces together.
  const destinations = useMemo(
    () => deriveNavigationDestinations({ user, loading }),
    [user, loading],
  );

  // Single source of truth for mobile-menu visibility. Both the
  // hamburger toggle and the panel below the row read this same
  // instance, so a click on the toggle is observed by the panel
  // on the same render pass. See the file-header comment for the
  // defect this resolves.
  const [open, setOpen] = useState(false);
  const onToggle = useCallback(() => {
    setOpen((value) => !value);
  }, []);
  const onClose = useCallback(() => {
    setOpen(false);
  }, []);

  // The hamburger only renders when at least one mobile destination
  // exists — a signed-out session, or a signed-in session whose
  // workspaces carry neither Buyer nor Seller capability, renders
  // no hamburger and no panel.
  const hasMobileDestination = destinations.length > 0;

  return (
    <nav className="bg-white shadow-lg border-b" data-testid="top-nav">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center min-h-16 h-auto py-2 gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/"
              className="text-xl sm:text-2xl font-bold text-blue-600 truncate"
              data-testid="nav-brand"
            >
              <span aria-hidden="true">🎧</span> SoundHub Talent
            </Link>
          </div>
          <div className="hidden md:flex items-center gap-4 min-w-0" data-testid="nav-desktop-row">
            {destinations.map((destination) => (
              <Link
                key={destination.href}
                href={destination.href}
                className="text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors"
                data-testid={destination.testId}
              >
                {destination.label}
              </Link>
            ))}
            <SessionStatus />
          </div>
          <div className="flex items-center gap-3 md:hidden min-w-0" data-testid="nav-mobile-bar">
            <SessionStatus />
            {hasMobileDestination && <MobileMenuToggle open={open} onToggle={onToggle} />}
          </div>
        </div>
        <MobileMenuPanel open={open} onClose={onClose} destinations={destinations} />
      </div>
    </nav>
  );
}

// Hamburger button. Visible only on small viewports AND only when
// the session has at least one capability-gated mobile destination.
// The toggle is a pure presentation over the lifted `open` state:
// its `aria-expanded` is always in lock-step with what the panel shows
// because both read the same `open` value from the parent. It is
// keyboard-accessible (real `<button>`, focus ring, aria-label that
// reflects the next action).
function MobileMenuToggle({
  open,
  onToggle,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center justify-center p-2 rounded-md text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
      aria-expanded={open}
      aria-controls="nav-mobile-panel"
      aria-label={open ? "Close menu" : "Open menu"}
      data-testid="nav-mobile-toggle"
    >
      <span
        aria-hidden="true"
        className="block w-5 h-0.5 bg-current relative before:absolute before:left-0 before:-top-1.5 before:w-5 before:h-0.5 before:bg-current after:absolute after:left-0 after:top-1.5 after:w-5 after:h-0.5 after:bg-current"
      ></span>
    </button>
  );
}

// Stacked mobile panel. Renders the same destination list as the
// desktop row so capability gating stays in lock-step — no
// per-surface recomputation, no duplicated Buyer/Seller capability
// scans. Each link calls onClose so navigation closes the panel.
// The mobile test ids swap the `nav-` prefix for `nav-mobile-` so
// `nav-matchmaker-link` becomes `nav-mobile-matchmaker-link`, etc.
//
// Close behavior (BG4 manual-QA fix):
//   - clicking any link inside the panel closes it;
//   - pressing Escape closes it;
//   - resizing the viewport back to the desktop breakpoint
//     (`>= md`) closes it.
//
// The panel never owns `open`; it only calls `onClose` and reads
// `open` from the parent.
function MobileMenuPanel({
  open,
  onClose,
  destinations,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly destinations: readonly NavigationDestination[];
}) {
  // Close on Escape so keyboard users can dismiss the menu without
  // reaching for the toggle.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // Close on resize to >=md so the panel state does not survive
  // across viewport changes. ResizeObserver is not available in
  // every test environment, so we listen to `resize` and only
  // run when the document is in the browser.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => {
      if (window.innerWidth >= mdBreakpointPx) {
        onClose();
      }
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  return (
    <div
      id="nav-mobile-panel"
      className={`${open ? "block" : "hidden"} md:hidden border-t border-gray-200 py-2`}
      data-testid="nav-mobile-panel"
      data-open={open ? "true" : "false"}
    >
      <div className="flex flex-col gap-1">
        {destinations.map((destination) => (
          <Link
            key={destination.href}
            href={destination.href}
            onClick={onClose}
            className="block px-2 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
            data-testid={`nav-mobile-${destination.testId.slice("nav-".length)}`}
          >
            {destination.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

// Tailwind's `md` breakpoint is 768px; the resize handler must use
// the same threshold so the panel closes at exactly the same
// viewport at which the desktop row appears.
const mdBreakpointPx = 768;
