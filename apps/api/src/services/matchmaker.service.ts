// Matchmaker service.
//
// Background: BG3 requires the application layer that interprets a
// natural-language ProjectBrief into eligibility-determined search
// recommendations. The service owns:
//
//   - Workspace authorization (current Buyer-capable membership).
//   - AI boundary invocations (managed OR deterministic fallback).
//   - Runtime validation of the AI output through the shared
//     `bg3MatchmakerCriteriaV1Schema` (no unvalidated value ever
//     reaches the search service).
//   - Persistence of the Brief + search results.
//   - Evidence-grounded explanation assembly from the returned
//     search results (AI cannot invent qualifications).
//
// The service invokes the existing `TalentSearchService`; it does
// NOT query Prisma directly, and the AI adapter never sees Prisma
// models, raw session tokens, or storage keys. This keeps the
// `relevanceScore` semantics owned by the M1 search contract (the
// score is strategy-specific ordering, not buyer-facing confidence)
// and lets the application service produce a buyer-safe DTO from
// the search result.

import type {
  Bg3AiInterpretInputV1,
  Bg3AiProviderV1,
  Bg3AiInterpretOutputV1,
  Bg3ExplanationEntryV1,
  Bg3ExplanationKindV1,
  Bg3MatchmakerCriteriaV1,
  Bg3PublicProjectBriefV1,
  Bg3RecommendationV1,
  Bg3SubmitBriefResponseV1,
  PublicOfferingSummaryV1,
  PublicSellerSummaryV1,
  TalentSearchRequestV1,
  TalentSearchResponseV1,
} from "@soundhub/types";
import { bg3MatchmakerCriteriaV1Schema, publicOfferingSummaryV1Schema } from "@soundhub/types";
import type { AiAdapter, AiUnavailableError } from "../matchmaker/ai-adapter.js";
import { DeterministicAiAdapter } from "../matchmaker/deterministic-ai-adapter.js";
import type {
  PersistedBrief,
  ProjectBriefRepository,
} from "../matchmaker/project-brief.repository.js";
import {
  type ActingMembership,
  type WorkspaceAuthorizationService,
} from "./workspace-authorization.service.js";
import type { TalentSearchService } from "./talent-search.service.js";

export class MatchmakerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "MATCHMAKER_INVALID_REQUEST"
      | "MATCHMAKER_AI_UNAVAILABLE"
      | "MATCHMAKER_FAILED"
      | "BRIEF_NOT_FOUND"
      | "BRIEF_FORBIDDEN"
      | "INVALID_SEARCH_CRITERIA",
  ) {
    super(message);
    this.name = "MatchmakerError";
  }
}

export interface MatchmakerServiceDeps {
  readonly talentSearchService: TalentSearchService;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  readonly projectBriefRepository: ProjectBriefRepository;
  /**
   * Primary AI adapter. When the primary adapter throws
   * `AiUnavailableError` or returns a malformed payload, the
   * service falls back to the deterministic adapter and crosses
   * the same validation + search boundary (per ticket #60 and the
   * buildathon Golden Slice spec).
   */
  readonly aiAdapter: AiAdapter;
  /**
   * Fallback adapter. Defaults to a fresh `DeterministicAiAdapter`
   * if not supplied so the deterministic path is always
   * available.
   */
  readonly fallbackAiAdapter?: AiAdapter;
  /**
   * Optional clock injection for tests.
   */
  readonly now?: () => number;
}

export interface SubmitBriefInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly briefText: string;
  readonly buyerNonSearchRequirements?: Record<string, string>;
}

export interface SubmitBriefResult {
  readonly brief: Bg3PublicProjectBriefV1;
  readonly recommendations: readonly Bg3RecommendationV1[];
  readonly totalResults: number;
  readonly strategy: "postgres-text-v1";
  readonly fallbackNotice: string | undefined;
}

export interface GetBriefInput {
  readonly userAccountId: string;
  readonly briefId: string;
}

export interface GetBriefResult {
  readonly brief: Bg3PublicProjectBriefV1;
}

export class MatchmakerService {
  private readonly talentSearchService: TalentSearchService;
  private readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  private readonly projectBriefRepository: ProjectBriefRepository;
  private readonly primaryAi: AiAdapter;
  private readonly fallbackAi: AiAdapter;

  constructor(deps: MatchmakerServiceDeps) {
    this.talentSearchService = deps.talentSearchService;
    this.workspaceAuthorizationService = deps.workspaceAuthorizationService;
    this.projectBriefRepository = deps.projectBriefRepository;
    this.primaryAi = deps.aiAdapter;
    this.fallbackAi = deps.fallbackAiAdapter ?? new DeterministicAiAdapter();
  }

