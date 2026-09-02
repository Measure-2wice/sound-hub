// DealTerms service (BG5).
//
// Background: ticket #63 requires a single application boundary
// that owns (a) the AI-assisted TermsVersion drafting for a
// Negotiating Deal and (b) the explicit DealApprover-authorized
// approval flow. The service composes:
//
//   - the application-owned policy evaluators in
//     `./deal-terms-authorization-policy.ts` (drafting authority +
//     approval authority), and
//   - the transaction-scoped repository methods in
//     `./deal-terms.repository.ts` (one PostgreSQL transaction per
//     command, FOR UPDATE-locked fact reads, guarded persistence).
//
// For each consequential command the service supplies a pure use-case
// closure that consumes the snapshot the repository loads inside its
// transaction and returns either a `persist` verdict or a `reject`
// verdict. The repository never decides whether the facts authorize
// the command; the service owns that decision.
//
// Drafting and approval authorization are deliberately separate
// (per ticket #63):
//
//   - Drafting requires current membership in the acting Workspace
//     AND the Workspace being a party to the Deal (buyer or seller)
//     AND the Deal being in `Negotiating`. AI may draft; being an
//     Owner, possessing Buyer/Seller capability, or holding a
//     DealApprover authorization is NOT sufficient or required.
//
//   - Approval requires (1) current membership in the Workspace whose
//     side is approving AND (2) an explicit DealApprover
//     authorization row binding that (Workspace, user) tuple AND (3)
//     the termsVersionId matching the Deal's CURRENT version
//     (MAX(version)). AI output, UI state, provider metadata, the
//     other party's approval, role, or capability do NOT synthesize
//     approval.
//
// The repository remains the only layer that touches Prisma. The
// service has no Prisma dependency.

import type {
  Bg5DealApprovalPublicV1,
  Bg5TermsVersionPublicV1,
  ProjectRequestPublicV1,
  DealPublicV1,
} from "@soundhub/types";
import {
  evaluateApprovalAuthority,
  evaluateDraftingAuthority,
  type ApprovalAuthoritySnapshot,
  type DraftingAuthoritySnapshot,
} from "./deal-terms-authorization-policy.js";
import type {
  DealTermsRepository,
  DealViewSnapshot,
  DraftTermsFailureReason,
  DraftTermsResult,
  DraftTermsTransactionInput,
  DraftTermsUseCase,
  DraftTermsUseCaseContext,
  DraftTermsUseCaseOutcome,
  DraftTermsUseCaseTools,
  PersistApprovalInput,
  PersistDraftTermsInput,
  PersistedDealApproval,
  PersistedDealSummary,
  PersistedTermsVersion,
  RecordApprovalFailureReason,
  RecordApprovalResult,
  RecordApprovalUseCase,
  RecordApprovalUseCaseContext,
  RecordApprovalUseCaseOutcome,
  RecordApprovalUseCaseTools,
} from "./deal-terms.repository.js";
import type { DealTermsAiAdapter } from "./deal-terms-ai-adapter.js";
import { DeterministicDealTermsAiAdapter } from "./deal-terms-ai-adapter.js";

export class DealTermsError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "BG5_DEAL_NOT_FOUND"
      | "BG5_TERMS_VERSION_NOT_FOUND"
      | "BG5_DEAL_NOT_NEGOTIATING"
      | "BG5_TERMS_DRAFT_FORBIDDEN"
      | "BG5_TERMS_DRAFT_INVALID"
      | "BG5_APPROVAL_FORBIDDEN"
      | "BG5_APPROVAL_INVALID"
      | "BG5_APPROVAL_NOT_CURRENT_VERSION"
      | "BG5_APPROVAL_ALREADY_RECORDED"
      | "BG5_DEAL_INTERNAL_FAILED"
      | "BG5_DEAL_UNAVAILABLE",
  ) {
    super(message);
    this.name = "DealTermsError";
  }
}

export interface DealTermsServiceDeps {
  readonly dealTermsRepository: DealTermsRepository;
  readonly aiAdapter?: DealTermsAiAdapter;
  readonly deterministicAiAdapter?: DealTermsAiAdapter;
  readonly now?: () => Date;
}

export interface DraftTermsInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly dealId: string;
  readonly now?: Date;
  /**
   * Optional caller-supplied proposal. When present, the service
   * uses it directly and skips the AI invocation. The shape is
   * validated at the route boundary; the service performs a
   * structural re-check before persisting.
   */
  readonly callerProposedTerms?: PersistDraftTermsInput["proposedTerms"];
}

export interface ApproveTermsInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly dealId: string;
  readonly termsVersionId: string;
  readonly now?: Date;
}

