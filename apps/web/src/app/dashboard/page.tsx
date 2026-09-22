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
//   - The dashboard derives from the COMMITTED
//     `actingWorkspace` (via `useActingWorkspace()`); the same
//     provider the Shell, selector, and switch page use. There
//     is no Personal-state pinning.
//
//   - `Choose intent` CTA + auto-redirect to `/workspace/intent`
//     fire ONLY when the actor is a Personal Workspace.
//     Organization-acting dashboards never offer Personal-only
//     intent provisioning.
//
//   - Organization-acting dashboards render capability-aware
//     surfaces from durable capabilities (Buyer/Seller rows),
//     NOT from "missing" defaults. An Organization with no
//     capabilities renders the neutral Organization empty-state
//     and a link to switch back to the user's Personal
//     Workspace — that link uses the existing switch
//     interstitial (not a `/workspace/intent` redirect).
//
//   - Recovery is rendered for `user.setupState === "recovery"`
//     and is independent of the acting Workspace.

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActingWorkspace, useSession } from "../components/SessionProvider";
import { Card } from "../components/ui/Card";
import { Alert } from "../components/ui/Alert";

export default function DashboardPage() {
  const { user, loading } = useSession();
  const { actingWorkspace, actingWorkspaceId } = useActingWorkspace();
  const router = useRouter();

  // Route capability-less Personal-acting users to the intent
  // page on mount. Organization-acting users never receive the
  // Personal-only intent CTA / auto-redirect.
  useEffect(() => {
    if (loading) return;
    if (!user) return;
    if (user.setupState === "recovery") return;
    if (!actingWorkspace) return;
    if (actingWorkspace.workspaceType !== "Personal") return;
    const hasAnyCapability =
      actingWorkspace.capabilities.includes("Buyer") ||
      actingWorkspace.capabilities.includes("Seller");
    if (!hasAnyCapability) {
      void router.replace("/workspace/intent");
    }
  }, [user, loading, actingWorkspace, router]);

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

  if (!actingWorkspace) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="dashboard-no-actor">
          <Card variant="parchment">
            <Card.Header>
              <Card.Title>No acting Workspace</Card.Title>
            </Card.Header>
            <Card.Content>
              <p className="text-base text-muted">
                Your acting Workspace is being prepared. Refresh in a moment.
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
            {actingWorkspace.name}
          </h1>
          <p className="text-base text-muted" data-testid="dashboard-subtitle">
            {actingWorkspace.workspaceType === "Personal"
              ? "Your marketplace home."
              : "Your organization home."}
          </p>
        </header>

        {actingWorkspace.workspaceType === "Organization" ? (
          <OrganizationActingDashboard actingWorkspaceId={actingWorkspaceId} />
        ) : (
          <PersonalActingDashboard />
        )}
      </div>
    </div>
  );
}

