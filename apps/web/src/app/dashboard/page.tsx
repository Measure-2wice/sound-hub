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
// All surfaces preserve logical keyboard order, visible focus,
// ≥16px body text, ≥44×44px mobile hit areas, no autoplay, no
// decorative parallax. The recovery surface uses the application
// sans for operational copy and exposes only operable sign-out /
// recovery actions.
//
// Codex review (P1-003) flagged two sizing regressions on both the
// Personal Workspace surface and the recovery surface: every
// customer-facing paragraph was rendered at `text-sm` (14px) —
// below the M2 UX addendum's ≥16px floor — and the sign-out
// controls lacked the ≥44×44 mobile hit area the spec mandates.
// This file now uses `text-base` (16px) for body copy and reserves
// `text-xs` for metadata lines only (slug, type/status). Sign-out
// buttons use `min-h-[44px]` and `min-w-[44px]` plus `py-3 px-4`
// padding so the mobile touch target meets the spec at 375px.
//
// Codex review (P2-001) flagged a semantic-color regression on the
// sign-out controls: they rendered in neutral gray with blue focus
// styling instead of the aubergine semantic family the M2 UX
// addendum assigns to recovery and management actions
// (`docs/specs/milestone-2-reconciled-ux.md:269-274`). The base
// reference is around `#3B1E3E`; hover, focus, and disabled
// variants follow. The recovery body copy keeps the muted-text gray
// family because paragraph copy is operational, not actionable —
// only the action itself must read as aubergine.

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "../components/SessionProvider";
import type { Bg1PublicWorkspaceV1 } from "@soundhub/types";
import { Card } from "../components/ui/Card";

export default function DashboardPage() {
  const { user, loading, signOutAndRefresh } = useSession();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const handleSignOut = async (e: FormEvent) => {
    e.preventDefault();
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOutAndRefresh();
      router.push("/");
    } catch (err) {
      setSignOutError(err instanceof Error ? err.message : "Could not sign out right now.");
    } finally {
      setSigningOut(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12" data-testid="dashboard-loading">
        <p className="text-gray-600">Loading dashboard…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12" data-testid="dashboard-signed-out">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You are not signed in.{" "}
              <Link
                href={"/login"}
                className="text-blue-600 hover:text-blue-700 font-medium"
                data-testid="dashboard-sign-in-link"
              >
                Sign in
              </Link>{" "}
              to continue.
            </p>
          </Card.Content>
        </Card>
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
      />
    );
  }

  return (
    <PersonalWorkspaceSurface
      user={user}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      signOutError={signOutError}
    />
  );
}

function PersonalWorkspaceSurface({
  user,
  onSignOut,
  signingOut,
  signOutError,
}: {
  user: NonNullable<ReturnType<typeof useSession>["user"]>;
  onSignOut: (e: FormEvent) => Promise<void>;
  signingOut: boolean;
  signOutError: string | null;
}) {
  // The Personal Workspace is the new Personal Workspace created on
  // first auth (or the existing one for a returning user). The
  // browser renders the Personal Workspace card only — the BG1
  // engineering acting-Workspace selector is removed.
  const personalWorkspace = user.workspaces.find(
    (workspace) => workspace.workspaceType === "Personal",
  );

  return (
    <div className="max-w-2xl mx-auto px-6 py-12 space-y-6" data-testid="dashboard">
      <Card>
        <Card.Header>
          <Card.Title data-testid="dashboard-user-email">
            Signed in as {user.email ?? "anonymous"}
          </Card.Title>
        </Card.Header>
        <Card.Content>
          <p className="text-base text-gray-700">
            Identity provider:{" "}
            <code className="bg-gray-100 px-1 rounded text-sm">{user.identityProvider}</code>
          </p>
          <button
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
            className="mt-3 inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-4 text-base font-medium text-[#3B1E3E] hover:text-[#5a3061] disabled:opacity-50 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B1E3E] focus:ring-2 focus:ring-[#3B1E3E] rounded"
            data-testid="dashboard-sign-out"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          {signOutError && (
            <p className="mt-2 text-base text-red-700" data-testid="dashboard-sign-out-error">
              {signOutError}
            </p>
          )}
        </Card.Content>
      </Card>

      <Card data-testid="dashboard-personal-workspace">
        <Card.Header>
          <Card.Title>My Workspace</Card.Title>
        </Card.Header>
        <Card.Content>
          {personalWorkspace ? (
            <PersonalWorkspaceCard workspace={personalWorkspace} />
          ) : (
            <p className="text-base text-gray-700">Your Personal Workspace is being prepared.</p>
          )}
          <p
            className="mt-3 text-base text-gray-700"
            data-testid="dashboard-personal-workspace-next-action"
          >
            Choose what you want to do in SoundHub. The intent picker (Hire talent, Offer services,
            or Both) appears here once you decide.
          </p>
        </Card.Content>
      </Card>
    </div>
  );
}

