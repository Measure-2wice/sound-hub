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
//   - The remembered selection is CLIENT convenience only. The
//     server does not persist it; the `Switch and continue`
//     button calls the existing #82 `POST /api/auth/acting-workspace`
//     route to revalidate current membership against the target
//     Workspace before navigating forward. The route is
//     NOT Owner-only: any current Owner/Admin/Member role
//     passes.
//
// Scoped-form containment:
//
//   - Workspace-scoped transient input does NOT transfer across
//     a switch. The browser enforces this naturally — component
//     state is unmounted when the user navigates away from the
//     surface. A user retrying an action from a different
//     Workspace must re-enter the form.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "../../components/ui/Card";
import { Alert } from "../../components/ui/Alert";
import { selectActingWorkspace } from "../../lib/auth-client";
import { useSession, useSetActingWorkspace } from "../../components/SessionProvider";

export default function WorkspaceSwitchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, refresh } = useSession();
  const setActingWorkspaceId = useSetActingWorkspace();

  // Read target + return. The page DOES NOT trust raw query
  // params for the post-switch destination — the user can return
  // to the dashboard via the Cancel link. The `return` value is
  // surfaced for completeness but not used as a navigation
  // authority.
  const targetId = searchParams.get("target");
  const returnPath = searchParams.get("return");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchButtonRef = useRef<HTMLButtonElement>(null);

  const currentWorkspace = useMemo(() => {
    if (!user) return null;
    return user.workspaces[0] ?? null;
  }, [user]);

  const targetWorkspace = useMemo(() => {
    if (!user || !targetId) return null;
    return user.workspaces.find((w) => w.workspaceId === targetId) ?? null;
  }, [user, targetId]);

  // Page-entry focus: the first focusable element (the
  // `Switch and continue` button) receives focus on mount.
  // This is the standard full-page interstitial pattern; no
  // modal dialog / focus trap is introduced.
  useEffect(() => {
    switchButtonRef.current?.focus();
  }, []);

  if (!targetWorkspace || !currentWorkspace) {
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

  const handleSwitch = () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    void (async () => {
      try {
        await selectActingWorkspace({ actingWorkspaceId: targetWorkspace.workspaceId });
        setActingWorkspaceId(targetWorkspace.workspaceId);
        await refresh();
        // After a successful revalidation, navigate to the
        // requested return path. If the return path is the
        // dashboard itself (the typical case), navigate there;
        // otherwise honour it.
        const safeReturn =
          returnPath && returnPath.startsWith("/") && !returnPath.startsWith("//")
            ? returnPath
            : "/dashboard";
        // `safeReturn` is a known internal path; cast through the
        // runtime Route type.
        router.replace(safeReturn as Parameters<typeof router.replace>[0]);
      } catch {
        setError("SoundHub could not switch to this Workspace. Please try again.");
      } finally {
        setSubmitting(false);
      }
    })();
  };

  const handleCancel = () => {
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
                  {currentWorkspace.name}
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
                  {targetWorkspace.name}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-muted">Type: </dt>
                <dd className="inline text-ink">{targetWorkspace.workspaceType}</dd>
              </div>
              {targetWorkspace.capabilities.length > 0 && (
                <div>
                  <dt className="inline font-medium text-muted">Capabilities: </dt>
                  <dd className="inline text-ink">{targetWorkspace.capabilities.join(", ")}</dd>
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
