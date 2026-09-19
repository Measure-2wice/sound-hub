"use client";

// Dashboard page.
//
// Background: the authenticated human lands on the dashboard after a
// successful magic-link verification. M2 (#82) makes the dashboard
// server-driven: it reads `user.setupState` (a server-derived
// classification of the Personal Workspace convergence state) and
// renders either the Personal Workspace surface or the recovery
// surface. The browser NEVER infers recovery from the workspaces
// array — only the server can classify the recovery state, and the
// public DTO exposes it as the opaque `setupState: "converged" |
// "recovery"` field.
//
// The BG1 engineering harness controls ("Verify acting Workspace",
// "Send consequential command") are removed entirely from the
// customer UX per the M2 UX addendum. The Personal Workspace
// dashboard shows the workspace identity and the readiness / next
// action placeholder (real readiness actions land in later M2
// tickets).
//
// M2 (#82) visual-QA remediation: the customer-facing arrival copy
// no longer exposes implementation / domain terminology. The
// Identity provider label, the Workspace slug, and the type/status
// /capabilities line are removed from the customer DOM. The opaque
// CUID-slug invariant is already pinned at the API/repository layer
// (`apps/api/src/auth-repository/prisma-auth-repository.test.ts:334`)
// so the browser no longer needs to assert it.
//
// The contradictory-Personal-Workspace recovery surface uses the
// `Card` `recovery` variant — warm parchment surface with a
// restrained gold border and an inline info glyph so the recovery
// cue is never color alone (per the M2 UX addendum). Structural
// actions (sign-out) stay aubergine.
//
// Sign-out transport failures map to a bounded customer-safe
// message ("We couldn't confirm sign-out. Please try again.") on a
// `role="alert"` Alert (variant=failure, no gold). The sign-out
// button stays operable (not disabled by the error state) and
// focus is restored to it when the error renders.
//
// All surfaces preserve logical keyboard order, visible focus,
// ≥16px body text, ≥44×44px mobile hit areas, no autoplay, no
// decorative parallax. The recovery surface uses the application
// sans for operational copy and exposes only operable sign-out /
// recovery actions.

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "../components/SessionProvider";
import type { Bg1PublicWorkspaceV1 } from "@soundhub/types";
import { Card } from "../components/ui/Card";
import { Alert } from "../components/ui/Alert";

// Calm inline info glyph paired with the recovery title so the
// gold-accent recovery cue is never color alone. The glyph is a
// circle with an "i" dot — calm, NOT a warning triangle.
function RecoveryGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="inline-block w-4 h-4 align-[-2px] mr-2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="10" cy="10" r="8" />
      <circle cx="10" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
      <path d="M10 9v5" strokeLinecap="round" />
    </svg>
  );
}

export default function DashboardPage() {
  const { user, loading, signOutAndRefresh } = useSession();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOutButtonRef = useRef<HTMLButtonElement>(null);

  const handleSignOut = async (e: FormEvent) => {
    e.preventDefault();
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOutAndRefresh();
      router.push("/");
    } catch {
      // Bounded copy — never expose the raw transport message
      // (e.g. "Failed to fetch") and never claim the session
      // definitely remains active.
      setSignOutError("We couldn't confirm sign-out. Please try again.");
    } finally {
      setSigningOut(false);
    }
  };

  // Restore focus to the sign-out button when the failure surfaces
  // so the retry stays operable and the user's focus target is
  // sensible. role="alert" alone does not guarantee focus movement.
  useEffect(() => {
    if (signOutError !== null && signOutButtonRef.current !== null) {
      signOutButtonRef.current.focus();
    }
  }, [signOutError]);

  if (loading) {
    // M2 (#82) visual-QA: the dashboard loading branch renders
    // EXACTLY ONE bounded warm status surface using the existing
    // Alert primitive (role="status", variant="status") — never an
    // unbounded floating paragraph. The primitive's title + body
    // are both rendered with text-base (16px) so the customer-safe
    // operational copy meets the addendum's ≥16px floor; the
    // parchment surface + warm neutral border (border-borderWarm)
    // is rendered with no gold recovery accent, no coral, and no
    // internal DTO / debug vocabulary. The surface stays inside
    // the existing #82 scoped `min-h-screen bg-canvas` wrapper so
    // the warm canvas treatment is owned by this page and never
    // leaks into the global body color.
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="dashboard-loading">
          <Alert
            role="status"
            variant="status"
            testId="dashboard-loading-status"
            title="Loading your workspace…"
          >
            Just a moment.
          </Alert>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="dashboard-signed-out">
          <Card variant="parchment">
            <Card.Content>
              <p className="text-base text-muted">
                You are not signed in.{" "}
                <Link
                  href={"/login"}
                  className="text-aubergine hover:text-aubergine-hover font-medium"
                  data-testid="dashboard-sign-in-link"
                >
                  Sign in
                </Link>{" "}
                to continue.
              </p>
            </Card.Content>
          </Card>
        </div>
      </div>
    );
  }

  // M2 (#82): the recovery decision is server-derived. The browser
  // reads ONLY `user.setupState` — it never infers recovery from the
  // workspaces array. This prevents a future Workspace type or
  // capability flag from silently changing the rendered surface.
  if (user.setupState === "recovery") {
    return (
      <RecoverySurface
        user={user}
        onSignOut={handleSignOut}
        signingOut={signingOut}
        signOutError={signOutError}
        signOutButtonRef={signOutButtonRef}
      />
    );
  }

  return (
    <PersonalWorkspaceSurface
      user={user}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      signOutError={signOutError}
      signOutButtonRef={signOutButtonRef}
    />
  );
}