function PersonalWorkspaceCard({ workspace }: { workspace: Bg1PublicWorkspaceV1 }) {
  return (
    <div data-testid="dashboard-personal-workspace-card">
      <p className="text-base font-medium text-gray-900">{workspace.name}</p>
      <p className="text-xs text-gray-500" data-testid="dashboard-personal-workspace-slug">
        {workspace.slug}
      </p>
      <p className="text-xs text-gray-500">
        {workspace.workspaceType} · {workspace.workspaceStatus} · capabilities:{" "}
        {workspace.capabilities.length === 0 ? "(none yet)" : workspace.capabilities.join(", ")}
      </p>
    </div>
  );
}

function RecoverySurface({
  user,
  onSignOut,
  signingOut,
  signOutError,
}: {
  user: NonNullable<ReturnType<typeof useSession>["user"]>;
  onSignOut: (e: FormEvent) => Promise<void>;
  signingOut: boolean;
  signOutError: string | null;
}) {
  // The recovery surface is rendered ONLY when
  // `user.setupState === "recovery"`. Per the M2 UX addendum:
  //   - Show signed-in / recovery context (email + provider key).
  //   - Calm explanation that SoundHub did not guess, merge, or
  //     select.
  //   - Operable sign-out button.
  //   - NO fabricated acting-Workspace selector.
  //   - NO support-process or security guarantee claims.
  //   - Surface truthful customer-facing Organization identity
  //     (name only — no slug, no raw capabilities, no internal
  //     role vocabulary) for any current Organization memberships
  //     so the customer knows those relationships remain.
  const organizationMemberships = user.workspaces.filter(
    (workspace) => workspace.workspaceType === "Organization",
  );

  return (
    <div className="max-w-2xl mx-auto px-6 py-12 space-y-6" data-testid="dashboard-recovery">
      <Card>
        <Card.Header>
          <Card.Title data-testid="dashboard-recovery-title">
            Workspace setup needs your attention
          </Card.Title>
        </Card.Header>
        <Card.Content>
          <p className="text-base text-gray-700">
            Signed in as{" "}
            <span data-testid="dashboard-recovery-email" className="font-medium">
              {user.email ?? "anonymous"}
            </span>{" "}
            (<code className="bg-gray-100 px-1 rounded text-xs">{user.identityProvider}</code>
            ). SoundHub did not guess, merge, or automatically select a Personal Workspace for this
            account.
          </p>
          <p className="mt-2 text-base text-gray-700" data-testid="dashboard-recovery-body">
            SoundHub couldn&apos;t safely confirm your Personal Workspace. Your existing Workspace
            memberships have not been changed.
          </p>
          <button
            type="button"
            onClick={(e) => {
              void onSignOut(e);
            }}
            disabled={signingOut}
            // Same aubergine treatment as the Personal Workspace
            // dashboard sign-out — see comment there. Recovery
            // actions are explicitly listed in the M2 UX addendum's
            // aubergine semantic family (`docs/specs/milestone-2-reconciled-ux.md:271`).
            className="mt-3 inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-4 text-base font-medium text-[#3B1E3E] hover:text-[#5a3061] disabled:opacity-50 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B1E3E] focus:ring-2 focus:ring-[#3B1E3E] rounded"
            data-testid="dashboard-recovery-sign-out"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          {signOutError && (
            <p
              className="mt-2 text-base text-red-700"
              data-testid="dashboard-recovery-sign-out-error"
            >
              {signOutError}
            </p>
          )}
        </Card.Content>
      </Card>
      {organizationMemberships.length > 0 && (
        <Card data-testid="dashboard-recovery-organizations">
          <Card.Header>
            <Card.Title>Your organization memberships</Card.Title>
          </Card.Header>
          <Card.Content>
            <p className="text-base text-gray-700">
              Your existing organization memberships are unchanged. The memberships below remain
              available through your existing acting-Workspace flow.
            </p>
            <ul className="mt-3 space-y-2" data-testid="dashboard-recovery-organizations-list">
              {organizationMemberships.map((organization) => (
                <li
                  key={organization.workspaceId}
                  className="text-base font-medium text-gray-900"
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
  );
}