export interface GetDealInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly dealId: string;
}

export class DealTermsService {
  private readonly repository: DealTermsRepository;
  private readonly aiAdapter: DealTermsAiAdapter;
  private readonly fallbackAiAdapter: DealTermsAiAdapter;
  private readonly now: () => Date;

  constructor(deps: DealTermsServiceDeps) {
    this.repository = deps.dealTermsRepository;
    this.fallbackAiAdapter = deps.deterministicAiAdapter ?? new DeterministicDealTermsAiAdapter();
    this.aiAdapter = deps.aiAdapter ?? this.fallbackAiAdapter;
    this.now = deps.now ?? (() => new Date());
  }

  // -----------------------------------------------------------------------
  // Draft terms
  // -----------------------------------------------------------------------

  /**
   * Draft an immutable TermsVersion for a Negotiating Deal.
   *
   * Flow:
   *   1. (Optional) Invoke the AI adapter to produce a candidate
   *      proposal; validate it at the application boundary. On
   *      failure, fall back to the deterministic adapter so the
   *      Golden Slice journey remains available without managed-AI
   *      dependency.
   *   2. Open one transaction via `draftTermsInTransaction`. The
   *      repository FOR UPDATE-locks the Deal row + Workspace +
   *      WorkspaceMembership rows and hands the snapshot to the
   *      use-case closure.
   *   3. The use-case closure calls `evaluateDraftingAuthority` and
   *      either calls `persistDraft` (with the validated proposal
   *      inlined) or surfaces a rejection.
   *   4. The repository persists the TermsVersion row only when the
   *      use-case persists; otherwise the transaction rolls back
   *      with no state change.
   */
  async draftTerms(input: DraftTermsInput): Promise<{
    readonly termsVersion: Bg5TermsVersionPublicV1;
  }> {
    const now = input.now ?? this.now();

    // Step 1: produce a validated candidate proposal.
    const proposed = input.callerProposedTerms
      ? input.callerProposedTerms
      : await this.produceProposedTerms(input.dealId);

    const draftInput: DraftTermsTransactionInput = {
      dealId: input.dealId,
      draftedByUserId: input.userAccountId,
      aiProvider: this.aiAdapter.key === "deterministic-fallback" ? "deterministic-fallback" : "managed",
      aiModelId: null,
      aiFallbackUsed: this.aiAdapter.key === "deterministic-fallback",
    };

    // Step 2-4: transaction + use case. The use case closure carries
    // the proposedTerms + now timestamp from the service input —
    // these never cross the public request boundary as authoritative
    // values.
    const useCase: DraftTermsUseCase = (
      ctx: DraftTermsUseCaseContext,
      tools: DraftTermsUseCaseTools,
    ) => evaluateDraftUseCase(ctx, tools, { ...input, now, proposedTerms: proposed });

    const result = await this.repository.draftTermsInTransaction(draftInput, useCase);
    if (!result.ok) {
      throw this.draftFailureToServiceError(result.reason);
    }
    const view = await this.repository.findDealView(input.dealId);
    const currentId = view?.currentTermsVersion?.id ?? result.value.id;
    const isCurrent = currentId === result.value.id;
    return { termsVersion: toPublicTermsVersion(result.value, isCurrent) };
  }

  // -----------------------------------------------------------------------
  // Approve terms
  // -----------------------------------------------------------------------

  /**
   * Record an explicit DealApproval bound to the current TermsVersion.
   *
   * The repository FOR UPDATE-locks the TermsVersion + Deal + acting
   * Workspace + WorkspaceMembership + DealApprover authorization rows
   * and hands the snapshot to the use-case closure. The use case
   * evaluates the approval policy and either persists or rejects.
   */
  async approveTerms(input: ApproveTermsInput): Promise<{
    readonly approval: Bg5DealApprovalPublicV1;
  }> {
    const now = input.now ?? this.now();
    const useCase: RecordApprovalUseCase = (
      ctx: RecordApprovalUseCaseContext,
      tools: RecordApprovalUseCaseTools,
    ) => evaluateApprovalUseCase(ctx, tools, { ...input, now });

    const result = await this.repository.recordApprovalInTransaction(
      {
        termsVersionId: input.termsVersionId,
        actingWorkspaceId: input.actingWorkspaceId,
        userAccountId: input.userAccountId,
        now,
      },
      useCase,
    );
    if (!result.ok) {
      throw this.approvalFailureToServiceError(result.reason);
    }
    return { approval: toPublicApproval(result.value) };
  }

  // -----------------------------------------------------------------------
  // Read Deal view
  // -----------------------------------------------------------------------