  /**
   * Submit a natural-language brief. The full sequence is:
   *
   *   1. Authorize the buyer (current Buyer-capable membership).
   *   2. Hand the brief to the primary AI adapter.
   *   3. Parse the AI output through `bg3MatchmakerCriteriaV1Schema`.
   *      On parse failure or `AiUnavailableError`, fall back to
   *      the deterministic adapter and re-parse.
   *   4. Invoke the existing `TalentSearchService` (no second
   *      search path; AI never touches Prisma).
   *   5. Build evidence-grounded explanations from the returned
   *      results (AI cannot invent facts).
   *   6. Persist the Brief + results in a single transactional
   *      write.
   *   7. Return the buyer-safe DTO (recommendations + brief).
   */
  async submitBrief(input: SubmitBriefInput): Promise<SubmitBriefResult> {
    const membership = await this.requireBuyer(input.userAccountId, input.actingWorkspaceId);

    const aiInput: Bg3AiInterpretInputV1 = {
      actingWorkspaceId: membership.workspace.workspaceId,
      briefText: input.briefText,
      buyerNonSearchRequirements: input.buyerNonSearchRequirements,
    };

    // Step 1: try the primary adapter. On any failure, fall
    // through to the deterministic adapter and re-parse. The
    // fallback never sees unvalidated AI output because every
    // candidate payload must round-trip through
    // `bg3MatchmakerCriteriaV1Schema` before it reaches the search
    // service.
    let aiOutput: Bg3AiInterpretOutputV1;
    let usedFallback = false;
    try {
      aiOutput = await this.primaryAi.interpretBrief(aiInput);
    } catch (err) {
      if (!isUnavailableError(err)) {
        throw new MatchmakerError("AI interpretation failed unexpectedly.", "MATCHMAKER_FAILED");
      }
      usedFallback = true;
      aiOutput = await this.fallbackAi.interpretBrief(aiInput);
    }

    let criteria: Bg3MatchmakerCriteriaV1;
    try {
      criteria = bg3MatchmakerCriteriaV1Schema.parse(aiOutput.candidate);
    } catch {
      if (!usedFallback) {
        // Primary adapter returned a malformed payload — fall
        // back. The validation step is the single point at which
        // required constraints are guaranteed to survive; the
        // fallback produces a candidate whose `required` block
        // always contains at least one hard axis.
        try {
          const fallbackOutput = await this.fallbackAi.interpretBrief(aiInput);
          criteria = bg3MatchmakerCriteriaV1Schema.parse(fallbackOutput.candidate);
          // Reassign aiOutput so the provenance trail below
          // records the fallback adapter's provider + model rather
          // than the primary adapter's (which would otherwise be
          // persisted alongside `aiFallbackUsed: true`).
          aiOutput = fallbackOutput;
          usedFallback = true;
        } catch {
          throw new MatchmakerError(
            "AI interpretation produced an invalid criteria payload and the deterministic fallback also failed.",
            "MATCHMAKER_INVALID_REQUEST",
          );
        }
      } else {
        throw new MatchmakerError(
          "Deterministic fallback produced an invalid criteria payload.",
          "MATCHMAKER_INVALID_REQUEST",
        );
      }
    }

    // Provenance. The fallback flag is true if EITHER path was
    // the deterministic fallback; the provider key reflects the
    // adapter that produced the final payload.
    const aiProvider: Bg3AiProviderV1 = usedFallback
      ? "deterministic-fallback"
      : this.normaliseProvider(aiOutput.provider);
    const aiModelId = aiOutput.modelId;

    // Step 2: invoke the existing TalentSearchService. No
    // second search path is introduced; the M1 service owns
    // eligibility, ranking, and the bounded relevanceScore.
    const searchRequest: TalentSearchRequestV1 = {
      ...(criteria.query ? { query: criteria.query } : {}),
      required: criteria.required,
      ...(criteria.preferred ? { preferred: criteria.preferred } : {}),
    };
    let searchResponse: TalentSearchResponseV1;
    try {
      searchResponse = await this.talentSearchService.search(searchRequest);
    } catch (err) {
      if (err instanceof Error && err.name === "TalentSearchInvalidCriteriaError") {
        throw new MatchmakerError(err.message, "INVALID_SEARCH_CRITERIA");
      }
      throw new MatchmakerError(
        "Talent search could not be completed for this brief.",
        "MATCHMAKER_FAILED",
      );
    }

    // Step 3: persist the Brief + results in one write. The
    // repository owns the transaction; the service just threads
    // validated inputs through it.
    const persisted = await this.projectBriefRepository.createBrief({
      buyerWorkspaceId: membership.workspace.workspaceId,
      createdByUserId: input.userAccountId,
      briefText: input.briefText,
      criteria,
      searchResponse,
      aiProvider,
      aiModelId,
      aiFallbackUsed: usedFallback,
    });

    return {
      brief: toPublicBrief(persisted),
      recommendations: persisted.results.map((r) => buildRecommendation(persisted.criteria, r)),
      totalResults: persisted.results.length,
      strategy: "postgres-text-v1",
      fallbackNotice: usedFallback
        ? "The AI interpretation was unavailable; SoundHub used its deterministic fallback to derive search criteria."
        : undefined,
    };
  }

