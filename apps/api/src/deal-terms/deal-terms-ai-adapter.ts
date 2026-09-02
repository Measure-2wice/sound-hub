// DealTermsAiAdapter — provider-neutral AI boundary for TermsVersion drafting (BG5).
//
// Background: ticket #63 requires that AI may draft proposed terms
// only for a Negotiating Deal. The draft must be strictly validated
// at the application boundary before any TermsVersion row is
// persisted. Per the Golden Slice spec the draft is visibly labeled
// as AI-drafted and unapproved; AI output never synthesizes approval.
//
// This module ships the minimum interface the application layer needs
// plus a deterministic fallback implementation. No managed provider
// integration is added in BG5 (per ticket #63: "Keep the AI boundary
// minimal. Preserve a provider-neutral DealTermsAiAdapter, but
// deterministic fallback is sufficient for BG5 unless an existing
// managed adapter can be reused with essentially no additional
// architecture."). The factory follows the BG3 pattern — adding a
// managed adapter later requires no changes to the application
// service.
//
// The adapter output is the candidate proposal (NOT yet validated) +
// provenance metadata. The application service parses the candidate
// through `bg5ProposedTermsV1Schema` and rejects any adapter that
// returns malformed output. AI output never crosses the boundary
// untyped.

import type {
  Bg5ProposedTermsV1,
  DealTermsAiDraftInputV1,
  DealTermsAiDraftOutputV1,
} from "@soundhub/types";

export interface DealTermsAiAdapter {
  readonly key: string;
  /**
   * Provider-neutral draft entry point. The application supplies the
   * strict input shape; the adapter returns the strict output shape.
   * Adapters MUST NOT throw on transient failure; they MUST return a
   * well-formed output whose `candidate` field can be validated (and
   * fall back to deterministic re-derivation if it cannot be).
   */
  draftProposedTerms(input: DealTermsAiDraftInputV1): Promise<DealTermsAiDraftOutputV1>;
}

/**
 * Deterministic fallback adapter.
 *
 * Maps the (Deal, ProjectBrief, ServiceOffering) context to a stable,
 * reasonable proposal that the application can persist. The output is
 * deterministic so the buildathon journey is reproducible end to end
 * without managed-AI dependency.
 *
 * The application service is responsible for validating the
 * `candidate` field against `bg5ProposedTermsV1Schema`; the adapter
 * returns the same shape the managed adapter would. The deterministic
 * shape is intentionally simple — it satisfies GS 19–21 (AI-drafted
 * structured TermsVersion, visibly labeled as unapproved) without
 * requiring a managed LLM call.
 */
export class DeterministicDealTermsAiAdapter implements DealTermsAiAdapter {
  readonly key = "deterministic-fallback";

  draftProposedTerms(input: DealTermsAiDraftInputV1): Promise<DealTermsAiDraftOutputV1> {
    const candidate: Bg5ProposedTermsV1 = {
      scope: buildScope(input),
      deliverables: buildDeliverables(input),
      schedule: buildSchedule(),
      // USD-only for BG5. The Golden Slice spec fixes currency at USD.
      price: { amountMinor: 75000, currency },
      revisionAllowance: 1,
      rightsSummary:
        "Buyer receives non-exclusive worldwide rights to use the commissioned work " +
        "for the original brief's stated purpose; seller retains ownership of the " +
        "underlying composition and may reuse non-confidential elements.",
      fundingDeadlineAt: undefined,
    };
    return Promise.resolve({
      provider: "deterministic-fallback",
      modelId: null,
      candidate,
    });
  }
}

function buildScope(input: DealTermsAiDraftInputV1): string {
  return (
    "Produce the commissioned work described in ProjectBrief " +
    input.projectBriefId +
    " for buyer Workspace " +
    input.buyerWorkspaceId +
    " via seller Workspace " +
    input.sellerWorkspaceId +
    " under ServiceOffering " +
    input.serviceOfferingId +
    ". Scope, deliverables, schedule, revisions, rights, and price below."
  );
}

function buildDeliverables(input: DealTermsAiDraftInputV1): Bg5ProposedTermsV1["deliverables"] {
  return [
    {
      title: "Primary deliverable",
      description:
        "One final mix-ready or master-ready file (or live performance) per the " +
        "ServiceOffering " +
        input.serviceOfferingId +
        " selected for this Deal.",
    },
    {
      title: "Stems",
      description:
        "When the offering is a recording, all production stems rendered to WAV " +
        "and delivered alongside the primary file.",
    },
  ];
}

function buildSchedule(): Bg5ProposedTermsV1["schedule"] {
  // Deterministic 21-day schedule, well within the 1..365 bound.
  const today = new Date("2026-01-01T00:00:00.000Z");
  const start = new Date(today);
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 21);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    deliveryDays: 21,
  };
}

const currency = "USD";
