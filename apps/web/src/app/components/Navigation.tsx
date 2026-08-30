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
// The Matchmaker, Seller-requests, and Audio-samples links own
// their own auth-aware visibility because their gating is
// capability-specific. Routes themselves also enforce server-side
// authorization (the audio samples page already does), but the
// client-side gating here is what prevents a signed-out user from
// ever seeing the link.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bg1PublicUserV1 } from "@soundhub/types";
import { useSession } from "./SessionProvider";
import { SessionStatus } from "./SessionStatus";

export function Navigation() {
  const { user, loading } = useSession();

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

  const hasBuyerWorkspace = useMemo(
    () => user?.workspaces.some((w) => w.capabilities.includes("Buyer")) ?? false,
    [user],
  );
  const hasSellerWorkspace = useMemo(
    () => user?.workspaces.some((w) => w.capabilities.includes("Seller")) ?? false,
    [user],
  );

  // Hamburger visibility: only render the toggle when the session
  // has at least one capability-gated mobile navigation
  // destination. A signed-out session, or a signed-in session whose
  // Workspaces carry neither Buyer nor Seller capability, renders
  // no hamburger and no panel — the brand + sign-in/sign-out row
  // is enough at small widths. Authorization remains a server/
  // application concern; this is a presentation-only narrowing.
  const hasMobileDestination =
    !loading && user !== null && (hasBuyerWorkspace || hasSellerWorkspace);

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
            {hasMobileDestination && <MobileMenuToggle open={open} onToggle={onToggle} />}
          </div>
        </div>
        <MobileMenuPanel
          open={open}
          onClose={onClose}
          user={user}
          loading={loading}
          hasBuyerWorkspace={hasBuyerWorkspace}
          hasSellerWorkspace={hasSellerWorkspace}
        />
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

// Stacked mobile panel. Renders only on small viewports; the
// desktop row already shows the same links at >=md. The panel
// reads `open` from the same lifted state as the toggle so its
// visibility is always synchronized with `aria-expanded`. Each
// capability-gated link re-runs the same SessionProvider gating
// logic as the desktop row, so an unauthenticated visitor at a
// narrow viewport never sees Matchmaker, Seller inbox, or Audio
// samples — and the panel itself never renders empty link stubs
// that would otherwise hint at hidden functionality.
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
  user,
  loading,
  hasBuyerWorkspace,
  hasSellerWorkspace,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly user: Bg1PublicUserV1 | null;
  readonly loading: boolean;
  readonly hasBuyerWorkspace: boolean;
  readonly hasSellerWorkspace: boolean;
}) {
  // The session-derived `user` and `loading` are passed as props
  // so the panel renders the same way whether invoked from
  // `Navigation` or from a controlled test harness — the panel
  // remains a pure presentational component over its props.

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

  // Render an empty panel fragment when the session has no
  // capability-gated mobile destinations — even with `open=true`
  // there are no links to display. The toggle itself is hidden by
  // the parent's `hasMobileDestination` guard, so this path is
  // only reached when the panel is opened via Escape/resize
  // racing a sign-out. Closing via onClose() still runs.
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
            onClick={onClose}
            className="block px-2 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
            data-testid="nav-mobile-matchmaker-link"
          >
            Matchmaker
          </Link>
        )}
        {!loading && user && hasSellerWorkspace && (
          <Link
            href="/seller-requests"
            onClick={onClose}
            className="block px-2 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
            data-testid="nav-mobile-seller-requests-link"
          >
            Seller inbox
          </Link>
        )}
        {!loading && user && hasSellerWorkspace && (
          <Link
            href="/dashboard/audio"
            onClick={onClose}
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
