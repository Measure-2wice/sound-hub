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
//   - The query-string `target` parameter is the user's CURRENT
//     explicit intent. A stale in-memory `pendingTargetId` from a
//     previous uncommitted switch (e.g., a browser-back away from
//     the interstitial, or a dashboard deep-link clicked before the
//     commit settled) MUST NOT shadow the URL's `target`. The
//     promotion effect re-syncs `pendingTargetId` to the resolved
//     candidate whenever they diverge, AND the `target` memo
//     prefers a valid query-string candidate on first render so the
//     page never flashes the wrong "Switch to:" card. The candidate
//     is revalidated against `user.workspaces` (Active gate) before
//     any action.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { postCommandRouteValuesV1 } from "@soundhub/types";
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
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
        <div className="max-w-2xl mx-auto" data-testid="switch-loading">
          <Alert role="status" variant="status" title="Loading…">
            Just a moment.
          </Alert>
        </div>
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

  // Query-string target is the user's CURRENT explicit intent. The
  // re-sync runs whenever `pendingTargetId` diverges from the
  // resolved URL candidate — NOT only when `pendingTargetId` is
  // null. The original null-only gate let a stale `pendingTargetId`
  // from a previous uncommitted switch (selector → browser-back
  // → dashboard deep-link) shadow the URL's `target` and render
  // the wrong "Switch to:" card (visual-QA regression). The
  // selector flow (`handleSelect` pre-sets `pendingTarget` to the
  // same id before navigating) already has `pendingTargetId ===
  // candidate.workspaceId` on mount, so this is a no-op there.
  // Once `pendingTarget` is set, the page's "Switch and continue"
  // commit operation must still explicitly switch — no silent
  // no-op path.
  useEffect(() => {
    if (!user) return;
    const queryTargetId = searchParams.get("target");
    if (!queryTargetId) return;
    const candidate = user.workspaces.find(
      (w) => w.workspaceId === queryTargetId && w.workspaceStatus === "Active",
    );
    if (!candidate) return;
    if (pendingTargetId !== candidate.workspaceId) {
      setPendingTarget(candidate.workspaceId);
    }
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
    // The query-string `target` is the user's current explicit
    // intent (e.g., the dashboard "Switch to your Personal
    // Workspace" link). When it resolves to a valid Active
    // Workspace, it MUST win over any stale `pendingTargetId`
    // from a previous uncommitted switch — otherwise the page
    // would render the wrong "Switch to:" card for one render
    // before the re-sync effect catches up. The selector flow
    // pre-sets `pendingTarget` to the same id before navigating,
    // so both branches resolve to the same Workspace there and
    // there is no observable difference.
    if (user && queryTargetId) {
      const queryCandidate = user.workspaces.find(
        (w) => w.workspaceId === queryTargetId && w.workspaceStatus === "Active",
      );
      if (queryCandidate) return queryCandidate;
    }
    if (pendingTarget) return pendingTarget;
    return null;
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
        <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
          <div className="max-w-2xl mx-auto" data-testid="switch-unavailable">
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
      </div>
    );
  }

  if (!actingWorkspace || !target) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
          <div className="max-w-2xl mx-auto" data-testid="switch-unavailable">
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
      <div className="max-w-[1440px] mx-auto px-6 lg:px-12 py-12">
        <div className="max-w-2xl mx-auto" data-testid="workspace-switch-page">
          <h1 className="text-3xl font-serif text-ink mb-3" data-testid="workspace-switch-heading">
            Switch acting Workspace?
          </h1>
          <p className="text-base text-muted mb-8" data-testid="workspace-switch-summary">
            You&apos;re about to switch which Workspace you&apos;re acting as. SoundHub will
            revalidate your access. Any Workspace-scoped input you&apos;ve started will stay with
            the Workspace it was started on.
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
    </div>
  );
}