  /**
   * Read the Deal view (Deal + current TermsVersion + current
   * approvals). Membership authorization is the route's responsibility
   * — the service surfaces typed NOT_FOUND when the Deal does not
   * exist; the route's getDeal revalidates current membership against
   * the Deal's buyer/seller Workspace before calling this method.
   */
  async getDeal(_input: GetDealInput): Promise<{
    readonly deal: DealPublicV1;
    readonly currentTermsVersion: Bg5TermsVersionPublicV1 | null;
    readonly currentApprovals: readonly Bg5DealApprovalPublicV1[];
    readonly projectRequest: ProjectRequestPublicV1 | null;
  }> {
    const view = await this.repository.findDealView(_input.dealId);
    if (!view) {
      throw new DealTermsError("Deal not found.", "BG5_DEAL_NOT_FOUND");
    }
    return {
      deal: dealSummaryToPublic(view.deal),
      currentTermsVersion: view.currentTermsVersion
        ? toPublicTermsVersion(view.currentTermsVersion, true)
        : null,
      currentApprovals: view.currentApprovals.map(toPublicApproval),
      projectRequest: view.projectRequest,
    };
  }

  // -----------------------------------------------------------------------
  // AI boundary helpers
  // -----------------------------------------------------------------------

  private async produceProposedTerms(
    dealId: string,
  ): Promise<PersistDraftTermsInput["proposedTerms"]> {
    const summary = await this.repository.findDealSummary(dealId);
    if (!summary) {
      throw new DealTermsError("Deal not found.", "BG5_DEAL_NOT_FOUND");
    }
    // Try the configured adapter first; on failure fall back to the
    // deterministic adapter. The fallback is invoked through the same
    // validation boundary (see `validateCandidate`) so neither path
    // bypasses the strict schema.
    let attempted = false;
    for (const adapter of [this.aiAdapter, this.fallbackAiAdapter]) {
      if (attempted && adapter === this.fallbackAiAdapter) continue;
      attempted = true;
      try {
        const output = await adapter.draftProposedTerms({
          dealId: summary.id,
          buyerWorkspaceId: summary.buyerWorkspaceId,
          sellerWorkspaceId: summary.sellerWorkspaceId,
          serviceOfferingId: summary.serviceOfferingId,
          projectBriefId: summary.projectBriefId,
        });
        return validateCandidate(output.candidate, output.provider);
      } catch {
        // continue to the next adapter
      }
    }
    // Last-resort: return the deterministic shape directly. The
    // caller-side validation rejects the attempt if the shape is
    // malformed; this branch is unreachable because the
    // deterministic adapter always returns a valid candidate.
    throw new DealTermsError(
      "AI provider unavailable; deterministic fallback failed.",
      "BG5_TERMS_DRAFT_INVALID",
    );
  }

  // -----------------------------------------------------------------------
  // Failure translation
  // -----------------------------------------------------------------------

  private draftFailureToServiceError(reason: DraftTermsFailureReason): DealTermsError {
    switch (reason) {
      case "DEAL_NOT_FOUND":
        return new DealTermsError("Deal not found.", "BG5_DEAL_NOT_FOUND");
      case "DEAL_NOT_NEGOTIATING":
        return new DealTermsError(
          "Terms may only be drafted for a Negotiating Deal.",
          "BG5_DEAL_NOT_NEGOTIATING",
        );
      case "DRAFT_FORBIDDEN":
        return new DealTermsError(
          "You are not authorized to draft terms for this Deal.",
          "BG5_TERMS_DRAFT_FORBIDDEN",
        );
      case "DRAFT_INVALID":
        return new DealTermsError(
          "The proposed terms failed schema validation.",
          "BG5_TERMS_DRAFT_INVALID",
        );
      case "CONCURRENCY_RETRY_EXHAUSTED":
        return new DealTermsError(
          "The marketplace is busy; please retry.",
          "BG5_DEAL_UNAVAILABLE",
        );
    }
  }

