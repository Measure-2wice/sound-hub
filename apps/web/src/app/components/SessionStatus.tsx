"use client";

// Session status widget for the navigation.
//
// Background: BG1 requires the browser to never assert an arbitrary
// UserAccount. The session cookie is the only authoritative identity
// signal, and the only way the client learns the authenticated user
// is by calling `GET /api/auth/me`. This widget revalidates on mount
// and after sign-in / sign-out so the nav stays consistent with the
// authoritative server state.

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchSessionInfo, signOut } from "../lib/auth-client";
import type { Bg1PublicUserV1 } from "@soundhub/types";

export function SessionStatus() {
  const [user, setUser] = useState<Bg1PublicUserV1 | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await fetchSessionInfo();
        if (cancelled) return;
        setUser(info.user);
      } catch {
        if (cancelled) return;
        setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-check after sign-out events fired from other tabs would require
  // a storage-event listener; BG1 keeps that out of scope. The
  // in-component `onClick` handlers below revalidate by reloading the
  // page so the server-rendered state is the source of truth.
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
            await signOut();
            window.location.reload();
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
