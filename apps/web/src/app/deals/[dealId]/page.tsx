"use client";

// Deal page (BG5).
//
// Background: ticket #63 requires the buyer + seller surfaces for
// reviewing the current TermsVersion, approving it, and reading the
// deal state. The page reuses the BG1 SessionProvider so the same
// session refresh hooks keep the deal consistent across sign-in /
// sign-out in other tabs.
//
// Per ticket #63 + the locked plan:
//   - Renders the Deal metadata + current TermsVersion.
//   - The "AI-drafted · unapproved" badge is driven by the
//     `aiDraftedUnapprovedBadge: true` literal on the public DTO so
//     the UI cannot silently drop it.
//   - The funding deadline is displayed only; passage carries no
//     Golden Slice state effect.
//   - Approval forms are capability-gated: buyer Workspace for
//     buyer-side approval, seller Workspace for seller-side
//     approval. The application policy revalidates the explicit
//     DealApprover authorization server-side; the UI does NOT make
//     the authorization decision.
//   - No Navigation destination. The existing workflow links to
//     /deals/:dealId directly.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  Bg5DealApprovalPublicV1,
  Bg5TermsVersionPublicV1,
  DealPublicV1,
  MarketplaceCapabilityV1,
} from "@soundhub/types";
import { useSession } from "../../components/SessionProvider";
import { Card } from "../../components/ui/Card";
import {
  approveTerms,
  draftTerms,
  fetchDeal,
} from "../../lib/deal-terms-client";

interface DealPageProps {
  // Next.js 15's `PageProps.params` is a Promise; await it in the
  // client component to keep the route type-compatible.
  readonly params: Promise<{ readonly dealId: string }>;
}