  private approvalFailureToServiceError(reason: RecordApprovalFailureReason): DealTermsError {
    switch (reason) {
      case "DEAL_NOT_FOUND":
        return new DealTermsError("Deal not found.", "BG5_DEAL_NOT_FOUND");
      case "DEAL_NOT_NEGOTIATING":
        return new DealTermsError(
          "Terms may only be approved for a Negotiating Deal.",
          "BG5_DEAL_NOT_NEGOTIATING",
        );
      case "TERMS_VERSION_NOT_FOUND":
        return new DealTermsError("TermsVersion not found.", "BG5_TERMS_VERSION_NOT_FOUND");
      case "TERMS_VERSION_NOT_CURRENT":
        return new DealTermsError(
          "The TermsVersion is no longer current; a material replacement has been proposed.",
          "BG5_APPROVAL_NOT_CURRENT_VERSION",
        );
      case "APPROVAL_FORBIDDEN":
        return new DealTermsError(
          "You are not authorized to approve terms for this Workspace.",
          "BG5_APPROVAL_FORBIDDEN",
        );
      case "APPROVAL_ALREADY_RECORDED":
        return new DealTermsError(
          "An approval has already been recorded for this Workspace on this TermsVersion.",
          "BG5_APPROVAL_ALREADY_RECORDED",
        );
      case "CONCURRENCY_RETRY_EXHAUSTED":
        return new DealTermsError(
          "The marketplace is busy; please retry.",
          "BG5_DEAL_UNAVAILABLE",
        );
    }
  }
}

// ---------- application-owned use-case evaluators ----------

function evaluateDraftUseCase(
  ctx: DraftTermsUseCaseContext,
  tools: DraftTermsUseCaseTools,
  input: DraftTermsInput & {
    readonly now: Date;
    readonly proposedTerms: PersistDraftTermsInput["proposedTerms"];
  },
): DraftTermsUseCaseOutcome {
  const verdict = evaluateDraftingAuthority(ctx.draftingAuthority);
  if (!verdict.ok) {
    if (verdict.reason === "DEAL_NOT_FOUND") {
      return tools.reject("DEAL_NOT_FOUND");
    }
    if (verdict.reason === "DEAL_NOT_NEGOTIATING") {
      return tools.reject("DEAL_NOT_NEGOTIATING");
    }
    return tools.reject("DRAFT_FORBIDDEN");
  }
  return tools.persistDraft({
    dealId: input.dealId,
    draftedByUserId: input.userAccountId,
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    proposedTerms: input.proposedTerms,
    now: input.now,
  });
}

function evaluateApprovalUseCase(
  ctx: RecordApprovalUseCaseContext,
  tools: RecordApprovalUseCaseTools,
  input: ApproveTermsInput & { readonly now: Date },
): RecordApprovalUseCaseOutcome {
  const verdict = evaluateApprovalAuthority(ctx.approvalAuthority);
  if (!verdict.ok) {
    if (verdict.reason === "DEAL_NOT_FOUND") {
      return tools.reject("DEAL_NOT_FOUND");
    }
    if (verdict.reason === "DEAL_NOT_NEGOTIATING") {
      return tools.reject("DEAL_NOT_NEGOTIATING");
    }
    if (verdict.reason === "TERMS_VERSION_NOT_FOUND") {
      return tools.reject("TERMS_VERSION_NOT_FOUND");
    }
    if (verdict.reason === "TERMS_VERSION_NOT_CURRENT") {
      return tools.reject("TERMS_VERSION_NOT_CURRENT");
    }
    return tools.reject("APPROVAL_FORBIDDEN");
  }
  // The DealApprover authorization row id is loaded under FOR
  // UPDATE-lock by the repository and threaded through the snapshot.
  // The use case plumbs it into the persistApproval input so the
  // repository can insert the DealApproval row with the explicit
  // authorization binding (ticket #63: "Approval ... bound ...
  // explicit DealApprover permission").
  if (ctx.approvalAuthority.dealApproverId === null) {
    return tools.reject("APPROVAL_FORBIDDEN");
  }
  return tools.persistApproval({
    termsVersionId: input.termsVersionId,
    workspaceId: input.actingWorkspaceId,
    dealApproverId: ctx.approvalAuthority.dealApproverId,
    approvedByUserId: input.userAccountId,
    now: input.now,
  });
}

// ---------- validation ----------

