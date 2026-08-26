"use client";

// Session status widget for the navigation.
//
// Background: BG1 requires the browser to never assert an arbitrary
// UserAccount. The session cookie is the only authoritative identity
// signal, and the only way the client learns the authenticated user
// is by calling `GET /api/auth/me`. The widget reads from the
// shared `SessionProvider` seam so the navigation re-renders in
// lock-step with the dashboard: a successful magic-link
// verification (managed or deterministic) refreshes the session
// once, and every auth-aware client component sees the new user
// from the same render pass. Sign-out re-pulls the (now-empty)
// session so the navigation clears consistently without a full
// page reload.

import Link from "next/link";
import { useSession } from "./SessionProvider";

export function SessionStatus() {
  const { user, loading, signOutAndRefresh } = useSession();

  if (loading) {
    return <span className="text-sm text-gray-500">Loading…</span>;
  }
  if (!user) {
    return (
      <Link
        href={"/login"}
        className="text-sm font-medium text-blue-600 hover:text-blue-700"
        data-testid="nav-sign-in"
      >
        Sign in
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-3" data-testid="nav-session">
      <span className="text-sm text-gray-700" data-testid="nav-session-email">
        {user.email ?? "Signed in"}
      </span>
      <button
        type="button"
        onClick={() => {
          void (async () => {
            await signOutAndRefresh();
          })();
        }}
        className="text-sm font-medium text-gray-600 hover:text-gray-900"
        data-testid="nav-sign-out"
      >
        Sign out
      </button>
    </div>
  );
}