function PersonalActingDashboard() {
  // The Personal-acting dashboard. Re-reads the actor via
  // `useActingWorkspace` rather than `user.workspaces.find(...)`.
  const { actingWorkspace } = useActingWorkspace();
  if (!actingWorkspace) return null;
  const hasAnyCapability =
    actingWorkspace.capabilities.includes("Buyer") ||
    actingWorkspace.capabilities.includes("Seller");

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2" data-testid="dashboard-readiness">
        {actingWorkspace.capabilities.includes("Buyer") && (
          <BuyerReadinessRow hasSeller={actingWorkspace.capabilities.includes("Seller")} />
        )}
        {actingWorkspace.capabilities.includes("Seller") && (
          <SellerReadinessRow hasBuyer={actingWorkspace.capabilities.includes("Buyer")} />
        )}
        {!hasAnyCapability && (
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
            {actingWorkspace.capabilities.includes("Buyer") && (
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
            {actingWorkspace.capabilities.includes("Seller") && (
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
            {/* Deals is a Deal-party destination, not a Buyer-only
                one. Sellers are also Deal parties. The action is
                available when EITHER capability is present. */}
            {(actingWorkspace.capabilities.includes("Buyer") ||
              actingWorkspace.capabilities.includes("Seller")) && (
              <li>
                <Link
                  href="/deals"
                  className="text-aubergine hover:text-aubergine-hover font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
                  data-testid="dashboard-view-deals"
                >
                  View your deals
                </Link>
              </li>
            )}
          </ul>
        </Card.Content>
      </Card>
    </>
  );
}

function OrganizationActingDashboard({
  actingWorkspaceId,
}: {
  readonly actingWorkspaceId: string | null;
}) {
  const { user } = useSession();
  const { actingWorkspace } = useActingWorkspace();
  if (!actingWorkspace) return null;
  const hasBuyer = actingWorkspace.capabilities.includes("Buyer");
  const hasSeller = actingWorkspace.capabilities.includes("Seller");
  const personalWorkspace = user?.workspaces.find((w) => w.workspaceType === "Personal") ?? null;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2" data-testid="dashboard-readiness">
        {hasBuyer && <BuyerReadinessRow hasSeller={hasSeller} />}
        {hasSeller && <SellerReadinessRow hasBuyer={hasBuyer} />}
        {!hasBuyer && !hasSeller && (
          <Card variant="parchment" data-testid="dashboard-org-no-capabilities">
            <Card.Header>
              <Card.Title>This organization has no marketplace capabilities yet</Card.Title>
            </Card.Header>
            <Card.Content>
              <p className="text-base text-muted mb-3">
                Capability provisioning is Personal-Workspace-only. Switch back to your Personal
                Workspace to choose how you want to use SoundHub as an individual.
              </p>
              {personalWorkspace && (
                <Link
                  href={`/workspace/switch?target=${encodeURIComponent(personalWorkspace.workspaceId)}`}
                  className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-4 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                  data-testid="dashboard-org-switch-to-personal"
                >
                  Switch to your Personal Workspace
                </Link>
              )}
            </Card.Content>
          </Card>
        )}
      </div>

      {actingWorkspaceId && personalWorkspace && (
        <Card variant="parchment" data-testid="dashboard-organization-context">
          <Card.Header>
            <Card.Title>You are acting as {actingWorkspace.name}</Card.Title>
          </Card.Header>
          <Card.Content>
            <p className="text-base text-muted">
              Capability provisioning, including the &quot;Choose intent&quot; flow, lives on your
              Personal Workspace. This organization&apos;s existing capability set is shown above.
            </p>
          </Card.Content>
        </Card>
      )}
    </>
  );
}

function BuyerReadinessRow({ hasSeller }: { readonly hasSeller: boolean }) {
  return (
    <Card variant="parchment" data-testid="dashboard-buyer-readiness">
      <Card.Header>
        <Card.Title>Hiring</Card.Title>
      </Card.Header>
      <Card.Content>
        <p className="text-base text-muted">
          You can find Caribbean talent, send project requests, and approve work.
        </p>
        <div className="mt-3 flex flex-col sm:flex-row gap-2">
          <Link
            href="/talent"
            className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-2 px-4 text-base font-medium text-white bg-coral hover:bg-coral-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
            data-testid="dashboard-buyer-find-talent"
          >
            Find talent
          </Link>
          {!hasSeller && (
            <Link
              href="/workspace/intent"
              className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-2 px-4 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
              data-testid="dashboard-add-offer"
            >
              Add Offer services too
            </Link>
          )}
        </div>
      </Card.Content>
    </Card>
  );
}

function SellerReadinessRow({ hasBuyer }: { readonly hasBuyer: boolean }) {
  // The previous "Profile and service setup unlocks after your
  // first deal" copy reversed the documented M2 journey:
  // published profile + active services are the prerequisites
  // for receiving ProjectRequests,
  // not the consequence of a first Deal. Replace with the
  // forward journey.
  return (
    <Card variant="parchment" data-testid="dashboard-seller-readiness">
      <Card.Header>
        <Card.Title>Offering services</Card.Title>
      </Card.Header>
      <Card.Content>
        <p className="text-base text-muted">
          Publish your professional profile and activate at least one service to appear in search
          results and receive project requests.
        </p>
        <p className="mt-2 text-sm text-muted" data-testid="dashboard-seller-hint">
          You can save private drafts as you go — publication is a separate explicit step.
        </p>
        {!hasBuyer && (
          <Link
            href="/workspace/intent"
            className="mt-3 inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-2 px-4 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
            data-testid="dashboard-add-hire"
          >
            Add Hire talent too
          </Link>
        )}
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
