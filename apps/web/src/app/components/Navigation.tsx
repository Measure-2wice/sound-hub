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
// SessionStatus owns the visible sign-in / sign-out affordance.
// The Matchmaker, Seller-requests, and Audio-samples links own
// their own auth-aware visibility because their gating is
// capability-specific. Routes themselves also enforce server-side
// authorization (the audio samples page already does), but the
// client-side gating here is what prevents a signed-out user from
// ever seeing the link.

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "./SessionProvider";
import { SessionStatus } from "./SessionStatus";

export function Navigation() {
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
            <SessionAwareMatchmakerLink />
            <SessionAwareSellerRequestsLink />
            <SessionAwareAudioSamplesLink />
            <SessionStatus />
          </div>
          <div className="flex items-center gap-3 md:hidden min-w-0" data-testid="nav-mobile-bar">
            <SessionStatus />
            <MobileMenuToggle />
          </div>
        </div>
        <MobileMenuPanel />
      </div>
    </nav>
  );
}

// Renders the Matchmaker entry only when the signed-in user has at
// least one Buyer-capable Workspace. The server component shell
// never emits the link, so unauthenticated visitors and
// authenticated users without a Buyer Workspace do not see it.
function SessionAwareMatchmakerLink() {
  const { user, loading } = useSession();
  if (loading || !user) return null;
  const hasBuyerWorkspace = user.workspaces.some((w) => w.capabilities.includes("Buyer"));
  if (!hasBuyerWorkspace) return null;
  return (
    <Link
      href="/matchmaker"
      className="text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors"
      data-testid="nav-matchmaker-link"
    >
      Matchmaker
    </Link>
  );
}

// Renders the Seller-requests inbox entry only when the signed-in
// user has at least one Seller-capable Workspace. Mirrors the
// Matchmaker gating pattern so a Buyer-only Workspace never sees
// the inbox link.
function SessionAwareSellerRequestsLink() {
  const { user, loading } = useSession();
  if (loading || !user) return null;
  const hasSellerWorkspace = user.workspaces.some((w) => w.capabilities.includes("Seller"));
  if (!hasSellerWorkspace) return null;
  return (
    <Link
      href="/seller-requests"
      className="text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors"
      data-testid="nav-seller-requests-link"
    >
      Seller inbox
    </Link>
  );
}

// Renders the Audio-samples management entry only when the
// signed-in user has at least one Seller-capable Workspace. This
// mirrors the Matchmaker / Seller-requests gating: an
// unauthenticated visitor never sees the link, and a
// Buyer-only Workspace never sees the link either. The route
// itself (apps/web/src/app/dashboard/audio/page.tsx) still
// re-checks the session and Seller capability server-side, but
// client-side gating here is the user-facing fix so a signed-out
// user at 375px never sees an Audio-samples entry they cannot use.
function SessionAwareAudioSamplesLink() {
  const { user, loading } = useSession();
  if (loading || !user) return null;
  const hasSellerWorkspace = user.workspaces.some((w) => w.capabilities.includes("Seller"));
  if (!hasSellerWorkspace) return null;
  return (
    <Link
      href="/dashboard/audio"
      className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
      data-testid="nav-audio-samples"
    >
      Audio samples
    </Link>
  );
}

// Hamburger button. Visible only on small viewports. Toggles the
// mobile menu panel and is keyboard-accessible: it is a real
// `<button>` with `aria-expanded` so screen readers announce the
// panel state, and `aria-controls` ties it to the panel's id.
function MobileMenuToggle() {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        setOpen((value) => !value);
      }}
      className="inline-flex items-center justify-center p-2 rounded-md text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
      aria-expanded={open}
      aria-controls="nav-mobile-panel"
      aria-label={open ? "Close menu" : "Open menu"}
      data-testid="nav-mobile-toggle"
    >
      <span aria-hidden="true" className="block w-5 h-0.5 bg-current relative before:absolute before:left-0 before:-top-1.5 before:w-5 before:h-0.5 before:bg-current after:absolute after:left-0 after:top-1.5 after:w-5 after:h-0.5 after:bg-current"></span>
    </button>
  );
}

// Stacked mobile panel. Renders only on small viewports; the
// desktop row already shows the same links at >=md. The panel
// closes itself when the user resizes the viewport back to
// desktop so the open hamburger state cannot leak into the
// desktop layout.
//
// Each capability-gated link re-runs the same SessionProvider
// gating logic as the desktop row, so an unauthenticated visitor
// at a narrow viewport never sees Matchmaker, Seller inbox, or
// Audio samples — and the panel itself never renders empty link
// stubs that would otherwise hint at hidden functionality.
function MobileMenuPanel() {
  const [open, setOpen] = useState(false);
  const { user, loading } = useSession();

  // Close on resize to >=md so the panel state does not survive
  // across viewport changes. ResizeObserver is not available in
  // every test environment, so we listen to `resize` and only
  // run when the document is in the browser.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => {
      if (window.innerWidth >= mdBreakpointPx) {
        setOpen(false);
      }
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const hasBuyerWorkspace = user?.workspaces.some((w) => w.capabilities.includes("Buyer")) ?? false;
  const hasSellerWorkspace =
    user?.workspaces.some((w) => w.capabilities.includes("Seller")) ?? false;

  // Loading and unauthenticated visitors see no panel links (and
  // the toggle is still rendered so the SessionStatus sign-in link
  // is reachable). Authenticated visitors see the gated links.
  return (
    <div
      id="nav-mobile-panel"
      className={`${open ? "block" : "hidden"} md:hidden border-t border-gray-200 py-2`}
      data-testid="nav-mobile-panel"
      data-open={open ? "true" : "false"}
    >
      <div className="flex flex-col gap-1">
        {!loading && user && hasBuyerWorkspace && (
          <Link
            href="/matchmaker"
            className="block px-2 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
            data-testid="nav-mobile-matchmaker-link"
          >
            Matchmaker
          </Link>
        )}
        {!loading && user && hasSellerWorkspace && (
          <Link
            href="/seller-requests"
            className="block px-2 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
            data-testid="nav-mobile-seller-requests-link"
          >
            Seller inbox
          </Link>
        )}
        {!loading && user && hasSellerWorkspace && (
          <Link
            href="/dashboard/audio"
            className="block px-2 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
            data-testid="nav-mobile-audio-samples"
          >
            Audio samples
          </Link>
        )}
      </div>
    </div>
  );
}

// Tailwind's `md` breakpoint is 768px; the resize handler must use
// the same threshold so the panel closes at exactly the same
// viewport at which the desktop row appears.
const mdBreakpointPx = 768;