/**
 * The bounded #83 destination routes the server returns from
 * `resolvePostCommandReturnDestination`. The closed enum is
 * declared ONCE in `@soundhub/types` (`postCommandRouteValuesV1`)
 * and consumed by both the server-side authority boundary and
 * this typed client narrowing helper — adding a route in the
 * resolver extends the same shared list, so a server-returnable
 * value can never be silently rejected here.
 *
 * The `as const` on the source tuple keeps every entry's literal
 * type. The `BOUNDED_SWITCH_ROUTE_LITERALS` derived union is exactly
 * `${StaticRoutes}` (a subset of `StaticRoutes`); the typed
 * template-literal composition in `toTypedSwitchRoute` produces
 * a value of type `${StaticRoutes}${SearchOrHash}` which is one
 * of the arms of `Route<string>`. The function therefore returns
 * `Route<string>` with no `as Route<string>` cast at the boundary.
 */
type BoundedSwitchRouteLiteral = (typeof postCommandRouteValuesV1)[number];
const BOUNDED_SWITCH_ROUTE_LITERALS: readonly BoundedSwitchRouteLiteral[] =
  postCommandRouteValuesV1;

/**
 * Runtime/type guard: returns true when `candidate` matches one
 * of the bounded route literals. Reuses the shared closed enum
 * from `@soundhub/types` so the client can never drift from the
 * server-side authorising list. The cast inside `has()` is
 * strictly the type-cast the runtime helper needs to satisfy the
 * readonly tuple's `.includes(string)` signature; it does not
 * cross the function boundary that the typed narrowing helper
 * upholds.
 */
function isBoundedSwitchRouteLiteral(candidate: string): candidate is BoundedSwitchRouteLiteral {
  return (BOUNDED_SWITCH_ROUTE_LITERALS as readonly string[]).includes(candidate);
}

/**
 * The server-resolved query suffix is restricted to the typed
 * `SearchOrHash` arm of `Route<string>` (`?${string} | #${string}`,
 * or empty when no suffix is present). `SearchOrHash` is the
 * only suffix shape `Route<string>` accepts, so matching it
 * here is sufficient to compose a valid typed route.
 */
type SearchOrHashSuffix = "" | `?${string}` | `#${string}`;
function isSearchOrHashSuffix(value: string): value is SearchOrHashSuffix {
  return value === "" || value.startsWith("?") || value.startsWith("#");
}

/**
 * Narrow a server-resolved `safeReturnTo` value into the typed
 * `Route<string>` representation the Next.js router expects.
 * The server already constrains the value to the bounded #83 set;
 * this helper exists so the typed narrowing is gated by an
 * explicit local match — out-of-set values fall back to
 * `/dashboard` rather than reaching the browser as an untyped
 * string.
 *
 * The function has no `as Route<string>` cast at the boundary:
 * after the runtime guard, `pathOnly` is a typed literal from
 * the closed enum; after the runtime guard, `querySuffix` is
 * `SearchOrHash`; the template-literal composition
 * `\`${pathOnly}${querySuffix}\`` is therefore
 * `\`${BoundedSwitchRouteLiteral}${SearchOrHashSuffix}\``, which
 * is a subset of `\`${StaticRoutes}${SearchOrHash}\`` and
 * therefore assignable to `Route<string>`.
 */
function toTypedSwitchRoute(safeReturnTo: string | null): Route<string> {
  if (safeReturnTo === null) return "/dashboard";
  const pathOnly = safeReturnTo.split("?")[0] ?? "";
  if (!isBoundedSwitchRouteLiteral(pathOnly)) return "/dashboard";
  const queryIndex = safeReturnTo.indexOf("?");
  const rawSuffix = queryIndex === -1 ? "" : safeReturnTo.slice(queryIndex);
  if (!isSearchOrHashSuffix(rawSuffix)) {
    // Defensive: if the suffix is not a valid `SearchOrHash`,
    // return the bare typed route rather than producing a
    // string the router cannot accept.
    return pathOnly;
  }
  // `${BoundedSwitchRouteLiteral}${SearchOrHashSuffix}` is a
  // subset of `${StaticRoutes}${SearchOrHash}`, which is a
  // valid `Route<string>` arm. TypeScript infers the template
  // literal at compile time from the operand types so the
  // boundary does NOT need a cast.
  return `${pathOnly}${rawSuffix}`;
}
