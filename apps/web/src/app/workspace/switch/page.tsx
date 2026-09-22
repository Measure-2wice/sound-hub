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

  // Thread `?return=` through the interstitial. The intent
  // page (and any other onboarding surface) carries the
  // validated destination as a query parameter; the switch page
  // must surface it after the explicit commit (or after cancel,
  // when the user bailed out). The server is the authoritative
  // validator — this client helper pre-filters obvious junk so
  // the user does not round-trip a value that would obviously
  // be rejected.
  const queryReturnTo = useMemo(() => {
    const raw = searchParams.get("return");
    if (!raw) return null;
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
        await commitPendingTarget();
        // Commit succeeded — committed + localStorage are updated
        // and pendingTarget is cleared by the provider. Navigate
        // to the validated `?return=` destination when one was
        // supplied, otherwise fall back to `/dashboard` under the
        // new acting Workspace.
        const destination = queryReturnTo ?? "/dashboard";
        router.replace(destination as Route);
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
    // Cancel never touches committed state. `cancelPendingTarget`
    // clears the in-memory candidate only. The validated
    // `?return=` destination is honoured when one was supplied
    // so the customer's pending resource is reachable even after
    // the user opted out of the Workspace
    // switch — the explicit-switch step was the only thing they
    // bypassed.
    cancelPendingTarget();
    const destination = queryReturnTo ?? "/dashboard";
    router.replace(destination as Route);
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