  /**
   * Fetch a previously-persisted Brief. Authorization revalidates
   * the current buyer's WorkspaceMembership (GS 4 / GS 5 / GS 6);
   * a non-member buyer receives `BRIEF_FORBIDDEN` and a missing
   * brief receives `BRIEF_NOT_FOUND`.
   */
  async getBrief(input: GetBriefInput): Promise<GetBriefResult> {
    const persisted = await this.projectBriefRepository.findBriefById(input.briefId);
    if (!persisted) {
      throw new MatchmakerError("ProjectBrief not found.", "BRIEF_NOT_FOUND");
    }
    // The buyer's WorkspaceMembership MUST be revalidated on
    // every read, not just at brief-creation time. A human
    // revoked from the Workspace after authoring the brief
    // cannot fetch it.
    await this.workspaceAuthorizationService.requireCapability({
      userAccountId: input.userAccountId,
      workspaceId: persisted.buyerWorkspaceId,
      requiredCapability: "Buyer",
    });
    return { brief: toPublicBrief(persisted) };
  }

  private async requireBuyer(
    userAccountId: string,
    workspaceId: string,
  ): Promise<ActingMembership> {
    return this.workspaceAuthorizationService.requireCapability({
      userAccountId,
      workspaceId,
      requiredCapability: "Buyer",
    });
  }

  private normaliseProvider(provider: string): Bg3AiProviderV1 {
    if (provider === "managed" || provider === "deterministic-fallback") {
      return provider;
    }
    // An unknown provider key fails closed — the application
    // never trusts an arbitrary string from the adapter as a
    // provenance label.
    return "deterministic-fallback";
  }
}

function isUnavailableError(err: unknown): err is AiUnavailableError {
  return (
    err instanceof Error &&
    (err.name === "AiUnavailableError" || err.name === "IdentityProviderUnavailableError")
  );
}

// ---------- DTO mapping ----------

/**
 * Map a persisted Brief to the allow-listed public DTO. The
 * persisted `criteria` is already M1-validated by the repository;
 * this function only emits the buyer-safe fields the BG3 contract
 * declares.
 */
export function toPublicBrief(persisted: PersistedBrief): Bg3PublicProjectBriefV1 {
  return {
    briefId: persisted.id,
    actingWorkspaceId: persisted.buyerWorkspaceId,
    createdByUserId: persisted.createdByUserId,
    briefText: persisted.briefText,
    criteria: persisted.criteria,
    aiProvider: normaliseProviderLabel(persisted.aiProvider),
    aiModelId: persisted.aiModelId,
    aiFallbackUsed: persisted.aiFallbackUsed,
    createdAt: persisted.createdAt.toISOString(),
    buyerWorkspace: {
      workspaceId: persisted.buyerWorkspace.workspaceId,
      slug: persisted.buyerWorkspace.slug,
      name: persisted.buyerWorkspace.name,
    },
  };
}

function normaliseProviderLabel(provider: string): Bg3AiProviderV1 {
  if (provider === "managed" || provider === "deterministic-fallback") {
    return provider;
  }
  return "deterministic-fallback";
}

/**
 * Build an evidence-grounded recommendation for one returned
 * search result. The recommendation is assembled entirely from the
 * persisted search result + the validated criteria; AI cannot
 * inject free-form text. The buyer sees factual match evidence
 * (matched fields, preference atom coverage, query token
 * coverage) and nothing else.
 */
