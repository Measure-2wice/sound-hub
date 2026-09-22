"use client";

// Workspace switch interstitial (M2 #83).
//
// Background: when an authenticated user navigates to a resource
// owned by a Workspace other than the current acting one AND the
// user has access to that target Workspace, the browser routes
// to this full-page interstitial. The interstitial is NOT a
// modal dialog — there is no focus trap, no Escape-to-cancel.
// Standard page-entry focus applies: the first focusable
// element (the `Switch and continue` button) receives focus on
// mount.
//
// Authorization rules:
//
//   - The committed selection is CLIENT convenience only. The
//     server does not persist it; the `Switch and continue`
//     button calls `commitPendingTarget` which calls the existing
//     #82 `POST /api/auth/acting-workspace` route (membership
//     not Owner-only per #82) and only writes localStorage on
//     success.
//   - Cancel calls `cancelPendingTarget` and navigates to
//     `/dashboard` — the committed value is NEVER touched by
//     cancel.
//   - The query-string `target` parameter is a recovery hint only.
//     The acting-workspace context provider is the source of truth;
//     the query is consulted only when context is stale (e.g., a
//     hard reload mid-transit). The candidate is revalidated
//     against `user.workspaces` before any action.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { Card } from "../../components/ui/Card";
import { Alert } from "../../components/ui/Alert";
import {
  useActingWorkspace,
  useSession,
  useSetActingWorkspace,
} from "../../components/SessionProvider";
import { isLocallyValidReturnPath } from "../../lib/return-path-shape";

export default function WorkspaceSwitchPage() {
  // `useSearchParams` requires a Suspense boundary at static-export
  // time. The page is client-rendered and dynamic; the inner
  // component reads `useSearchParams` so the route's static
  // generation can resolve.
  return (
    <Suspense fallback={<WorkspaceSwitchLoading />}>
      <WorkspaceSwitchPageInner />
    </Suspense>
  );
}

function WorkspaceSwitchLoading() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-2xl mx-auto px-6 py-12" data-testid="switch-loading">
        <Alert role="status" variant="status" title="Loading…">
          Just a moment.
        </Alert>
      </div>
    </div>
  );
}

function WorkspaceSwitchPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useSession();
  const { actingWorkspace, pendingTarget, pendingTargetId } = useActingWorkspace();
  const { commitPendingTarget, cancelPendingTarget, setPendingTarget } = useSetActingWorkspace();

  // Query-string target is a recovery hint for deep-link / hard-reload
  // cases (P1-002). When context is empty AND the URL carries a
  // `target=` query parameter, validate the candidate against the
  // user's accessible Workspaces and promote it to the in-memory
  // pending state. Once pendingTarget is set, the page's "Switch
  // and continue" commit operation must explicitly switch — no
  // silent no-op path.
  useEffect(() => {
    if (pendingTargetId !== null) return;
    if (!user) return;
    const queryTargetId = searchParams.get("target");
    if (!queryTargetId) return;
    const candidate = user.workspaces.find(
      (w) => w.workspaceId === queryTargetId && w.workspaceStatus === "Active",
    );
    if (!candidate) return;
    setPendingTarget(candidate.workspaceId);
  }, [pendingTargetId, user, searchParams, setPendingTarget]);

  // provider before navigating here).
  const queryTargetId = searchParams.get("target");
  // The cross-Workspace `?return=` query carries the destination
  // the customer was heading to before the acting Workspace
  // interstitial interrupted them. It is forwarded into the
  // acting-workspace commit call so the SERVER can re-resolve it
  // under the post-commit actor (see
  // `resolvePostCommandReturnDestination`). The browser never
  // honours the raw value directly; the server's `safeReturnTo`
  // is the only path the switch page can navigate to. Cancel
  // ignores it entirely.
  const queryReturnTo = useMemo(() => {
    const raw = searchParams.get("return");
    if (raw === null) return null;
    return isLocallyValidReturnPath(raw) ? raw : null;
  }, [searchParams]);

  const target = useMemo(() => {
    if (pendingTarget) return pendingTarget;
    if (!user || !queryTargetId) return null;
    return user.workspaces.find((w) => w.workspaceId === queryTargetId) ?? null;
  }, [pendingTarget, queryTargetId, user]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchButtonRef = useRef<HTMLButtonElement>(null);

  // Page-entry focus: the first focusable element (the
  // `Switch and continue` button) receives focus on mount.
  // This is the standard full-page interstitial pattern; no
  // modal dialog / focus trap is introduced.
  useEffect(() => {
    switchButtonRef.current?.focus();
  }, []);

  // If the candidate is missing OR no longer a current member of
  // the user's accessible Workspaces, render the unavailable
  // surface (the selector / future switch retries must come from
  // a fresh drop-down click).
  if (!user) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="switch-unavailable">
          <Card variant="parchment">
            <Card.Header>
              <Card.Title>Workspace switch unavailable</Card.Title>
            </Card.Header>
            <Card.Content>
              <p className="text-base text-muted mb-4">
                You are not signed in. Return to the dashboard.
              </p>
              <button
                type="button"
                onClick={() => router.replace("/dashboard")}
                className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                data-testid="switch-back-to-dashboard"
              >
                Return to dashboard
              </button>
            </Card.Content>
          </Card>
        </div>
      </div>
    );
  }

  if (!actingWorkspace || !target) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="switch-unavailable">
          <Card variant="parchment">
            <Card.Header>
              <Card.Title>Workspace switch unavailable</Card.Title>
            </Card.Header>
            <Card.Content>
              <p className="text-base text-muted mb-4">
                SoundHub could not safely switch to the requested Workspace. The target may not be
                accessible, or your remembered Workspace no longer exists.
              </p>
              <button
                type="button"
                onClick={() => {
                  cancelPendingTarget();
                  router.replace("/dashboard");
                }}
                className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                data-testid="switch-back-to-dashboard"
              >
                Return to dashboard
              </button>
            </Card.Content>
          </Card>
        </div>
      </div>
    );
  }

  const handleSwitch = () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    void (async () => {
      try {
        // The server revalidated target membership/status AND
        // resolved the continuation under the POST-COMMIT
        // acting Workspace context. The browser consumes ONLY
        // the server-returned `safeReturnTo` — the raw `?return=`
        // query parameter is never honored client-side after a
        // successful commit, so a cross-Workspace destination
        // cannot reach the browser before the Workspace the
        // customer just committed to is the actor.
        const safeReturnTo = await commitPendingTarget(queryReturnTo);
        // `safeReturnTo` is server-resolved against the bounded
        // #83 route set (`resolvePostCommandReturnDestination`).
        // Narrow it into the typed `Route<string>` representation
        // the Next.js router expects; out-of-set values fall back
        // to `/dashboard` rather than reaching the browser with
        // an untyped destination.
        const destination = toTypedSwitchRoute(safeReturnTo);
        router.replace(destination);
      } catch {
        // Commit failed — leave both committed state AND
        // pendingTarget untouched. Pending remains so the user
        // can retry, OR cancel.
        setError("SoundHub could not switch to this Workspace. Please try again.");
      } finally {
        setSubmitting(false);
      }
    })();
  };

  const handleCancel = () => {
    // Cancel never touches committed state and NEVER consumes
    // the target Workspace's return continuation. The customer
    // opted out of the switch — they return to a safe
    // current-Workspace surface (the dashboard). Following
    // `?return=` here would land them on a destination owned
    // by a Workspace they are no longer acting as, which is
    // not what they chose.
    cancelPendingTarget();
    router.replace("/dashboard");
  };

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-2xl mx-auto px-6 py-12" data-testid="workspace-switch-page">
        <h1 className="text-3xl font-serif text-ink mb-3" data-testid="workspace-switch-heading">
          Switch acting Workspace?
        </h1>
        <p className="text-base text-muted mb-8" data-testid="workspace-switch-summary">
          You&apos;re about to switch which Workspace you&apos;re acting as. SoundHub will
          revalidate your access. Any Workspace-scoped input you&apos;ve started will stay with the
          Workspace it was started on.
        </p>

        <Card variant="parchment" className="mb-6">
          <Card.Content>
            <dl className="space-y-3 text-base" data-testid="workspace-switch-current">
              <div>
                <dt className="inline font-medium text-muted">Currently acting as: </dt>
                <dd className="inline text-ink" data-testid="workspace-switch-current-name">
                  {actingWorkspace.name}
                </dd>
              </div>
            </dl>
          </Card.Content>
        </Card>

        <Card variant="parchment" className="mb-6">
          <Card.Content>
            <dl className="space-y-3 text-base" data-testid="workspace-switch-target">
              <div>
                <dt className="inline font-medium text-muted">Switch to: </dt>
                <dd className="inline text-ink" data-testid="workspace-switch-target-name">
                  {target.name}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-muted">Type: </dt>
                <dd className="inline text-ink">{target.workspaceType}</dd>
              </div>
              {target.capabilities.length > 0 && (
                <div>
                  <dt className="inline font-medium text-muted">Capabilities: </dt>
                  <dd className="inline text-ink">{target.capabilities.join(", ")}</dd>
                </div>
              )}
            </dl>
          </Card.Content>
        </Card>

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            ref={switchButtonRef}
            type="button"
            onClick={handleSwitch}
            disabled={submitting}
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded disabled:opacity-50 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
            data-testid="workspace-switch-continue"
          >
            {submitting ? "Switching…" : "Switch and continue"}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={submitting}
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-aubergine hover:text-aubergine-hover focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
            data-testid="workspace-switch-cancel"
          >
            Cancel
          </button>
        </div>

        {error && (
          <div className="mt-6" data-testid="workspace-switch-error">
            <Alert role="alert" variant="failure" title="Could not switch Workspace">
              {error}
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The bounded #83 destination routes the server returns from
 * `resolvePostCommandReturnDestination`. This list mirrors the
 * closed set so the local narrowing stays consistent with the
 * server-side enforcement. The list is intentionally explicit —
 * any new route the resolver grows MUST also be added here so
 * the typed `Route<string>` cast does not silently admit
 * out-of-band values.
 */
const BOUNDED_SWITCH_ROUTES = [
  "/dashboard",
  "/workspace/intent",
  "/workspace/switch",
  "/talent",
  "/deals",
  "/seller-requests",
  "/dashboard/audio",
] as const;

/**
 * Narrow a server-resolved `safeReturnTo` value into the typed
 * `Route<string>` representation the Next.js router expects.
 * The server already constrains the value to the bounded #83 set;
 * this helper exists so the typed cast is gated by an explicit
 * local match — out-of-set values fall back to `/dashboard`
 * rather than reaching the browser as an untyped string.
 */
function toTypedSwitchRoute(safeReturnTo: string | null): Route<string> {
  const fallback = "/dashboard" as Route<string>;
  if (safeReturnTo === null) return fallback;
  const pathOnly = safeReturnTo.split("?")[0] ?? "";
  if ((BOUNDED_SWITCH_ROUTES as readonly string[]).includes(pathOnly)) {
    return safeReturnTo as Route<string>;
  }
  return fallback;
}
