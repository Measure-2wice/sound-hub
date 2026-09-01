"use client";

// Matchmaker page.
//
// Background: BG3 ships the buyer-side Matchmaker vertical slice;
// BG4 extends it with the buyer-side invitation step that converts
// a recommendation into a persisted ProjectRequest. The page
// accepts a natural-language ProjectBrief, submits it to
// `/api/matchmaker/brief`, and renders the resulting brief +
// recommendations. After the brief persists, the buyer can select
// an eligibility-determined recommendation and POST it to
// `/api/project-requests` to persist a Pending ProjectRequest. The
// page reuses the BG1 session seam (`useSession`) so the user must
// be signed in to submit a brief or invite a seller, and it
// requires an explicit acting Workspace so the GS 4 / GS 5
// authority contract is preserved end to end.
//
// The recommendations rendered here come from real PostgreSQL
// eligibility + deterministic ranking through the existing
// TalentSearchService. The page never invents seller facts or
// AI-generated explanations; every explanation entry maps to one
// of the allow-listed kinds and is assembled by the API layer
// from the persisted search result.

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type {
  CategoryMetadataItemV1,
  MatchmakerRecommendationV1,
  SubmitBriefResponseV1,
} from "@soundhub/types";
import { categoryMetadataResponseV1Schema } from "@soundhub/types";
import { useSession } from "../components/SessionProvider";
import { submitBriefFromForm } from "./submit-brief-from-form";
import { inviteFromRecommendation } from "./invite-from-recommendation";
import { BriefSummary } from "./brief-summary";
import { Card } from "../components/ui/Card";

const DEFAULT_BRIEF =
  "I need a Brooklyn-based producer for a remote Haitian dancehall single, ideally delivered before March 14.";

