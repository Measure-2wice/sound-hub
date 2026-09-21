"use client";

// Dashboard page (M2 #83).
//
// Background: the M2 dashboard is a Workspace-scoped readiness and
// activity home. It derives useful next actions from durable records
// (capabilities + persisted seller resources) rather than a mutable
// onboarding-step flag or a permanent exhaustive checklist. Buyer
// and Seller readiness remain independent; a dual-capability
// Workspace shows both without a persona switch. Missing contextual
// readiness does not globally block unrelated features.
//
// Authorization rules:
//
//   - The dashboard renders only after `useSession()` resolves. It
//     reads `user.setupState` (already server-derived per #82) to
//     decide between the Personal Workspace surface and the
//     recovery surface. Recovery is rendered from the server's
//     classification — the browser never infers recovery from the
//     workspaces array.
//   - Missing or empty capabilities are routed to
//     `/workspace/intent` via a one-shot `router.replace` (NOT
//     `push`, so the back button does not return to the
//     loop).
//
// M2 visual-QA: the dashboard uses the warm parchment canvas,
// ink/muted typography, and aubergine for management actions.
// Coral is reserved for marketplace-progression actions
// (none currently appear on the dashboard itself — they live
// on `/talent`, `Send project request`, and `Publish profile`).
// Sea-glass appears on the readiness badges for availability
// surfaces (none currently surface; the readiness rows below
// are placeholders for #84–#89).

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "../components/SessionProvider";
import { Card } from "../components/ui/Card";
import { Alert } from "../components/ui/Alert";

export default function DashboardPage() {
  const { user, loading } = useSession();
  const router = useRouter();

  // Route capability-less users to the intent page on mount.
  // This is a one-shot redirect, not a render gate.
  useEffect(() => {
    if (loading) return;
    if (!user) return;
    if (user.setupState === "recovery") return;
    const hasAnyCapability = user.workspaces.some(
      (w) => w.capabilities.includes("Buyer") || w.capabilities.includes("Seller"),
    );
    if (!hasAnyCapability) {
      void router.replace("/workspace/intent");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="dashboard-loading">
          <Alert role="status" variant="status" title="Loading your workspace…">
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
                  href="/login"
                  className="text-aubergine hover:text-aubergine-hover font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
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

  if (user.setupState === "recovery") {
    return <RecoverySurface user={user} />;
  }

  // Personal Workspace is the canonical Personal surface.
  const personal = user.workspaces.find((w) => w.workspaceType === "Personal") ?? null;

  if (!personal) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="dashboard-no-personal">
          <Card variant="parchment">
            <Card.Header>
              <Card.Title>No Personal Workspace</Card.Title>
            </Card.Header>
            <Card.Content>
              <p className="text-base text-muted">
                Your Personal Workspace is being prepared. Refresh in a moment.
              </p>
            </Card.Content>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6" data-testid="dashboard">
        <header className="mb-2">
          <h1 className="text-2xl font-serif text-ink mb-1" data-testid="dashboard-workspace-name">
            {personal.name}
          </h1>
          <p className="text-base text-muted" data-testid="dashboard-subtitle">
            Your marketplace home.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2" data-testid="dashboard-readiness">
          {personal.capabilities.includes("Buyer") && <BuyerReadinessRow />}
          {personal.capabilities.includes("Seller") && <SellerReadinessRow />}
          {!personal.capabilities.includes("Buyer") &&
            !personal.capabilities.includes("Seller") && (
              <Card variant="parchment" data-testid="dashboard-no-capabilities">
                <Card.Header>
                  <Card.Title>Choose how you want to use SoundHub</Card.Title>
                </Card.Header>
                <Card.Content>
                  <p className="text-base text-muted mb-3">
                    You haven&apos;t picked an intent yet. Hire talent, offer services, or both.
                  </p>
                  <Link
                    href="/workspace/intent"
                    className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-4 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                    data-testid="dashboard-choose-intent"
                  >
                    Choose intent
                  </Link>
                </Card.Content>
              </Card>
            )}
        </div>

        <Card variant="parchment" data-testid="dashboard-quick-actions">
          <Card.Header>
            <Card.Title>Quick actions</Card.Title>
          </Card.Header>
          <Card.Content>
            <ul className="space-y-2 text-base">
              {personal.capabilities.includes("Buyer") && (
                <li>
                  <Link
                    href="/talent"
                    className="text-aubergine hover:text-aubergine-hover font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
                    data-testid="dashboard-find-talent"
                  >
                    Find talent
                  </Link>
                </li>
              )}
              {personal.capabilities.includes("Seller") && (
                <li>
                  <Link
                    href="/dashboard/audio"
                    className="text-aubergine hover:text-aubergine-hover font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
                    data-testid="dashboard-manage-services"
                  >
                    Manage your services
                  </Link>
                </li>
              )}
              <li>
                <Link
                  href="/deals"
                  className="text-aubergine hover:text-aubergine-hover font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
                  data-testid="dashboard-view-deals"
                >
                  View your deals
                </Link>
              </li>
            </ul>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}

function BuyerReadinessRow() {
  return (
    <Card variant="parchment" data-testid="dashboard-buyer-readiness">
      <Card.Header>
        <Card.Title>Hiring</Card.Title>
      </Card.Header>
      <Card.Content>
        <p className="text-base text-muted">
          You can find Caribbean talent, send project requests, and approve work.
        </p>
        <Link
          href="/talent"
          className="mt-3 inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-2 px-4 text-base font-medium text-white bg-coral hover:bg-coral-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
          data-testid="dashboard-buyer-find-talent"
        >
          Find talent
        </Link>
      </Card.Content>
    </Card>
  );
}

function SellerReadinessRow() {
  return (
    <Card variant="parchment" data-testid="dashboard-seller-readiness">
      <Card.Header>
        <Card.Title>Offering services</Card.Title>
      </Card.Header>
      <Card.Content>
        <p className="text-base text-muted">
          Set up your Professional Profile and activate your first ServiceOffering to be
          discoverable on Talent.
        </p>
        <p className="mt-2 text-sm text-muted" data-testid="dashboard-seller-hint">
          Profile and ServiceOffering setup lands in #84 and #85.
        </p>
      </Card.Content>
    </Card>
  );
}

function RecoverySurface({
  user,
}: {
  readonly user: NonNullable<ReturnType<typeof useSession>["user"]>;
}) {
  const { signOutAndRefresh } = useSession();
  const router = useRouter();
  const organizationMemberships = user.workspaces.filter((w) => w.workspaceType === "Organization");
  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-6" data-testid="dashboard-recovery">
        <Card variant="recovery">
          <Card.Header>
            <Card.Title data-testid="dashboard-recovery-title">
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
              type="button"
              onClick={() => {
                void (async () => {
                  await signOutAndRefresh();
                  router.replace("/");
                })();
              }}
              className="mt-3 inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-4 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
              data-testid="dashboard-recovery-sign-out"
            >
              Sign out
            </button>
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
