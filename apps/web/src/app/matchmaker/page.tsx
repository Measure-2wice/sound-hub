"use client";

// Matchmaker page.
//
// Background: BG3 ships the buyer-side Matchmaker vertical slice.
// The page accepts a natural-language ProjectBrief, submits it to
// `/api/matchmaker/brief`, and renders the resulting brief +
// recommendations. The page reuses the BG1 session seam
// (`useSession`) so the user must be signed in to submit a brief,
// and it requires an explicit acting Workspace so the GS 4 / GS 5
// authority contract is preserved end to end.
//
// The recommendations rendered here come from real PostgreSQL
// eligibility + deterministic ranking through the existing
// TalentSearchService. The page never invents seller facts or
// AI-generated explanations; every explanation entry maps to one
// of the allow-listed kinds and is assembled by the API layer
// from the persisted search result.

import { useState, type FormEvent } from "react";
import Link from "next/link";
import type {
  ProjectBriefPublicV1,
  MatchmakerRecommendationV1,
  SubmitBriefResponseV1,
} from "@soundhub/types";
import { useSession } from "../components/SessionProvider";
import { submitBriefFromForm } from "./submit-brief-from-form";
import { Card } from "../components/ui/Card";

const DEFAULT_BRIEF =
  "I need a Brooklyn-based producer for a remote Haitian dancehall single, ideally delivered before March 14.";

export default function MatchmakerPage() {
  const { user, loading } = useSession();
  const [actingWorkspaceId, setActingWorkspaceId] = useState<string>("");
  const [briefText, setBriefText] = useState<string>(DEFAULT_BRIEF);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<SubmitBriefResponseV1 | null>(null);

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

      {response && <BriefResults response={response} />}
    </div>
  );
}

function BriefResults({ response }: { readonly response: SubmitBriefResponseV1 }) {
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
          <BriefSummary brief={response.brief} />
          {response.fallbackNotice && (
            <p className="mt-3 text-sm text-amber-700" data-testid="matchmaker-fallback-notice">
              {response.fallbackNotice}
            </p>
          )}
        </Card.Content>
      </Card>

      <Card data-testid="matchmaker-recommendations">
        <Card.Header>
          <Card.Title>Recommendations</Card.Title>
          <Card.Description>
            Every recommendation references an eligible seller and ServiceOffering from PostgreSQL.
            Explanations are factual match evidence derived from the search result; no AI-generated
            text crosses the response boundary.
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
                />
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>
    </>
  );
}

function BriefSummary({ brief }: { readonly brief: ProjectBriefPublicV1 }) {
  return (
    <dl className="grid grid-cols-1 gap-y-2 text-sm" data-testid="matchmaker-brief-summary-list">
      <div>
        <dt className="font-medium text-gray-700">Original brief</dt>
        <dd className="text-gray-900">{brief.briefText}</dd>
      </div>
      <div>
        <dt className="font-medium text-gray-700">Required criteria</dt>
        <dd>
          <code className="text-xs bg-gray-100 px-1 rounded whitespace-pre-wrap break-words">
            {JSON.stringify(brief.criteria.required)}
          </code>
        </dd>
      </div>
      {brief.criteria.preferred && (
        <div>
          <dt className="font-medium text-gray-700">Preferred criteria</dt>
          <dd>
            <code className="text-xs bg-gray-100 px-1 rounded whitespace-pre-wrap break-words">
              {JSON.stringify(brief.criteria.preferred)}
            </code>
          </dd>
        </div>
      )}
      {brief.criteria.query && (
        <div>
          <dt className="font-medium text-gray-700">Normalized query</dt>
          <dd>
            <code className="text-xs bg-gray-100 px-1 rounded">{brief.criteria.query}</code>
          </dd>
        </div>
      )}
      <div>
        <dt className="font-medium text-gray-700">Provenance</dt>
        <dd>
          <span className="text-xs text-gray-700">
            Provider: {brief.aiProvider}
            {brief.aiModelId ? ` (model: ${brief.aiModelId})` : ""}
            {" · "}
            Fallback: {brief.aiFallbackUsed ? "yes" : "no"}
          </span>
        </dd>
      </div>
    </dl>
  );
}

function RecommendationItem({
  recommendation,
  index,
}: {
  readonly recommendation: MatchmakerRecommendationV1;
  readonly index: number;
}) {
  return (
    <li
      className="border border-gray-200 rounded-md p-3 space-y-2"
      data-testid="matchmaker-recommendation-item"
      data-recommendation-index={index}
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
    </li>
  );
}
