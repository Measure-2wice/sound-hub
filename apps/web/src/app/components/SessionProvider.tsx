"use client";

// Shared session seam.
//
// Background: BG1 keeps the API authoritative for identity. The
// HttpOnly session cookie is the only signal the browser can trust,
// and `GET /api/auth/me` is the only way the browser learns the
// authenticated user. Several client components — the navigation's
// `SessionStatus`, the `Dashboard`, the `MagicLinkVerifier`, and
// the login page's dev-verification handler — all need the same
// user. They used to each fetch the session independently on mount,
// which left them inconsistent: after a successful magic-link
// verification the dashboard re-fetched (it just mounted) but the
// navigation kept its stale "Sign in" until a full page reload,
// because client-side route changes never re-run mount-time fetches.
//
// `SessionProvider` is the single seam every auth-aware client
// component reads from. It owns the user state, fetches it from the
// authoritative endpoint on mount, and exposes a `refresh()` that
// any caller can invoke after a state-changing auth action. The
// helper methods (`verifyAndRefresh`, `signOutAndRefresh`) wrap the
// auth-client calls so the refresh can never drift from the action:
// a successful verify always re-pulls the authoritative user; a
// sign-out always clears it; a failed verify never marks the user
// signed in. Both the managed (Supabase) callback and the
// deterministic dev verification URL flow through the same seam.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  Bg1PublicUserV1,
  Bg1VerifyTokenRequestV1,
  Bg1VerifyTokenResponseV1,
} from "@soundhub/types";
import { fetchSessionInfo, signOut as signOutRequest, verifyToken } from "../lib/auth-client";

export interface SessionContextValue {
  readonly user: Bg1PublicUserV1 | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  // Run the verify-token request, then pull the authoritative
  // session info so every consumer (navigation, dashboard) reflects
  // the new identity without a full page reload. Throws on failure
  // without mutating state — failed verifications MUST NOT mark the
  // user signed in.
  readonly verifyAndRefresh: (input: Bg1VerifyTokenRequestV1) => Promise<Bg1VerifyTokenResponseV1>;
  // Run sign-out, then re-pull the session so every consumer clears
  // the signed-in state consistently.
  readonly signOutAndRefresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const [user, setUser] = useState<Bg1PublicUserV1 | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const info = await fetchSessionInfo();
      setUser(info.user);
    } catch {
      setUser(null);
    }
  }, []);

  // Initial fetch on mount. The provider lives at the root of the
  // client tree so every consumer sees the same authoritative user
  // from the first render. Subsequent auth actions call `refresh`
  // (directly or via the helpers) instead of duplicating the
  // request.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await fetchSessionInfo();
        if (cancelled) return;
        setUser(info.user);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const verifyAndRefresh = useCallback(
    async (input: Bg1VerifyTokenRequestV1): Promise<Bg1VerifyTokenResponseV1> => {
      // The verify call runs first and only resolves on a 2xx
      // response; the safe-envelope error path throws. On failure
      // we never touch `user`, so the navigation and dashboard
      // cannot drift into a "signed in" state for an unverified
      // session.
      const response = await verifyToken(input);
      await refresh();
      return response;
    },
    [refresh],
  );

  const signOutAndRefresh = useCallback(async (): Promise<void> => {
    await signOutRequest();
    // After sign-out the server no longer recognises the session
    // cookie, so `/api/auth/me` returns null. Re-pull to clear every
    // consumer consistently.
    await refresh();
  }, [refresh]);

  const value = useMemo<SessionContextValue>(
    () => ({ user, loading, refresh, verifyAndRefresh, signOutAndRefresh }),
    [user, loading, refresh, verifyAndRefresh, signOutAndRefresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    // The provider is mounted by the root layout, so a missing
    // provider indicates a tree wiring regression rather than a
    // runtime branch. Throw so the regression fails loudly during
    // development instead of silently rendering an unauthenticated
    // shell.
    throw new Error("useSession must be used inside <SessionProvider>.");
  }
  return value;
}
