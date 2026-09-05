"use client";

// Deals discovery page (ticket #74).
//
// Background: ticket #74 makes Deals discoverable from signed-in
// navigation. Before this page, `/deals/:dealId` worked but nothing
// linked to it — a user who left the creation workflow had to retain
// the raw Deal URL.
//
// This page lists the Deals belonging to the selected acting
// Workspace and links each row to the existing Deal page. It does not
// redesign that page and adds no Deal domain behavior.
//
// Authorization: this page renders only what `GET /api/deals` returns.
// The API revalidates current membership for the exact acting
// Workspace inside the same transaction that reads the Deals, so a
// revoked member receives an authorization error rather than rows.
// Client-side rendering is never the access-control boundary.
//
// Acting Workspace: the page owns its own selection, matching the
// established per-page pattern (matchmaker, seller inbox, dashboard).
// Consolidating those into a shared switcher is deliberately out of
// scope for this ticket.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { DealListItemPublicV1 } from "@soundhub/types";
import { useSession } from "../components/SessionProvider";
import { Card } from "../components/ui/Card";
import { listDeals } from "../lib/deal-list-client";
import {
  buildDealStatusLine,
  describeActingSide,
  describeCounterparty,
  describeDealTitle,
  describeFundingStatus,
  formatDealDate,
} from "./deal-list-copy";