export default function DealPage({ params }: DealPageProps): JSX.Element {
  const [resolvedDealId, setResolvedDealId] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void params.then((p) => {
      if (!cancelled) setResolvedDealId(p.dealId);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);
  const dealId = resolvedDealId;
  const { user, loading, refresh } = useSession();
  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [deal, setDeal] = useState<DealPublicV1 | null>(null);
  const [currentTermsVersion, setCurrentTermsVersion] = useState<Bg5TermsVersionPublicV1 | null>(
    null,
  );
  const [currentApprovals, setCurrentApprovals] = useState<readonly Bg5DealApprovalPublicV1[]>([]);
  const [loadingDeal, setLoadingDeal] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<"draft" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const candidateWorkspaces = useMemo(() => {
    if (!deal) return [] as const;
    const ids = new Set<string>([deal.buyerWorkspaceId, deal.sellerWorkspaceId]);
    return user?.workspaces.filter((w) => ids.has(w.workspaceId)) ?? [];
  }, [user, deal]);

  const reload = useCallback(
    async (workspaceId: string) => {
      if (!workspaceId) {
        setDeal(null);
        setCurrentTermsVersion(null);
        setCurrentApprovals([]);
        return;
      }
      setLoadingDeal(true);
      setError(null);
      try {
        const result = await fetchDeal(dealId, workspaceId);
        setDeal(result.deal.deal);
        setCurrentTermsVersion(result.deal.currentTermsVersion);
        setCurrentApprovals(result.deal.currentApprovals);
      } catch (err) {
        if (
          err instanceof Error &&
          ((err as { code?: string }).code === "SESSION_INVALID" ||
            (err as { code?: string }).code === "AUTH_FAILED" ||
            (err as { code?: string }).code === "SESSION_EXPIRED")
        ) {
          void refresh();
          return;
        }
        setError(err instanceof Error ? err.message : "Could not load the Deal.");
      } finally {
        setLoadingDeal(false);
      }
    },
    [dealId, refresh],
  );

  useEffect(() => {
    if (candidateWorkspaces.length === 0) {
      setDeal(null);
      setCurrentTermsVersion(null);
      setCurrentApprovals([]);
      return;
    }
    if (
      !actingWorkspaceId ||
      !candidateWorkspaces.some((w) => w.workspaceId === actingWorkspaceId)
    ) {
      setActingWorkspaceId(candidateWorkspaces[0]!.workspaceId);
    }
  }, [candidateWorkspaces, actingWorkspaceId]);

  useEffect(() => {
    void reload(actingWorkspaceId);
  }, [actingWorkspaceId, reload]);

  const onDraft = useCallback(async () => {
    if (!actingWorkspaceId) return;
    setSubmitting("draft");
    setError(null);
    setSuccess(null);
    try {
      const result = await draftTerms(dealId, { actingWorkspaceId });
      setSuccess(`Drafted TermsVersion ${result.termsVersion.version}.`);
      await reload(actingWorkspaceId);
    } catch (err) {
      if (
        err instanceof Error &&
        ((err as { code?: string }).code === "SESSION_INVALID" ||
          (err as { code?: string }).code === "AUTH_FAILED" ||
          (err as { code?: string }).code === "SESSION_EXPIRED")
      ) {
        void refresh();
      } else {
        setError(err instanceof Error ? err.message : "Could not draft terms.");
      }
    } finally {
      setSubmitting(null);
    }
  }, [actingWorkspaceId, dealId, reload, refresh]);

  const onApprove = useCallback(async () => {
    if (!actingWorkspaceId || !currentTermsVersion) return;
    setSubmitting("approve");
    setError(null);
    setSuccess(null);
    try {
      const result = await approveTerms(dealId, {
        actingWorkspaceId,
        termsVersionId: currentTermsVersion.termsVersionId,
      });
      setSuccess(
        `Approved — Workspace ${result.approval.workspaceId} on TermsVersion ${currentTermsVersion.version}.`,
      );
      await reload(actingWorkspaceId);
    } catch (err) {
      if (
        err instanceof Error &&
        ((err as { code?: string }).code === "SESSION_INVALID" ||
          (err as { code?: string }).code === "AUTH_FAILED" ||
          (err as { code?: string }).code === "SESSION_EXPIRED")
      ) {
        void refresh();
      } else {
        setError(err instanceof Error ? err.message : "Could not approve terms.");
      }
    } finally {
      setSubmitting(null);
    }
  }, [actingWorkspaceId, currentTermsVersion, dealId, reload, refresh]);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="deal-loading">
        <p className="text-gray-600">Loading Deal…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="deal-signed-out">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You are not signed in.{" "}
              <Link
                href="/login"
                className="text-blue-600 hover:text-blue-700 font-medium"
                data-testid="deal-sign-in-link"
              >
                Sign in
              </Link>{" "}
              to view this Deal.
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 space-y-4" data-testid="deal-empty">
        <Card>
          <Card.Header>
            <Card.Title>Deal not visible</Card.Title>
            <Card.Description>
              Either the Deal does not exist or your account is not a current member of one of its
              buyer / seller Workspaces.
            </Card.Description>
          </Card.Header>
        </Card>
      </div>
    );
  }

  const isBuyerSide = actingWorkspaceId === deal.buyerWorkspaceId;
  const isSellerSide = actingWorkspaceId === deal.sellerWorkspaceId;
  const capabilityRequired: MarketplaceCapabilityV1 | null = isBuyerSide
    ? "Buyer"
    : isSellerSide
    ? "Seller"
    : null;
  const alreadyApproved =
    currentTermsVersion !== null &&
    currentApprovals.some((a) => a.workspaceId === actingWorkspaceId);
  const showApprove =
    capabilityRequired !== null &&
    currentTermsVersion !== null &&
    !alreadyApproved &&
    currentTermsVersion.isCurrentVersion;

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-6" data-testid="deal-page">
      <Card data-testid="deal-header">
        <Card.Header>
          <Card.Title>Deal {deal.dealId}</Card.Title>
          <Card.Description>
            Status: {deal.status}. Project request {deal.projectRequestId} originated this Deal.
          </Card.Description>
        </Card.Header>
      </Card>

      <Card data-testid="deal-workspace-card">
        <Card.Header>
          <Card.Title>Acting Workspace</Card.Title>
          <Card.Description>
            Pick one of the Deal's Workspaces to act as. Each side sees the same TermsVersion; the
            approval forms below are capability-gated.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {candidateWorkspaces.length === 0 ? (
            <p className="text-sm text-red-700" data-testid="deal-no-acting-workspace">
              Your account is not a current member of this Deal's buyer or seller Workspace.
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-gray-900">Acting Workspace</legend>
              {candidateWorkspaces.map((workspace) => {
                const side = workspace.workspaceId === deal.buyerWorkspaceId ? "Buyer" : "Seller";
                return (
                  <label
                    key={workspace.workspaceId}
                    className={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
                      actingWorkspaceId === workspace.workspaceId
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200"
                    }`}
                    data-testid="deal-workspace-option"
                    data-workspace-id={workspace.workspaceId}
                    data-side={side}
                  >
                    <input
                      type="radio"
                      name="actingWorkspaceId"
                      value={workspace.workspaceId}
                      checked={actingWorkspaceId === workspace.workspaceId}
                      onChange={() => setActingWorkspaceId(workspace.workspaceId)}
                      className="mt-1"
                      data-testid="deal-workspace-radio"
                    />
                    <span>
                      <span className="block text-sm font-medium text-gray-900">
                        {workspace.name} ({side})
                      </span>
                      <span className="block text-xs text-gray-500">
                        {workspace.workspaceType} · {workspace.workspaceStatus}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}
        </Card.Content>
      </Card>

      <Card data-testid="deal-terms-card">
        <Card.Header>
          <Card.Title>Current TermsVersion</Card.Title>
          <Card.Description>
            The TermsVersion below is the proposal both parties must independently approve.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {error && (
            <p className="text-sm text-red-700 mb-3" data-testid="deal-error">
              {error}
            </p>
          )}
          {success && (
            <p className="text-sm text-green-700 mb-3" data-testid="deal-success">
              {success}
            </p>
          )}
          {loadingDeal ? (
            <p className="text-sm text-gray-600" data-testid="deal-loading-list">
              Loading…
            </p>
          ) : currentTermsVersion ? (
            <TermsVersionView
              tv={currentTermsVersion}
              approvals={currentApprovals}
              onDraft={() => {
                void onDraft();
              }}
              onApprove={() => {
                void onApprove();
              }}
              submitting={submitting}
              showDraftButton={capabilityRequired !== null}
              showApproveButton={showApprove}
            />
          ) : (
            <div className="space-y-3" data-testid="deal-no-terms">
              <p className="text-sm text-gray-700">
                No TermsVersion has been drafted for this Deal yet.
              </p>
              {capabilityRequired !== null && (
                <button
                  type="button"
                  onClick={() => {
                    void onDraft();
                  }}
                  disabled={submitting !== null}
                  className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  data-testid="deal-draft-button"
                >
                  {submitting === "draft" ? "Drafting…" : "Draft TermsVersion"}
                </button>
              )}
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}

function TermsVersionView({
  tv,
  approvals,
  onDraft,
  onApprove,
  submitting,
  showDraftButton,
  showApproveButton,
}: {
  readonly tv: Bg5TermsVersionPublicV1;
  readonly approvals: readonly Bg5DealApprovalPublicV1[];
  readonly onDraft: () => void;
  readonly onApprove: () => void;
  readonly submitting: "draft" | "approve" | null;
  readonly showDraftButton: boolean;
  readonly showApproveButton: boolean;
}): JSX.Element {
  return (
    <div className="space-y-4" data-testid="deal-terms-view">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-900" data-testid="deal-terms-version-label">
          TermsVersion {tv.version}
        </p>
        <span
          className="text-xs uppercase tracking-wide bg-amber-100 text-amber-800 px-2 py-1 rounded"
          data-testid="deal-terms-ai-badge"
        >
          AI-drafted · unapproved
        </span>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">Scope</p>
        <p className="text-sm text-gray-900 break-words" data-testid="deal-terms-scope">
          {tv.scope}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">Deliverables</p>
        <ul className="text-sm text-gray-900 list-disc pl-5" data-testid="deal-terms-deliverables">
          {tv.deliverables.map((d, idx) => (
            <li key={idx} data-testid="deal-terms-deliverable">
              <strong>{d.title}</strong> — {d.description}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase">Schedule</p>
          <p data-testid="deal-terms-schedule">
            {tv.schedule.startDate} → {tv.schedule.endDate} ({tv.schedule.deliveryDays} days)
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase">Price (USD)</p>
          <p data-testid="deal-terms-price">
            {(tv.price.amountMinor / 100).toFixed(2)} {tv.price.currency}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase">Revision allowance</p>
          <p data-testid="deal-terms-revision">{tv.revisionAllowance}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase">Funding deadline</p>
          <p className="text-xs text-gray-500" data-testid="deal-terms-funding-deadline">
            {tv.fundingDeadlineAt
              ? `${formatDatetime(tv.fundingDeadlineAt)} (display only — no Golden Slice state effect)`
              : "Not set"}
          </p>
        </div>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">Rights summary</p>
        <p className="text-sm text-gray-900 break-words" data-testid="deal-terms-rights">
          {tv.rightsSummary}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase">Recorded approvals</p>
        {approvals.length === 0 ? (
          <p className="text-sm text-gray-700" data-testid="deal-no-approvals">
            Neither side has approved this TermsVersion yet.
          </p>
        ) : (
          <ul className="text-sm text-gray-900" data-testid="deal-approvals">
            {approvals.map((a) => (
              <li key={a.dealApprovalId} data-testid="deal-approval">
                Workspace {a.workspaceId} approved at {formatDatetime(a.approvedAt)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {showDraftButton && (
          <button
            type="button"
            onClick={() => {
              void onDraft();
            }}
            disabled={submitting !== null}
            className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            data-testid="deal-redraft-button"
          >
            {submitting === "draft" ? "Drafting…" : "Draft replacement TermsVersion"}
          </button>
        )}
        {showApproveButton && (
          <button
            type="button"
            onClick={() => {
              void onApprove();
            }}
            disabled={submitting !== null}
            className="bg-green-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition-colors"
            data-testid="deal-approve-button"
          >
            {submitting === "approve" ? "Approving…" : "Approve this TermsVersion"}
          </button>
        )}
      </div>
    </div>
  );
}

function formatDatetime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}