export function buildRecommendation(
  criteria: Bg3MatchmakerCriteriaV1,
  result: PersistedBrief["results"][number],
): Bg3RecommendationV1 {
  const seller = result.sellerSnapshotJson as PublicSellerSummaryV1;
  const best = result.bestOfferingSnapshotJson as PublicOfferingSummaryV1;
  // Restore up to two additional standalone matching offerings
  // from the persisted snapshot. The repository stores them as
  // JSON so the application layer validates the shape against
  // publicOfferingSummaryV1Schema on read — drift fails closed
  // (the route handler surfaces a safe envelope rather than a
  // half-built DTO).
  const additional: PublicOfferingSummaryV1[] = [];
  for (const entry of result.additionalOfferingsJson) {
    additional.push(publicOfferingSummaryV1Schema.parse(entry));
  }
  const explanations = collectExplanations(criteria, best, result.matchReason);

  return {
    sellerId: seller.sellerId,
    professionalName: seller.professionalName,
    bestMatchingOfferingId: best.offeringId,
    relevanceScore: result.relevanceScore,
    explanations: [...explanations],
    matchReason: result.matchReason,
    ...(result.preferenceCoverageJson
      ? { preferenceCoverage: result.preferenceCoverageJson as never }
      : {}),
    ...(result.textCoverageJson ? { textCoverage: result.textCoverageJson as never } : {}),
    bestMatchingOffering: best,
    seller,
    additionalMatchingOfferings: additional,
  };
}

function collectExplanations(
  criteria: Bg3MatchmakerCriteriaV1,
  best: PublicOfferingSummaryV1,
  matchReason: string,
): readonly Bg3ExplanationEntryV1[] {
  const out: Bg3ExplanationEntryV1[] = [];
  const seen = new Set<string>();
  const push = (kind: Bg3ExplanationKindV1, label: string) => {
    const key = `${kind}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, label });
  };

  // Factual labels derived from the persisted matchReason
  // (which the TalentSearchService assembles from real matched
  // fields and preference atoms). AI does not author these
  // strings; the service just maps the canonical prefixes to
  // allow-listed explanation kinds.
  const segments = matchReason
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (lower.startsWith("matched offering title")) {
      push("matched-offering-title", "Matched the offering title");
    } else if (
      lower.startsWith("matched category key") ||
      lower.startsWith("matched category name")
    ) {
      push(
        lower.startsWith("matched category key") ? "matched-category-key" : "matched-category-name",
        lower.startsWith("matched category key")
          ? "Matched the category key"
          : "Matched the category name",
      );
    } else if (lower.startsWith("preferred genre:")) {
      push("preferred-genre", segment);
    } else if (lower.startsWith("preferred category:")) {
      push("preferred-category", segment);
    } else if (lower.startsWith("preferred specialty:")) {
      push("preferred-specialty", segment);
    } else if (lower.startsWith("preferred caribbean affiliation:")) {
      push("preferred-affiliation", segment);
    } else if (lower.startsWith("preferred service mode:")) {
      push("preferred-service-mode", segment);
    } else if (lower.startsWith("preferred bundle component:")) {
      push("preferred-included-service", segment);
    } else if (
      lower.startsWith("preferred based-in country:") ||
      lower.startsWith("preferred based-in region:") ||
      lower.startsWith("preferred based-in city:")
    ) {
      push("preferred-locality", segment);
    } else if (lower === "eligible standalone offering") {
      push("standalone-offering", "Eligible standalone offering");
    }
  }

  // Always include the buyer's hard-required constraints (if any)
  // as a transparent audit line, derived from the validated
  // criteria rather than AI output.
  const req = criteria.required;
  if (req.serviceModes && req.serviceModes.length > 0) {
    push("preferred-service-mode", `Required service mode: ${req.serviceModes.join(", ")}`);
  }
  if (req.primaryCategoryKeys && req.primaryCategoryKeys.length > 0) {
    push("preferred-category", `Required category: ${req.primaryCategoryKeys.join(", ")}`);
  }
  if (
    req.independentlyPurchasableServiceKeys &&
    req.independentlyPurchasableServiceKeys.length > 0
  ) {
    push(
      "preferred-included-service",
      `Required service: ${req.independentlyPurchasableServiceKeys.join(", ")}`,
    );
  }
  if (req.basedIn) {
    const parts = [req.basedIn.city, req.basedIn.region, req.basedIn.countryCode].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (parts.length > 0) {
      push("preferred-locality", `Required location: ${parts.join(", ")}`);
    }
  }

  // Reference the offering's primary category so a UI can
  // render a category chip even when the textual matchReason
  // does not include it.
  if (!out.some((entry) => entry.kind === "matched-category-key")) {
    push(
      "matched-category-key",
      `Listed under ${best.primaryCategory.name} (${best.primaryCategory.key})`,
    );
  }

  return out;
}

// Avoid a circular import at module load by re-exporting the
// response shape for routes that need it.
export type { Bg3SubmitBriefResponseV1 };
