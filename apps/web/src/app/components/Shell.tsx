"use client";

// Capability-aware navigation shell (M2 #83).
//
// Background: the Shell replaces the legacy `Navigation` component
// (which only exposed `Matchmaker` / `Seller inbox` / `Audio
// samples` / `Deals` capability-gated destinations). The new
// shell renders capability-aware destinations derived from the
// authenticated user's `user.workspaces[i].capabilities`:
//
//   - `Home`           — `/dashboard` (always).
//   - `Talent`         — `/talent` (always; the #83 public route
//                        that mounts the existing SearchPage).
//   - `Requests`       — `/seller-requests` when Seller capability
//                        is present on the acting Workspace.
//   - `Deals`          — `/deals` when Buyer OR Seller capability
//                        is present.
//   - `Your services`  — `/dashboard/audio` when Seller
//                        capability is present.
//
// Mobile: menu-only destination navigation. No bottom navigation.
// The ActingWorkspaceSelector renders OUTSIDE the menu on mobile,
// so the Workspace context remains visible regardless of menu
// state. Desktop: inline row of primary destinations with the
// ActingWorkspaceSelector + SessionStatus inline.
//
// Authorization rule (carried from the M2 spec):
//
//   - Buyer and Seller destinations derive from capabilities.
//     Dual-capability Workspaces see both — there is NO Buyer/
//     Seller persona switch.
//   - Navigation visibility is presentation-only. `/deals` and
//     `GET /api/deals` authorize independently against current
//     membership for the EXACT acting Workspace.

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bg1PublicUserV1, MarketplaceCapabilityV1 } from "@soundhub/types";
import { useActingWorkspace } from "./SessionProvider";
import { SessionStatus } from "./SessionStatus";
import { ActingWorkspaceSelector } from "./ActingWorkspaceSelector";
import { SoundHubLogo } from "./SoundHubLogo";

type NavigationDestination = {
  readonly href: Route;
  readonly label: string;
  readonly testId: string;
};

function deriveNavigationDestinations({
  actingWorkspace,
}: {
  readonly actingWorkspace: Bg1PublicUserV1["workspaces"][number] | null;
}): readonly NavigationDestination[] {
  const out: NavigationDestination[] = [
    { href: "/dashboard", label: "Home", testId: "nav-home-link" },
    { href: "/talent", label: "Talent", testId: "nav-talent-link" },
  ];
  // Read capabilities off the COMMITTED acting Workspace. The
  // Shell renders destinations for the Workspace the user is
  // currently acting as; switching re-derives the destinations
  // on the next render.
  if (!actingWorkspace) return out;
  const capabilities: readonly MarketplaceCapabilityV1[] = actingWorkspace.capabilities;
  // Deals is a Deal-party destination, not a Buyer-only one.
  // Sellers are also Deal parties — the Deal-list route
  // authorizes Sellers on the Workspace's Deals exactly like
  // Buyers. Expose the destination for EITHER capability.
  if (capabilities.includes("Buyer") || capabilities.includes("Seller")) {
    out.push({ href: "/deals", label: "Deals", testId: "nav-deals-link" });
  }
  if (capabilities.includes("Seller")) {
    out.push({ href: "/seller-requests", label: "Requests", testId: "nav-requests-link" });
    out.push({ href: "/dashboard/audio", label: "Your services", testId: "nav-services-link" });
  }
  return out;
}

export function Shell() {
  const { actingWorkspace } = useActingWorkspace();

  // Single source of truth for capability-gated navigation.
  const destinations = useMemo(
    () => deriveNavigationDestinations({ actingWorkspace }),
    [actingWorkspace],
  );

  // Single source of truth for mobile-menu visibility.
  const [open, setOpen] = useState(false);
  const onToggle = useCallback(() => {
    setOpen((value) => !value);
  }, []);
  const onClose = useCallback(() => {
    setOpen(false);
  }, []);

  const hasMobileDestination = destinations.length > 0;

  return (
    <header className="bg-canvas border-b border-borderWarm" data-testid="top-shell">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center min-h-16 h-auto py-2 gap-4">
          <div className="flex items-center gap-3 min-w-0 shrink-0">
            <Link
              href="/"
              className="inline-flex items-center text-ink truncate"
              data-testid="shell-brand"
            >
              <SoundHubLogo size="md" />
            </Link>
          </div>
          <div
            className="hidden lg:flex items-center gap-4 min-w-0 flex-1 justify-end"
            data-testid="shell-desktop-row"
          >
            {destinations.map((destination) => (
              <Link
                key={destination.href}
                href={destination.href}
                className="text-sm font-medium text-muted hover:text-ink focus-visible:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded transition-colors whitespace-nowrap"
                data-testid={destination.testId}
              >
                {destination.label}
              </Link>
            ))}
            <ActingWorkspaceSelector variant="desktop" />
            <SessionStatus />
          </div>
          <div
            className="flex items-center gap-3 lg:hidden min-w-0 ml-auto"
            data-testid="shell-mobile-bar"
          >
            <ActingWorkspaceSelector variant="mobile-compact" />
            <SessionStatus />
            {hasMobileDestination && <MobileMenuToggle open={open} onToggle={onToggle} />}
          </div>
        </div>
        <MobileMenuPanel open={open} onClose={onClose} destinations={destinations} />
      </div>
    </header>
  );
}

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
      className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] p-2 rounded text-ink hover:bg-surface focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
      aria-expanded={open}
      aria-controls="shell-mobile-panel"
      aria-label={open ? "Close menu" : "Open menu"}
      data-testid="shell-mobile-toggle"
    >
      <span
        aria-hidden="true"
        className="block w-5 h-0.5 bg-current relative before:absolute before:left-0 before:-top-1.5 before:w-5 before:h-0.5 before:bg-current after:absolute after:left-0 after:top-1.5 after:w-5 after:h-0.5 after:bg-current"
      ></span>
    </button>
  );
}

function MobileMenuPanel({
  open,
  onClose,
  destinations,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly destinations: readonly NavigationDestination[];
}) {
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => {
      // Match the `lg` breakpoint the desktop row uses (see Shell.tsx
      // `shell-desktop-row hidden lg:flex`). At >= 1024px the desktop
      // nav is visible; auto-close the mobile panel so it doesn't
      // linger above the desktop destinations.
      if (window.innerWidth >= 1024) onClose();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [onClose]);

  return (
    <div
      id="shell-mobile-panel"
      className={`${open ? "block" : "hidden"} lg:hidden border-t border-borderWarm py-2`}
      data-testid="shell-mobile-panel"
      data-open={open ? "true" : "false"}
    >
      <div className="flex flex-col gap-1">
        {destinations.map((destination) => (
          <Link
            key={destination.href}
            href={destination.href}
            onClick={onClose}
            className="block px-2 py-2 rounded text-sm font-medium text-muted hover:bg-surface hover:text-ink"
            data-testid={`shell-mobile-${destination.testId.slice("nav-".length)}`}
          >
            {destination.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