export default function MatchmakerPage() {
  const { user, loading, refresh } = useSession();
  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [briefText, setBriefText] = useState<string>(DEFAULT_BRIEF);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SubmitBriefResponseV1 | null>(null);
  // BG4 invitation state. One row per recommendation; the page
  // tracks the submitting / success / error state for the most
  // recent click so the buyer can see what happened after the
  // request is persisted.
  const [invitingRecommendationId, setInvitingRecommendationId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  // Canonical categories fetched from the public metadata seam so
  // the brief summary's chip renderer never holds a second,
  // independently deployable list of category keys. PostgreSQL is
  // the source of truth (Codex P2-001).
  const [categories, setCategories] = useState<readonly CategoryMetadataItemV1[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fetchResponse = await fetch("/api/metadata/categories", {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (!fetchResponse.ok) {
          throw new Error(`Metadata request failed (${fetchResponse.status}).`);
        }
        const body: unknown = await fetchResponse.json();
        const parsed = categoryMetadataResponseV1Schema.safeParse(body);
        if (!parsed.success) {
          throw new Error("Metadata response does not match the shared category schema.");
        }
        if (cancelled) return;
        setCategories(parsed.data.categories);
      } catch {
        // Categories are a presentation aid. A failed metadata fetch
        // leaves the lookup map empty and the chip renderer falls
        // back to a humanised-key display so the buyer still sees
        // every axis.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="matchmaker-loading">
        <p className="text-gray-600">Loading Matchmaker…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12" data-testid="matchmaker-signed-out">
        <Card>
          <Card.Content>
            <p className="text-gray-700">
              You are not signed in.{" "}
              <Link
                href="/login"
                className="text-blue-600 hover:text-blue-700 font-medium"
                data-testid="matchmaker-sign-in-link"
              >
                Sign in
              </Link>{" "}
              to submit a ProjectBrief.
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  const buyerWorkspaces = user.workspaces.filter((w) => w.capabilities.includes("Buyer"));

  // The page's onSubmit delegates to the extracted test seam so
  // the focused UI test can exercise the runtime wiring
  // (workspace + brief payload + response state + error
  // rendering + submitting flag) with a controlled fetch.
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await submitBriefFromForm({
      actingWorkspaceId,
      briefText,
      setError,
      setResponse,
      setSubmitting,
      // SESSION_INVALID / AUTH_FAILED / SESSION_EXPIRED responses
      // mean the shared session cookie is no longer valid (the user
      // may have signed out in another tab, or the cookie expired).
      // Refresh the BG1 SessionProvider so the header email,
      // workspace list, and Matchmaker page converge on the
      // signed-out state without a manual reload.
      onSessionInvalid: () => {
        void refresh();
      },
    });
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-6" data-testid="matchmaker-page">
      <Card data-testid="matchmaker-brief-card">
        <Card.Header>
          <Card.Title>Submit a ProjectBrief</Card.Title>
          <Card.Description>
            Describe your creative need in natural language. SoundHub interprets your brief into
            validated search criteria, runs the Matchmaker against the existing PostgreSQL talent
            graph, and shows you the results that match.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {buyerWorkspaces.length === 0 ? (
            <p className="text-sm text-red-700" data-testid="matchmaker-no-buyer-workspace">
              Your account does not currently belong to a Buyer-capable Workspace. Sign in with a
              Workspace that has the Buyer capability.
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                handleSubmit(e).catch(() => {
                  /* surfaced via setError above */
                });
              }}
              className="space-y-4"
            >
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-gray-900">Acting Workspace</legend>
                {buyerWorkspaces.map((workspace) => (
                  <label
                    key={workspace.workspaceId}
                    className={`flex items-start gap-3 border rounded-md p-3 cursor-pointer ${
                      actingWorkspaceId === workspace.workspaceId
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200"
                    }`}
                    data-testid="matchmaker-workspace-option"
                    data-workspace-id={workspace.workspaceId}
                  >
                    <input
                      type="radio"
                      name="actingWorkspaceId"
                      value={workspace.workspaceId}
                      checked={actingWorkspaceId === workspace.workspaceId}
                      onChange={() => setActingWorkspaceId(workspace.workspaceId)}
                      className="mt-1"
                      data-testid="matchmaker-workspace-radio"
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

              <label className="block space-y-1">
                <span className="text-sm font-medium text-gray-900">Creative brief</span>
                <textarea
                  value={briefText}
                  onChange={(e) => setBriefText(e.target.value)}
                  rows={5}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  data-testid="matchmaker-brief-textarea"
                />
              </label>

              <button
                type="submit"
                disabled={submitting}
                className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                data-testid="matchmaker-submit"
              >
                {submitting ? "Running Matchmaker…" : "Run Matchmaker"}
              </button>

              {error && (
                <p className="text-sm text-red-700" data-testid="matchmaker-error">
                  {error}
                </p>
              )}
            </form>
          )}
        </Card.Content>
      </Card>

      {response && (
        <BriefResults
          response={response}
          categories={categories}
          actingWorkspaceId={actingWorkspaceId}
          invitingRecommendationId={invitingRecommendationId}
          inviteError={inviteError}
          inviteSuccess={inviteSuccess}
          onInvite={(recommendation) => {
            setInvitingRecommendationId(recommendation.bestMatchingOffering.offeringId);
            void inviteFromRecommendation({
              actingWorkspaceId,
              briefId: response.brief.briefId,
              recommendation,
              setError: setInviteError,
              setSuccess: setInviteSuccess,
              setSubmitting: (value) => {
                setInvitingRecommendationId(
                  value ? recommendation.bestMatchingOffering.offeringId : null,
                );
              },
              onSessionInvalid: () => {
                void refresh();
              },
            });
          }}
        />
      )}
    </div>
  );
}

function BriefResults({
  response,
  categories,
  actingWorkspaceId,
  invitingRecommendationId,
  inviteError,
  inviteSuccess,
  onInvite,
}: {
  readonly response: SubmitBriefResponseV1;
  readonly categories: readonly CategoryMetadataItemV1[];
  readonly actingWorkspaceId: string;
  readonly invitingRecommendationId: string | null;
  readonly inviteError: string | null;
  readonly inviteSuccess: string | null;
  readonly onInvite: (recommendation: MatchmakerRecommendationV1) => void;
}) {
  return (
    <>
      <Card data-testid="matchmaker-brief-summary">
        <Card.Header>
          <Card.Title>Brief accepted</Card.Title>
          <Card.Description>
            Persisted as Workspace-owned ProjectBrief{" "}
            <code className="bg-gray-100 px-1 rounded">{response.brief.briefId}</code> with{" "}
            {response.totalResults} eligible recommendation
            {response.totalResults === 1 ? "" : "s"}.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <BriefSummary brief={response.brief} categories={categories} />
          {response.fallbackNotice && (
            <p className="mt-3 text-sm text-amber-700" data-testid="matchmaker-fallback-notice">
              {response.fallbackNotice}
            </p>
          )}
          {inviteError && (
            <p className="mt-3 text-sm text-red-700" data-testid="matchmaker-invite-error">
              {inviteError}
            </p>
          )}
          {inviteSuccess && (
            <p className="mt-3 text-sm text-green-700" data-testid="matchmaker-invite-success">
              {inviteSuccess}
            </p>
          )}
        </Card.Content>
      </Card>

      <Card data-testid="matchmaker-recommendations">
        <Card.Header>
          <Card.Title>Recommendations</Card.Title>
          <Card.Description>
            Every recommendation references an eligible seller and ServiceOffering from PostgreSQL.
            Select one to send a Pending ProjectRequest to the seller; the API revalidates current
            eligibility before persistence.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {response.recommendations.length === 0 ? (
            <p className="text-sm text-gray-700" data-testid="matchmaker-no-recommendations">
              No eligible sellers matched the brief.
            </p>
          ) : (
            <ul className="space-y-4" data-testid="matchmaker-recommendation-list">
              {response.recommendations.map((rec, index) => (
                <RecommendationItem
                  key={rec.bestMatchingOfferingId}
                  recommendation={rec}
                  index={index + 1}
                  // Disable every invite button while any invite is in
 // flight so a buyer cannot fire concurrent ProjectRequest writes
 // against the same brief. The in-flight row still renders the
 // "Inviting…" label so the buyer can see which row is in flight.
                  disabled={!actingWorkspaceId || invitingRecommendationId !== null}
                  submitting={invitingRecommendationId === rec.bestMatchingOffering.offeringId}
                  onInvite={() => onInvite(rec)}
                />
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>
    </>
  );
}

function RecommendationItem({
  recommendation,
  index,
  disabled,
  submitting,
  onInvite,
}: {
  readonly recommendation: MatchmakerRecommendationV1;
  readonly index: number;
  readonly disabled: boolean;
  readonly submitting: boolean;
  readonly onInvite: () => void;
}) {
  return (
    <li
      className="border border-gray-200 rounded-md p-3 space-y-2"
      data-testid="matchmaker-recommendation-item"
      data-recommendation-index={index}
      data-recommendation-id={recommendation.bestMatchingOffering.offeringId}
    >
      <div>
        <p className="text-sm font-medium text-gray-900">
          #{index} {recommendation.professionalName} — {recommendation.bestMatchingOffering.title}
        </p>
        <p className="text-xs text-gray-600">
          {recommendation.bestMatchingOffering.primaryCategory.name} ·{" "}
          {recommendation.bestMatchingOffering.serviceMode} · based in{" "}
          {recommendation.seller.basedIn.countryCode}
          {recommendation.seller.basedIn.city ? `, ${recommendation.seller.basedIn.city}` : ""}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-700">Factual match evidence</p>
        <ul
          className="list-disc list-inside text-xs text-gray-700"
          data-testid="matchmaker-explanation-list"
        >
          {recommendation.explanations.map((entry, i) => (
            <li
              key={`${entry.kind}-${i}`}
              data-testid="matchmaker-explanation-item"
              data-explanation-kind={entry.kind}
            >
              {entry.label}
            </li>
          ))}
        </ul>
        <p className="text-xs text-gray-700 mt-1" data-testid="matchmaker-match-reason">
          {recommendation.matchReason}
        </p>
      </div>
      <div>
        <button
          type="button"
          onClick={onInvite}
          disabled={disabled || submitting}
          className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          data-testid="matchmaker-invite-button"
          data-offering-id={recommendation.bestMatchingOffering.offeringId}
        >
          {submitting ? "Inviting…" : "Select & invite"}
        </button>
      </div>
    </li>
  );
}