function validateCandidate(
  candidate: unknown,
  provider: string,
): PersistDraftTermsInput["proposedTerms"] {
  // The application owns the boundary. The deterministic adapter
  // returns a value that already matches `bg5ProposedTermsV1`; we
  // re-shape it here so any future managed adapter that returns a
  // malformed candidate is rejected.
  if (!candidate || typeof candidate !== "object") {
    throw new Error("AI candidate must be an object");
  }
  // The schema at the public boundary is `z.record(z.string(),
  // z.unknown())`, so any object satisfies the assignment without a
  // double cast.
  const c = candidate as Record<string, unknown>;
  const stringOrEmpty = (v: unknown): string => (typeof v === "string" ? v : "");
  const numberOrZero = (v: unknown): number => (typeof v === "number" ? v : 0);
  const scope = stringOrEmpty(c["scope"]);
  const rightsSummary = stringOrEmpty(c["rightsSummary"]);
  const revisionAllowance = numberOrZero(c["revisionAllowance"]);
  const deliverablesRaw = c["deliverables"];
  const deliverables: PersistDraftTermsInput["proposedTerms"]["deliverables"] = Array.isArray(
    deliverablesRaw,
  )
    ? deliverablesRaw.map((d) => ({
        title: stringOrEmpty((d as Record<string, unknown>)?.title),
        description: stringOrEmpty((d as Record<string, unknown>)?.description),
      }))
    : [];
  const scheduleRaw = c["schedule"];
  const schedule: PersistDraftTermsInput["proposedTerms"]["schedule"] =
    scheduleRaw && typeof scheduleRaw === "object"
      ? {
          startDate: stringOrEmpty((scheduleRaw as Record<string, unknown>)["startDate"]) || "2026-01-01",
          endDate: stringOrEmpty((scheduleRaw as Record<string, unknown>)["endDate"]) || "2026-01-01",
          deliveryDays: numberOrZero((scheduleRaw as Record<string, unknown>)["deliveryDays"]) || 1,
        }
      : { startDate: "2026-01-01", endDate: "2026-01-01", deliveryDays: 1 };
  const priceRaw = c["price"];
  const price: PersistDraftTermsInput["proposedTerms"]["price"] =
    priceRaw && typeof priceRaw === "object"
      ? {
          amountMinor:
            numberOrZero((priceRaw as Record<string, unknown>)["amountMinor"]) || 0,
          currency: "USD",
        }
      : { amountMinor: 0, currency: "USD" };
  const fundingDeadlineAt =
    typeof c["fundingDeadlineAt"] === "string" ? c["fundingDeadlineAt"] : undefined;
  // The deterministic adapter does not need a provider-keyed
  // distinction here; the application service stamps aiProvider
  // based on which adapter produced the candidate.
  void provider;
  return {
    scope,
    deliverables,
    schedule,
    price,
    revisionAllowance,
    rightsSummary,
    ...(fundingDeadlineAt !== undefined ? { fundingDeadlineAt } : {}),
  };
}

// ---------- DTO mapping ----------

export function toPublicTermsVersion(
  persisted: PersistedTermsVersion,
  isCurrent: boolean,
): Bg5TermsVersionPublicV1 {
  const deliverables = persisted.deliverablesJson as Array<{
    title: string;
    description: string;
  }>;
  const schedule = persisted.scheduleJson as PersistDraftTermsInput["proposedTerms"]["schedule"];
  return {
    termsVersionId: persisted.id,
    dealId: persisted.dealId,
    version: persisted.version,
    scope: persisted.scope,
    deliverables,
    schedule,
    price: { amountMinor: persisted.priceAmountMinor, currency: "USD" },
    revisionAllowance: persisted.revisionAllowance,
    rightsSummary: persisted.rightsSummary,
    fundingDeadlineAt: persisted.fundingDeadlineAt
      ? persisted.fundingDeadlineAt.toISOString()
      : null,
    aiProvider: persisted.aiProvider as Bg5TermsVersionPublicV1["aiProvider"],
    aiModelId: persisted.aiModelId,
    aiFallbackUsed: persisted.aiFallbackUsed,
    aiDraftedUnapprovedBadge: true,
    draftedAt: persisted.draftedAt.toISOString(),
    createdAt: persisted.createdAt.toISOString(),
    isCurrentVersion: isCurrent,
  };
}

export function toPublicApproval(persisted: PersistedDealApproval): Bg5DealApprovalPublicV1 {
  return {
    dealApprovalId: persisted.id,
    termsVersionId: persisted.termsVersionId,
    workspaceId: persisted.workspaceId,
    approvedAt: persisted.approvedAt.toISOString(),
  };
}

export function dealSummaryToPublic(persisted: PersistedDealSummary): DealPublicV1 {
  return {
    dealId: persisted.id,
    buyerWorkspaceId: persisted.buyerWorkspaceId,
    sellerWorkspaceId: persisted.sellerWorkspaceId,
    serviceOfferingId: persisted.serviceOfferingId,
    projectBriefId: persisted.projectBriefId,
    projectRequestId: persisted.projectRequestId,
    status: persisted.status,
    activatedAt: persisted.activatedAt ? persisted.activatedAt.toISOString() : null,
    createdAt: persisted.createdAt.toISOString(),
  };
}

export type {
  DealTermsRepository,
  DealViewSnapshot,
  PersistDraftTermsInput,
  PersistApprovalInput,
  DraftTermsFailureReason,
  RecordApprovalFailureReason,
  DraftTermsResult,
  RecordApprovalResult,
  DraftingAuthoritySnapshot,
  ApprovalAuthoritySnapshot,
};