function PersonalWorkspaceSurface({
  user,
  onSignOut,
  signingOut,
  signOutError,
  signOutButtonRef,
}: {
  user: NonNullable<ReturnType<typeof useSession>["user"]>;
  onSignOut: (e: FormEvent) => Promise<void>;
  signingOut: boolean;
  signOutError: string | null;
  signOutButtonRef: React.RefObject<HTMLButtonElement>;
}) {
  // The Personal Workspace is the new Personal Workspace created on
  // first auth (or the existing one for a returning user). The
  // browser renders the Personal Workspace card only — the BG1
  // engineering acting-Workspace selector is removed.
  const personalWorkspace = user.workspaces.find(
    (workspace) => workspace.workspaceType === "Personal",
  );

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-6" data-testid="dashboard">
        <Card variant="parchment">
          <Card.Header>
            <Card.Title data-testid="dashboard-user-email">
              Signed in as {user.email ?? "anonymous"}
            </Card.Title>
          </Card.Header>
          <Card.Content>
            <button
              ref={signOutButtonRef}
              type="button"
              onClick={(e) => {
                void onSignOut(e);
              }}
              disabled={signingOut}
              // M2 UX addendum assigns recovery and management actions
              // (including the dashboard sign-out control) to the
              // aubergine semantic family (`docs/specs/milestone-2-reconciled-ux.md:269-274`).
              // The base visual reference is around `#3B1E3E`. Hover,
              // keyboard focus, and disabled variants follow the
              // addendum's "foreground, hover, focus, disabled" rule
              // for each functional family.
              className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-4 text-base font-medium text-aubergine hover:text-aubergine-hover disabled:opacity-50 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine focus:ring-2 focus:ring-aubergine rounded"
              data-testid="dashboard-sign-out"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
            {signOutError && (
              <div className="mt-2">
                <Alert
                  role="alert"
                  variant="failure"
                  testId="dashboard-sign-out-error"
                  title="Could not sign out"
                >
                  {signOutError}
                </Alert>
              </div>
            )}
          </Card.Content>
        </Card>

        <Card variant="parchment" data-testid="dashboard-personal-workspace">
          <Card.Header>
            <Card.Title>My Workspace</Card.Title>
          </Card.Header>
          <Card.Content>
            {personalWorkspace ? (
              <PersonalWorkspaceCard workspace={personalWorkspace} />
            ) : (
              <p className="text-base text-muted">Your Personal Workspace is being prepared.</p>
            )}
            <p
              className="mt-3 text-base text-muted"
              data-testid="dashboard-personal-workspace-next-action"
            >
              When you&apos;re ready, you can choose what you want to do here.
            </p>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}

