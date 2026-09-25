"use client";

// Dashboard grounded activity section (M2 #83).
//
// Background: the Personal-acting dashboard surfaces grounded
// activity (compact Requests + Deals counts), a low-prominence
// approval-readiness hint per Deal party, and a small recoverable
// error card when grounded activity could not be loaded. All
// three surfaces derive from durable repository records — no
// mutable onboarding step, no fabricated feed.
//
// P1-001 (cross-Workspace stale state): the section is gated
// on `loadedForWorkspaceId === actingWorkspace.workspaceId`.
// When the actor switches Workspaces and the new fetch has not
// yet resolved, `loadedForWorkspaceId` is `null` and this
// section renders NOTHING — no stale counts, no stale approval
// hints, no stale error card. Workspace-scoped state cannot
// leak across a switch.
//
// P1-002 (party-appropriate approval readiness): Buyer-side
// readiness fires when a Negotiating Deal the actor owns on the
// Buyer side is awaiting Buyer approval. Seller-side readiness
// fires symmetrically for Seller-side Deals awaiting Seller
// approval. Copy is party-appropriate (no Buyer wording on a
// Seller-side hint).
//
// P2-002 (truthful failure surface): requests and deals carry
// independent load/error state. A failure from one list does
// NOT discard the other list's successful response. The error
// card surfaces a recoverable "couldn't load" message so a
// broken API is distinguishable from a genuinely empty
// Workspace.
//
// Extracted from `dashboard/page.tsx` so behavior tests can
// render the section in isolation with controlled props (no
// SessionProvider wrapper required).

import Link from "next/link";
import { Card } from "../components/ui/Card";
import type {
  Bg1PublicWorkspaceV1,
  DealListItemPublicV1,
  ProjectRequestPublicV1,
} from "@soundhub/types";

export interface DashboardActivitySectionProps {
  readonly requests: readonly ProjectRequestPublicV1[] | null;
  readonly deals: readonly DealListItemPublicV1[] | null;
  readonly requestsLoadError: boolean;
  readonly dealsLoadError: boolean;
  readonly hasBuyer: boolean;
  readonly hasSeller: boolean;
  readonly actingWorkspace: Bg1PublicWorkspaceV1;
  readonly loadedForWorkspaceId: string | null;
}

/**
 * Pure presentational component for the dashboard's grounded
 * activity, approval readiness, and recoverable error surfaces.
 * Renders `null` when the loaded snapshot does not match the
 * current acting Workspace (P1-001 cross-Workspace gate).
 */
export function DashboardActivitySection({
  requests,
  deals,
  requestsLoadError,
  dealsLoadError,
  hasBuyer,
  hasSeller,
  actingWorkspace,
  loadedForWorkspaceId,
}: DashboardActivitySectionProps) {
  // P1-001 gate: refuse to render anything when the loaded
  // snapshot does not match the current acting Workspace. This
  // covers the in-flight case after a Workspace switch AND any
  // future race where stale state could otherwise reach the
  // browser. Behavior tests exercise this gate explicitly:
  // an actor switch with `loadedForWorkspaceId === null` (or
  // a different Workspace id) MUST render zero activity,
  // approval, or error surfaces.
  if (loadedForWorkspaceId !== actingWorkspace.workspaceId) {
    return null;
  }

  const buyerPendingRequests =
    requests === null
      ? 0
      : requests.filter(
          (r) => r.status === "Pending" && r.buyerWorkspaceId === actingWorkspace.workspaceId,
        ).length;
  const sellerPendingRequests =
    requests === null
      ? 0
      : requests.filter(
          (r) => r.status === "Pending" && r.sellerWorkspaceId === actingWorkspace.workspaceId,
        ).length;
  const negotiatingDeals =
    deals === null ? 0 : deals.filter((d) => d.status === "Negotiating").length;
  const dealsLoaded = deals !== null;
  const buyerNeedsApproval =
    hasBuyer &&
    dealsLoaded &&
    deals.some(
      (d) =>
        d.status === "Negotiating" &&
        d.actingSide === "Buyer" &&
        (d.approvalState === "AwaitingBuyerApproval" ||
          d.approvalState === "AwaitingBothApprovals"),
    );
  const sellerNeedsApproval =
    hasSeller &&
    dealsLoaded &&
    deals.some(
      (d) =>
        d.status === "Negotiating" &&
        d.actingSide === "Seller" &&
        (d.approvalState === "AwaitingSellerApproval" ||
          d.approvalState === "AwaitingBothApprovals"),
    );
  const showActivity =
    requests !== null &&
    deals !== null &&
    (buyerPendingRequests > 0 || sellerPendingRequests > 0 || negotiatingDeals > 0);
  const showLoadError = requestsLoadError || dealsLoadError;

  return (
    <>
      {showActivity ? (
        <Card variant="parchment" data-testid="dashboard-activity">
          <Card.Header>
            <Card.Title>Your activity</Card.Title>
          </Card.Header>
          <Card.Content>
            <ul className="space-y-2 text-base">
              {hasBuyer && buyerPendingRequests > 0 && (
                <li className="flex items-baseline justify-between gap-3">
                  <span className="text-muted">Pending requests you sent</span>
                  <span
                    className="font-medium text-ink"
                    data-testid="dashboard-activity-buyer-pending"
                  >
                    {buyerPendingRequests}
                  </span>
                </li>
              )}
              {hasSeller && sellerPendingRequests > 0 && (
                <li className="flex items-baseline justify-between gap-3">
                  <Link
                    href="/seller-requests"
                    className="text-aubergine hover:text-aubergine-hover font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
                    data-testid="dashboard-activity-seller-pending-link"
                  >
                    Requests awaiting your response
                  </Link>
                  <span
                    className="font-medium text-ink"
                    data-testid="dashboard-activity-seller-pending"
                  >
                    {sellerPendingRequests}
                  </span>
                </li>
              )}
              {negotiatingDeals > 0 && (
                <li className="flex items-baseline justify-between gap-3">
                  <Link
                    href="/deals"
                    className="text-aubergine hover:text-aubergine-hover font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
                    data-testid="dashboard-activity-deals-link"
                  >
                    Deals negotiating
                  </Link>
                  <span className="font-medium text-ink" data-testid="dashboard-activity-deals">
                    {negotiatingDeals}
                  </span>
                </li>
              )}
            </ul>
          </Card.Content>
        </Card>
      ) : null}

      {showLoadError ? (
        <Card variant="parchment" data-testid="dashboard-activity-error">
          <Card.Header>
            <Card.Title>Couldn&apos;t load your activity</Card.Title>
          </Card.Header>
          <Card.Content>
            <p className="text-base text-muted">
              SoundHub couldn&apos;t load your current activity. Refresh the page to try again.
            </p>
          </Card.Content>
        </Card>
      ) : null}

      {buyerNeedsApproval ? (
        <p className="text-sm text-muted" data-testid="dashboard-approval-readiness-buyer">
          A Negotiating Deal needs your buyer approval. You can set up permission to approve terms
          when you open the Deal.
        </p>
      ) : null}

      {sellerNeedsApproval ? (
        <p className="text-sm text-muted" data-testid="dashboard-approval-readiness-seller">
          A Negotiating Deal needs your seller approval. You can set up permission to approve terms
          when you open the Deal.
        </p>
      ) : null}
    </>
  );
}
