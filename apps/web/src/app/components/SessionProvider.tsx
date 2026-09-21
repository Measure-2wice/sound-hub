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
// component reads from. It owns the user state, fetches it from
// the authoritative endpoint on mount, and exposes a `refresh()` that
// any caller can invoke after a state-changing auth action. The
// helper methods (`verifyAndRefresh`, `signOutAndRefresh`) wrap the
// auth-client calls so the refresh can never drift from the action:
// a successful verify always re-pulls the authoritative user; a
// sign-out always clears it; a failed verify never marks the user
// signed in. Both the managed (Supabase) callback and the
// deterministic dev verification URL flow through the same seam.
//
// M2 (#82): the `verifyAndRefresh` helper returns the full verify-
// token response (including the server-derived `setupState` and the
// validated `returnTo`) so callers can navigate appropriately
// without an additional round-trip.
//
// M2 (#83): the acting-Workspace id is a CLIENT convenience only.
// The `actingWorkspaceId` exposed here is derived from localStorage
// (via `remembered-acting-workspace.ts`) and falls back to the
// user's Personal Workspace. The server does NOT persist this
// value; every consequential command names its acting Workspace
// explicitly and the server revalidates current membership on
// every request via the existing #82 `requireActingMembership`
// route (which accepts any Owner/Admin/Member role).

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
import {
  clearRememberedActingWorkspaceId,
  readRememberedActingWorkspaceId,
} from "../lib/remembered-acting-workspace";

export interface SessionContextValue {
  readonly user: Bg1PublicUserV1 | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  // Run the verify-token request, then pull the authoritative
  // session info so every consumer (navigation, dashboard) reflects
  // the new identity without a full page reload. Throws on failure
  // without mutating state — failed verifications MUST NOT mark the
  // user signed in. Returns the full verify-token response so
  // callers can read `returnTo` and `user.setupState` without an
  // additional round-trip.
  readonly verifyAndRefresh: (input: Bg1VerifyTokenRequestV1) => Promise<Bg1VerifyTokenResponseV1>;
  // Run sign-out, then re-pull the session so every consumer clears
  // the signed-in state consistently.
  readonly signOutAndRefresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Resolve the current acting-Workspace id from the user's
 * accessible workspaces plus a remembered localStorage value.
 * Falls back to the user's Personal Workspace when the remembered
 * value is not accessible or no remembered value exists. Returns
 * `null` when no Workspace is accessible.
 */
function resolveActingWorkspaceId(
  user: Bg1PublicUserV1 | null,
  remembered: string | null,
): string | null {
  if (!user) return null;
  if (user.workspaces.length === 0) return null;
  // The remembered value is convenience only — revalidate against
  // the user's current accessible workspaces.
  if (remembered) {
    const match = user.workspaces.find((w) => w.workspaceId === remembered);
    if (match) return match.workspaceId;
  }
  // Default to the Personal Workspace. The Personal Workspace is
  // the production-shaped first Workspace; Organization
  // memberships never become the default.
  const personal = user.workspaces.find((w) => w.workspaceType === "Personal");
  return personal ? personal.workspaceId : user.workspaces[0]!.workspaceId;
}

export interface ActingWorkspaceContextValue {
  readonly actingWorkspaceId: string | null;
  readonly actingWorkspace: Bg1PublicUserV1["workspaces"][number] | null;
}

const ActingWorkspaceContext = createContext<ActingWorkspaceContextValue>({
  actingWorkspaceId: null,
  actingWorkspace: null,
});

export function ActingWorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const { user } = useSession();
  const [remembered, setRemembered] = useState<string | null>(null);

  // Read localStorage on mount. Server-rendered HTML cannot
  // access localStorage; the value is `null` on the first render
  // and re-derives on the client.
  useEffect(() => {
    setRemembered(readRememberedActingWorkspaceId());
  }, []);

  const actingWorkspaceId = useMemo(
    () => resolveActingWorkspaceId(user, remembered),
    [user, remembered],
  );

  const actingWorkspace = useMemo(() => {
    if (!user || !actingWorkspaceId) return null;
    return user.workspaces.find((w) => w.workspaceId === actingWorkspaceId) ?? null;
  }, [user, actingWorkspaceId]);

  // Expose a way for the selector to update the remembered value
  // and trigger re-derivation.
  const setActingWorkspaceId = useCallback((workspaceId: string | null) => {
    if (workspaceId === null) {
      clearRememberedActingWorkspaceId();
    } else {
      // Use the dynamic import via window.localStorage to avoid
      // the SSR-safe path.
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem("soundhub.actingWorkspaceId", workspaceId);
        }
      } catch {
        // Best-effort.
      }
    }
    setRemembered(workspaceId);
  }, []);

  const value = useMemo<ActingWorkspaceContextValue>(
    () => ({ actingWorkspaceId, actingWorkspace }),
    [actingWorkspaceId, actingWorkspace],
  );

  return (
    <ActingWorkspaceContext.Provider value={value}>
      <ActingWorkspaceUpdateContext.Provider value={setActingWorkspaceId}>
        {children}
      </ActingWorkspaceUpdateContext.Provider>
    </ActingWorkspaceContext.Provider>
  );
}

const ActingWorkspaceUpdateContext = createContext<(id: string | null) => void>(() => {
  // Default no-op; the provider overrides it. Used by the
  // selector to write the remembered value without exposing
  // localStorage to the rest of the tree.
});

export function useActingWorkspace(): ActingWorkspaceContextValue {
  return useContext(ActingWorkspaceContext);
}

export function useSetActingWorkspace(): (id: string | null) => void {
  return useContext(ActingWorkspaceUpdateContext);
}

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
    clearRememberedActingWorkspaceId();
    // After sign-out the server no longer recognises the session
    // cookie, so `/api/auth/me` returns null. Re-pull to clear every
    // consumer consistently.
    await refresh();
  }, [refresh]);

  const value = useMemo<SessionContextValue>(
    () => ({ user, loading, refresh, verifyAndRefresh, signOutAndRefresh }),
    [user, loading, refresh, verifyAndRefresh, signOutAndRefresh],
  );

  return (
    <SessionContext.Provider value={value}>
      <ActingWorkspaceProvider>{children}</ActingWorkspaceProvider>
    </SessionContext.Provider>
  );
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