export default function DealsPage() {
  const { user, loading, refresh } = useSession();
  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [deals, setDeals] = useState<readonly DealListItemPublicV1[]>([]);
  const [loadingList, setLoadingList] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // A Deal always has a Buyer-capable and a Seller-capable side, so
  // either capability makes a Workspace eligible to hold Deals. This
  // mirrors the navigation gate in `components/Navigation.tsx`.
  const eligibleWorkspaces = useMemo(
    () =>
      user?.workspaces.filter(
        (workspace) =>
          workspace.capabilities.includes("Buyer") || workspace.capabilities.includes("Seller"),
      ) ?? [],
    [user],
  );

  const onSessionInvalid = useCallback(() => {
    void refresh();
  }, [refresh]);

  const reload = useCallback(
    async (workspaceId: string, isCancelled: () => boolean) => {
      if (!workspaceId) {
        setDeals([]);
        return;
      }
      setLoadingList(true);
      setError(null);
      try {
        const result = await listDeals(workspaceId);
        // A later selection already superseded this request. Applying
        // its rows would show one Workspace's Deals under another
        // Workspace's selection.
        if (isCancelled()) return;
        setDeals(result.deals);
      } catch (err) {
        if (isCancelled()) return;
        // A stale session hands control back to the SessionProvider,
        // which re-renders the signed-out state. Showing an error too
        // would be redundant and misleading.
        if (
          err instanceof Error &&
          ((err as { code?: string }).code === "SESSION_INVALID" ||
            (err as { code?: string }).code === "AUTH_FAILED" ||
            (err as { code?: string }).code === "SESSION_EXPIRED")
        ) {
          onSessionInvalid();
          return;
        }
        setDeals([]);
        setError(err instanceof Error ? err.message : "Could not load your Deals.");
      } finally {
        if (!isCancelled()) setLoadingList(false);
      }
    },
    [onSessionInvalid],
  );

  useEffect(() => {
    if (eligibleWorkspaces.length === 0) {
      setDeals([]);
      return;
    }
    if (
      !actingWorkspaceId ||
      !eligibleWorkspaces.some((workspace) => workspace.workspaceId === actingWorkspaceId)
    ) {
      setActingWorkspaceId(eligibleWorkspaces[0]!.workspaceId);
    }
  }, [eligibleWorkspaces, actingWorkspaceId]);

  useEffect(() => {
    // Guard against out-of-order responses when the acting Workspace
    // changes while a request is in flight, matching the pattern used
    // by the matchmaker, audio dashboard, and Deal detail pages.
    let cancelled = false;
    void reload(actingWorkspaceId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [actingWorkspaceId, reload]);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="deals-loading">
        <p className="text-gray-600">Loading Deals…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="deals-signed-out">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You are not signed in.{" "}
              <Link
                href="/login"
                className="text-blue-600 hover:text-blue-700 font-medium"
                data-testid="deals-sign-in-link"
              >
                Sign in
              </Link>{" "}
              to view your Deals.
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-6" data-testid="deals-page">
      <Card data-testid="deals-header">
        <Card.Header>
          <Card.Title>Deals</Card.Title>
          <Card.Description>
            Deals belonging to the selected acting Workspace, whether it is the buyer or the seller
            side. Select a Deal to open its terms, approvals, and funding.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {eligibleWorkspaces.length === 0 ? (
            <p className="text-sm text-red-700" data-testid="deals-no-eligible-workspace">
              Your account does not currently belong to a Workspace that can hold Deals.
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-gray-900">Acting Workspace</legend>
              {eligibleWorkspaces.map((workspace) => (
                <label
                  key={workspace.workspaceId}
                  className={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
                    actingWorkspaceId === workspace.workspaceId
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200"
                  }`}
                  data-testid="deals-workspace-option"
                  data-workspace-id={workspace.workspaceId}
                >
                  <input
                    type="radio"
                    name="actingWorkspaceId"
                    value={workspace.workspaceId}
                    checked={actingWorkspaceId === workspace.workspaceId}
                    onChange={() => setActingWorkspaceId(workspace.workspaceId)}
                    className="mt-1"
                    data-testid="deals-workspace-radio"
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">
                      {workspace.name}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {workspace.workspaceType} · {workspace.workspaceStatus}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </Card.Content>
      </Card>

      <Card data-testid="deals-list-card">
        <Card.Header>
          <Card.Title>Your Deals</Card.Title>
          <Card.Description>
            One row per Deal. Status, approval state, and funding state are derived from the
            recorded terms, approvals, and payment evidence.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {error && (
            <p className="text-sm text-red-700 mb-3" data-testid="deals-error">
              {error}
            </p>
          )}
          {loadingList ? (
            <p className="text-sm text-gray-600" data-testid="deals-loading-list">
              Loading Deals…
            </p>
          ) : deals.length === 0 ? (
            <p className="text-sm text-gray-700" data-testid="deals-empty">
              No Deals yet for this Workspace.
            </p>
          ) : (
            <ul className="space-y-3" data-testid="deals-list">
              {deals.map((deal) => (
                <DealRow key={deal.dealId} deal={deal} />
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}

/**
 * One Deal row.
 *
 * The whole row is a link to the existing `/deals/:dealId` page. The
 * Deal id appears only as a data attribute — never as the primary
 * user-facing text (ticket #74; QA finding P3-002).
 *
 * Deliberately NOT exported: a Next.js page module may only export
 * the default component and the framework's own route config fields.
 * The row's testable logic lives in the pure helpers in
 * `./deal-list-copy.ts`, which are unit-tested directly.
 */
function DealRow({ deal }: { readonly deal: DealListItemPublicV1 }) {
  const fundingLabel = describeFundingStatus(deal.fundingStatus);

  return (
    <li
      className="border border-gray-200 rounded-md hover:border-blue-400 transition-colors"
      data-testid="deal-row"
      data-deal-id={deal.dealId}
    >
      <Link
        href={`/deals/${deal.dealId}`}
        className="block p-3 space-y-1"
        data-testid="deal-row-link"
      >
        <p className="text-sm font-medium text-gray-900 break-words" data-testid="deal-row-title">
          {describeDealTitle(deal)}
        </p>
        <p className="text-xs text-gray-700 break-words" data-testid="deal-row-counterparty">
          {describeCounterparty(deal)}
        </p>
        <p className="text-xs text-gray-600" data-testid="deal-row-status">
          {buildDealStatusLine(deal)}
        </p>
        {fundingLabel !== null && (
          <p className="text-xs text-gray-600" data-testid="deal-row-funding">
            {fundingLabel}
          </p>
        )}
        <p className="text-xs text-gray-500" data-testid="deal-row-meta">
          {describeActingSide(deal.actingSide)} · Started {formatDealDate(deal.createdAt)}
        </p>
      </Link>
    </li>
  );
}
