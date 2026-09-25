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
//
// M2 (#82): the `verifyAndRefresh` helper returns the full verify-
// token response (including the server-derived `setupState` and the
// validated `returnTo`) so callers can navigate appropriately
// without an additional round-trip.
//
// M2 (#83) — Acting-Workspace context model:
//
//   The browser remembers one acting-Workspace id in localStorage
//   ("soundhub.actingWorkspaceId"). The provider splits that into:
//
//     - `actingWorkspaceId`: the COMMITTED value (localStorage-
//       backed). All consumers (Shell, switch page, dashboard) read
//       this value.
//     - `pendingTargetId`: a CANDIDATE the selector chose but the
//       user has not yet confirmed. No localStorage write.
//
//   Three update methods cover the surface:
//
//     - `setPendingTarget(id)`: selector → in-memory only. The
//       switch page reads this as its pending candidate.
//     - `commitPendingTarget()`: switch page → call the existing
//       `selectActingWorkspace` API; on success, write localStorage
//       and clear pending. On failure, leave both untouched so
//       Cancel-or-error leaves the committed state unchanged.
//     - `cancelPendingTarget()`: switch page Cancel → clears
//       pending without touching committed state.
//     - `clearActingWorkspace()`: sign-out → clears committed.
//
//   The `useActingWorkspace()` consumer hook returns the four
//   surfaces Shell / switch page / dashboard read from: committed
//   + pending (or null each). Cancel must never touch the
//   committed state.

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
import {
  fetchSessionInfo,
  signOut as signOutRequest,
  verifyToken,
  selectActingWorkspace as selectActingWorkspaceRequest,
} from "../lib/auth-client";
import {
  clearRememberedActingWorkspaceId,
  readRememberedActingWorkspaceId,
  writeRememberedActingWorkspaceId,
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
 * Resolve the committed acting-Workspace id from the user's
 * accessible workspaces plus a remembered localStorage value.
 *
 * Status gate (Codex review, P1-001): every branch — the
 * remembered match, the Personal-Workspace fallback, and the
 * first-workspace fallback — MUST consult `workspaceStatus ===
 * "Active"`. A remembered Suspended Organization, a Suspended
 * Personal Workspace, or any Suspended first-workspace entry
 * MUST NOT become the client actor. When no Active Workspace
 * is accessible the function returns `null` so the consumer
 * (the dashboard's `dashboard-no-actor` surface, the shell,
 * etc.) renders the explicit recovery affordance rather than
 * presenting a Suspended Workspace as current.
 */
function resolveActingWorkspaceId(
  user: Bg1PublicUserV1 | null,
  remembered: string | null,
): string | null {
  if (!user) return null;
  if (user.workspaces.length === 0) return null;
  // The remembered value is convenience only — revalidate against
  // the user's current ACCESSIBLE ACTIVE workspaces. A Suspended
  // remembered Workspace falls through to the safe-default chain
  // below (P1-001).
  if (remembered) {
    const match = user.workspaces.find(
      (w) => w.workspaceId === remembered && w.workspaceStatus === "Active",
    );
    if (match) return match.workspaceId;
  }
  // Default to the user's ACTIVE Personal Workspace. The Personal
  // Workspace is the production-shaped first Workspace; Organization
  // memberships never become the default. A Suspended Personal
  // Workspace falls through to the first Active accessible
  // Workspace (P1-001).
  const personal = user.workspaces.find(
    (w) => w.workspaceType === "Personal" && w.workspaceStatus === "Active",
  );
  if (personal) return personal.workspaceId;
  // Last resort: any Active accessible Workspace. Returning `null`
  // (instead of `user.workspaces[0]!.workspaceId`) ensures a
  // Suspended-only fixture never becomes the actor — the consumer
  // renders `dashboard-no-actor` instead (P1-001).
  const firstActive = user.workspaces.find((w) => w.workspaceStatus === "Active");
  return firstActive ? firstActive.workspaceId : null;
}

export interface ActingWorkspaceContextValue {
  readonly actingWorkspaceId: string | null;
  readonly actingWorkspace: Bg1PublicUserV1["workspaces"][number] | null;
  readonly pendingTargetId: string | null;
  readonly pendingTarget: Bg1PublicUserV1["workspaces"][number] | null;
}

const ActingWorkspaceContext = createContext<ActingWorkspaceContextValue>({
  actingWorkspaceId: null,
  actingWorkspace: null,
  pendingTargetId: null,
  pendingTarget: null,
});

export interface ActingWorkspaceUpdateContextValue {
  /** Selector → set the in-memory candidate; no localStorage write. */
  readonly setPendingTarget: (workspaceId: string | null) => void;
  /**
   * Switch page "Switch and continue". Calls the
   * `selectActingWorkspace` API; on success, writes localStorage
   * and clears pending, and returns the server-resolved
   * `safeReturnTo` (the destination the browser should navigate
   * to under the post-commit acting Workspace context). The
   * browser consumes ONLY this value — the raw `?return=` query
   * parameter is never honored client-side after a successful
   * commit. On failure, throws and leaves both committed +
   * pending untouched.
   *
   * `returnTo` is forwarded into the request body when the
   * caller (the switch interstitial) captured a validated
   * cross-Workspace continuation; the server re-resolves it
   * against the post-commit acting Workspace. When `null` /
   * omitted, the server returns `safeReturnTo: null` and the
   * caller falls back to `/dashboard`.
   */
  readonly commitPendingTarget: (returnTo?: string | null) => Promise<string | null>;
  /** Switch page "Cancel". Clears pending without touching committed. */
  readonly cancelPendingTarget: () => void;
  /** Sign-out + edge cases. Clears the committed localStorage value. */
  readonly clearActingWorkspace: () => void;
}

const ActingWorkspaceUpdateContext = createContext<ActingWorkspaceUpdateContextValue>({
  setPendingTarget: () => undefined,
  commitPendingTarget: () => Promise.resolve<string | null>(null),
  cancelPendingTarget: () => undefined,
  clearActingWorkspace: () => undefined,
});

export function ActingWorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const { user } = useSession();
  const [remembered, setRemembered] = useState<string | null>(null);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);

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

  const pendingTarget = useMemo(() => {
    if (!user || !pendingTargetId) return null;
    return user.workspaces.find((w) => w.workspaceId === pendingTargetId) ?? null;
  }, [user, pendingTargetId]);

  const setPendingTarget = useCallback((workspaceId: string | null) => {
    setPendingTargetId(workspaceId);
  }, []);

  const commitPendingTarget = useCallback(
    async (returnTo: string | null = null): Promise<string | null> => {
      if (!pendingTargetId) return null;
      // Validate the candidate is still a current member of the
      // user's accessible Workspaces BEFORE calling the network.
      if (!user || !user.workspaces.some((w) => w.workspaceId === pendingTargetId)) {
        throw new Error("Pending target is no longer a current Workspace; refusing to commit.");
      }
      // Server-side revalidation via the #82 acting-workspace route
      // (membership-not-Owner-only). The server resolves the
      // continuation under the POST-COMMIT acting Workspace
      // context and returns the `safeReturnTo` value the browser
      // should consume. On failure, leave both untouched.
      const response = await selectActingWorkspaceRequest({
        actingWorkspaceId: pendingTargetId,
        returnTo,
      });
      writeRememberedActingWorkspaceId(pendingTargetId);
      setRemembered(pendingTargetId);
      setPendingTargetId(null);
      return response.safeReturnTo ?? null;
    },
    [pendingTargetId, user],
  );

  const cancelPendingTarget = useCallback(() => {
    setPendingTargetId(null);
  }, []);

  const clearActingWorkspace = useCallback(() => {
    clearRememberedActingWorkspaceId();
    setRemembered(null);
    setPendingTargetId(null);
  }, []);

  const value = useMemo<ActingWorkspaceContextValue>(
    () => ({ actingWorkspaceId, actingWorkspace, pendingTargetId, pendingTarget }),
    [actingWorkspaceId, actingWorkspace, pendingTargetId, pendingTarget],
  );

  const updateValue = useMemo<ActingWorkspaceUpdateContextValue>(
    () => ({
      setPendingTarget,
      commitPendingTarget,
      cancelPendingTarget,
      clearActingWorkspace,
    }),
    [setPendingTarget, commitPendingTarget, cancelPendingTarget, clearActingWorkspace],
  );

  return (
    <ActingWorkspaceContext.Provider value={value}>
      <ActingWorkspaceUpdateContext.Provider value={updateValue}>
        {children}
      </ActingWorkspaceUpdateContext.Provider>
    </ActingWorkspaceContext.Provider>
  );
}

export function useActingWorkspace(): ActingWorkspaceContextValue {
  return useContext(ActingWorkspaceContext);
}

export function useSetActingWorkspace(): ActingWorkspaceUpdateContextValue {
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
