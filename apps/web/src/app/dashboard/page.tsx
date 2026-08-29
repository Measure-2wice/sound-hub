"use client";

// Dashboard page.
//
// Background: the BG1 integrated browser journey signs in, lands on
// the dashboard, sees the available Workspaces, picks one to "act
// as", and proves the GS 4 contract by calling a sample
// consequential command that requires current WorkspaceMembership.
// The page is intentionally simple — later Golden Slice tickets
// will add ProjectRequest, Deal, TermsVersion, and approval flows
// on top of this same foundation.
//
// The dashboard reads the authenticated user from the shared
// `SessionProvider` seam so a successful magic-link verification
// (managed or deterministic) renders the dashboard signed in
// immediately, without depending on a re-fetch on mount. Sign-out
// uses the same seam so the navigation and dashboard clear
// consistently without a full page reload.

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "../components/SessionProvider";
import type { Bg1ActingWorkspaceResponseV1, Bg1PublicWorkspaceV1 } from "@soundhub/types";
import { bg1ActingWorkspaceResponseV1Schema } from "@soundhub/types";
import { Card } from "../components/ui/Card";

export default function DashboardPage() {
  const { user, loading, signOutAndRefresh } = useSession();
  const router = useRouter();
  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [actingResult, setActingResult] = useState<Bg1ActingWorkspaceResponseV1 | null>(null);
  const [actingError, setActingError] = useState<string | null>(null);
  const [commandResult, setCommandResult] = useState<string | null>(null);

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

  const handleSelectActingWorkspace = async (e: FormEvent) => {
    e.preventDefault();
    setActingError(null);
    setActingResult(null);
    try {
      const response = await fetch("/api/auth/acting-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ actingWorkspaceId }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error: { code: string; message: string } };
        setActingError(body.error.message);
        return;
      }
      const parsed = bg1ActingWorkspaceResponseV1Schema.parse(await response.json());
      setActingResult(parsed);
    } catch (err) {
      setActingError(err instanceof Error ? err.message : "Could not select acting workspace.");
    }
  };

  const handleConsequentialCommand = async () => {
    setCommandResult(null);
    if (!actingWorkspaceId) {
      setCommandResult("Pick an acting Workspace first.");
      return;
    }
    // The BG1 sample consequential command is the
    // POST /api/auth/acting-workspace route: it requires an
    // authenticated session AND a current WorkspaceMembership AND
    // is revalidated server-side on every call. Proving the route
    // succeeds in the dashboard demonstrates the GS 4 / GS 5
    // contract end to end.
    try {
      const response = await fetch("/api/auth/acting-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ actingWorkspaceId }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error: { code: string; message: string } };
        setCommandResult(`Rejected (${body.error.code}): ${body.error.message}`);
        return;
      }
      const parsed = bg1ActingWorkspaceResponseV1Schema.parse(await response.json());
      setCommandResult(`Authorized as ${parsed.actingWorkspace.name} (${parsed.membership.role}).`);
    } catch (err) {
      setCommandResult(err instanceof Error ? err.message : "Command could not be processed.");
    }
  };

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
            onClick={() => {
              void (async () => {
                await signOutAndRefresh();
                router.push("/");
              })();
            }}
            className="mt-3 text-sm font-medium text-gray-600 hover:text-gray-900"
            data-testid="dashboard-sign-out"
          >
            Sign out
          </button>
        </Card.Content>
      </Card>

      <Card data-testid="dashboard-workspaces">
        <Card.Header>
          <Card.Title>Your Workspaces</Card.Title>
        </Card.Header>
        <Card.Content>
          <WorkspaceList
            workspaces={user.workspaces}
            actingWorkspaceId={actingWorkspaceId}
            onSelect={setActingWorkspaceId}
          />
          <form
            onSubmit={(e) => {
              handleSelectActingWorkspace(e).catch(() => {
                /* surfaced via setActingError above */
              });
            }}
            className="mt-4 space-y-2"
          >
            <button
              type="submit"
              disabled={!actingWorkspaceId}
              className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              data-testid="dashboard-select-acting-submit"
            >
              Verify acting Workspace
            </button>
            {actingError && (
              <p className="text-sm text-red-700" data-testid="dashboard-acting-error">
                {actingError}
              </p>
            )}
            {actingResult && (
              <p className="text-sm text-green-700" data-testid="dashboard-acting-result">
                Authorized: {actingResult.actingWorkspace.name} ({actingResult.membership.role})
              </p>
            )}
          </form>
        </Card.Content>
      </Card>

      <Card data-testid="dashboard-consequential-command">
        <Card.Header>
          <Card.Title>Consequential command</Card.Title>
        </Card.Header>
        <Card.Content>
          <p className="text-sm text-gray-700">
            This sample command requires explicit acting-Workspace and current WorkspaceMembership.
            The server revalidates every request and rejects non-members.
          </p>
          <button
            type="button"
            onClick={() => {
              handleConsequentialCommand().catch(() => {
                /* surfaced via setCommandResult above */
              });
            }}
            className="mt-3 bg-emerald-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-emerald-700 transition-colors"
            data-testid="dashboard-consequential-submit"
          >
            Send consequential command
          </button>
          {commandResult && (
            <p className="mt-2 text-sm text-gray-800" data-testid="dashboard-consequential-result">
              {commandResult}
            </p>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}

function WorkspaceList({
  workspaces,
  actingWorkspaceId,
  onSelect,
}: {
  workspaces: readonly Bg1PublicWorkspaceV1[];
  actingWorkspaceId: string;
  onSelect: (id: string) => void;
}) {
  if (workspaces.length === 0) {
    return (
      <p className="text-sm text-gray-600" data-testid="dashboard-no-workspaces">
        You have no current Workspaces.
      </p>
    );
  }
  return (
    <ul className="space-y-2" data-testid="dashboard-workspace-list">
      {workspaces.map((workspace) => (
        <li key={workspace.workspaceId}>
          <label
            className={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
              actingWorkspaceId === workspace.workspaceId
                ? "border-blue-500 bg-blue-50"
                : "border-gray-200"
            }`}
            data-testid="dashboard-workspace-option"
            data-workspace-id={workspace.workspaceId}
          >
            <input
              type="radio"
              name="actingWorkspaceId"
              value={workspace.workspaceId}
              checked={actingWorkspaceId === workspace.workspaceId}
              onChange={() => onSelect(workspace.workspaceId)}
              className="mt-1"
              data-testid="dashboard-workspace-radio"
            />
            <span>
              <span className="block text-sm font-medium text-gray-900">{workspace.name}</span>
              <span className="block text-xs text-gray-500">
                {workspace.workspaceType} · {workspace.workspaceStatus} · capabilities:{" "}
                {workspace.capabilities.join(", ")}
              </span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
