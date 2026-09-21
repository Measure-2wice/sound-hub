"use client";

// Session status widget for the Shell.
//
// Background: BG1 requires the browser to never assert an arbitrary
// UserAccount. The session cookie is the only authoritative identity
// signal, and the only way the client learns the authenticated user
// is by calling `GET /api/auth/me`. The widget reads from the
// shared `SessionProvider` seam so the Shell re-renders in
// lock-step with the dashboard: a successful magic-link
// verification (managed or deterministic) refreshes the session
// once, and every auth-aware client component sees the new user
// from the same render pass. Sign-out re-pulls the (now-empty)
// session so the navigation clears consistently without a full
// page reload.
//
// M2 (#83): SessionStatus is the Sign in / Sign out affordance.
// Per the M2 UX addendum, sign-in / sign-out is a structural
// (aubergine) action. The widget surfaces that family here.

import Link from "next/link";
import { useSession } from "./SessionProvider";

export function SessionStatus() {
  const { user, loading, signOutAndRefresh } = useSession();

  if (loading) {
    return <span className="text-sm text-muted">Loading…</span>;
  }
  if (!user) {
    return (
      <Link
        href={"/login"}
        className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-2 px-3 text-sm font-medium text-aubergine hover:text-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine whitespace-nowrap"
        data-testid="nav-sign-in"
      >
        Sign in
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-3 min-w-0" data-testid="nav-session">
      <span
        className="hidden sm:inline text-sm text-muted truncate max-w-[10rem] md:max-w-[16rem]"
        data-testid="nav-session-email"
        title={user.email ?? "Signed in"}
      >
        {user.email ?? "Signed in"}
      </span>
      <button
        type="button"
        onClick={() => {
          void (async () => {
            await signOutAndRefresh();
          })();
        }}
        className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-2 px-3 text-sm font-medium text-aubergine hover:text-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine whitespace-nowrap"
        data-testid="nav-sign-out"
      >
        Sign out
      </button>
    </div>
  );
}
