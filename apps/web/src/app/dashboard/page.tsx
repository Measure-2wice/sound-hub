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
          <p className="text-sm text-gray-700">
            Identity provider:{" "}
            <code className="bg-gray-100 px-1 rounded">{user.identityProvider}</code>
          </p>
          <button
            type="button"
            onClick={(e) => {
              void onSignOut(e);
            }}
            disabled={signingOut}
            className="mt-3 text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
            data-testid="dashboard-sign-out"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          {signOutError && (
            <p className="mt-2 text-sm text-red-700" data-testid="dashboard-sign-out-error">
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
            <p className="text-sm text-gray-700">Your Personal Workspace is being prepared.</p>
          )}
          <p
            className="mt-3 text-sm text-gray-700"
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
      <p className="text-sm font-medium text-gray-900">{workspace.name}</p>
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
  return (
    <div className="max-w-2xl mx-auto px-6 py-12 space-y-6" data-testid="dashboard-recovery">
      <Card>
        <Card.Header>
          <Card.Title data-testid="dashboard-recovery-title">
            Workspace setup needs your attention
          </Card.Title>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-gray-700">
            Signed in as{" "}
            <span data-testid="dashboard-recovery-email" className="font-medium">
              {user.email ?? "anonymous"}
            </span>{" "}
            (<code className="bg-gray-100 px-1 rounded text-xs">{user.identityProvider}</code>
            ). SoundHub did not guess, merge, or automatically select a Personal Workspace for this
            account.
          </p>
          <p className="mt-2 text-sm text-gray-700">
            Sign out and try signing in again. If this keeps happening, the support team can review
            your account.
          </p>
          <button
            type="button"
            onClick={(e) => {
              void onSignOut(e);
            }}
            disabled={signingOut}
            className="mt-3 text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
            data-testid="dashboard-recovery-sign-out"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          {signOutError && (
            <p
              className="mt-2 text-sm text-red-700"
              data-testid="dashboard-recovery-sign-out-error"
            >
              {signOutError}
            </p>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