function PersonalWorkspaceCard({ workspace }: { workspace: Bg1PublicWorkspaceV1 }) {
  // M2 (#82) visual-QA: the opaque Workspace slug and the
  // type/status/capabilities line are removed from the customer-
  // visible DOM. The literal heading remains so the e2e contract
  // ("My Workspace rendered inside dashboard-personal-workspace-card
  // at computed fontSize ≥ 16px") holds.
  return (
    <div data-testid="dashboard-personal-workspace-card">
      <p className="text-base font-medium text-ink">{workspace.name}</p>
    </div>
  );
}

function RecoverySurface({
  user,
  onSignOut,
  signingOut,
  signOutError,
  signOutButtonRef,
}: {
  user: NonNullable<ReturnType<typeof useSession>["user"]>;
  onSignOut: (e: FormEvent) => Promise<void>;
  signingOut: boolean;
  signOutError: string | null;
  signOutButtonRef: React.RefObject<HTMLButtonElement>;
}) {
  // The recovery surface is rendered ONLY when
  // `user.setupState === "recovery"`. Per the M2 UX addendum:
  //   - Show signed-in / recovery context (email only — no
  //     provider-key disclosure).
  //   - Calm explanation that SoundHub did not guess, merge, or
  //     select.
  //   - Operable sign-out button.
  //   - NO fabricated acting-Workspace selector.
  //   - NO support-process or security guarantee claims.
  //   - Surface truthful customer-facing Organization identity
  //     (name only — no slug, no raw capabilities, no internal
  //     role vocabulary) for any current Organization memberships
  //     so the customer knows those relationships remain.
  //   - Restrained gold attention cue on the recovery Card
  //     chrome (border + inline info glyph), paired with the
  //     accompanying recovery text — never color alone, never
  //     danger/alarm.
  const organizationMemberships = user.workspaces.filter(
    (workspace) => workspace.workspaceType === "Organization",
  );

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-6" data-testid="dashboard-recovery">
        <Card variant="recovery">
          <Card.Header>
            <Card.Title data-testid="dashboard-recovery-title">
              <RecoveryGlyph />
              Workspace setup needs your attention
            </Card.Title>
          </Card.Header>
          <Card.Content>
            <p className="text-base text-muted">
              Signed in as{" "}
              <span data-testid="dashboard-recovery-email" className="font-medium text-ink">
                {user.email ?? "anonymous"}
              </span>
              . SoundHub did not guess, merge, or automatically select a Personal Workspace for this
              account.
            </p>
            <p className="mt-2 text-base text-muted" data-testid="dashboard-recovery-body">
              SoundHub couldn&apos;t safely confirm your Personal Workspace. Your existing Workspace
              memberships have not been changed.
            </p>
            <button
              ref={signOutButtonRef}
              type="button"
              onClick={(e) => {
                void onSignOut(e);
              }}
              disabled={signingOut}
              // Same aubergine treatment as the Personal Workspace
              // dashboard sign-out — see comment there. Recovery
              // actions are explicitly listed in the M2 UX addendum's
              // aubergine semantic family (`docs/specs/milestone-2-reconciled-ux.md:271`).
              className="mt-3 inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-4 text-base font-medium text-aubergine hover:text-aubergine-hover disabled:opacity-50 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine focus:ring-2 focus:ring-aubergine rounded"
              data-testid="dashboard-recovery-sign-out"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
            {signOutError && (
              <div className="mt-2">
                <Alert
                  role="alert"
                  variant="failure"
                  testId="dashboard-recovery-sign-out-error"
                  title="Could not sign out"
                >
                  {signOutError}
                </Alert>
              </div>
            )}
          </Card.Content>
        </Card>
        {organizationMemberships.length > 0 && (
          <Card variant="parchment" data-testid="dashboard-recovery-organizations">
            <Card.Header>
              <Card.Title>Your organization memberships</Card.Title>
            </Card.Header>
            <Card.Content>
              <p className="text-base text-muted">
                These organization memberships remain unchanged and continue to work as before.
              </p>
              <ul className="mt-3 space-y-2" data-testid="dashboard-recovery-organizations-list">
                {organizationMemberships.map((organization) => (
                  <li
                    key={organization.workspaceId}
                    className="text-base font-medium text-ink"
                    data-testid="dashboard-recovery-organization"
                  >
                    {organization.name}
                  </li>
                ))}
              </ul>
            </Card.Content>
          </Card>
        )}
      </div>
    </div>
  );
}
