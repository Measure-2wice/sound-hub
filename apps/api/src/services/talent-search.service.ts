// TalentSearchService: deterministic Milestone 1 retrieval.
//
// Implements the `postgres-text-v1` strategy as fixed by issue #2:
//
// 1. Normalize the query by trimming, collapsing internal whitespace,
//    lowercasing, stripping surrounding punctuation, and deduplicating
//    non-empty tokens.
// 2. Match distinct query tokens against the seeded offering title and the
//    primary ServiceCategory key and name using case-insensitive comparison.
// 3. Compute relevanceScore as `matched distinct query tokens / distinct
//    query tokens`, bounded from zero through one. Use stable sellerId as
//    the final tie-breaker.
// 4. Build matchReason only from fields that actually matched, using factual
//    wording such as `matched offering title` or `matched category`. Do not
//    use qualitative labels, randomness, or AI claims.
// 5. Return the single matching offering as `bestMatchingOffering` and an
//    empty `additionalMatchingOfferings` array for the M1.1 tracer.
//
// Required constraints exclude candidates. Preferred constraints influence
// ranking and are owned by issue #6. Unknown Caribbean affiliation codes
// are rejected with INVALID_SEARCH_CRITERIA at the service boundary.

import {
  isSupportedCaribbeanAffiliationCode,
  isSupportedServiceCategoryKey,
  isSupportedSpecialtyKey,
  type LocationFilterV1,
  type PublicOfferingSummaryV1,
  type PublicSellerSummaryV1,
  type TalentSearchRequestV1,
  type TalentSearchResponseV1,
  type TalentSearchResultV1,
} from "@soundhub/types";
import type {
  RepositoryCandidateOffering,
  RepositoryCandidateSeller,
  RepositorySearchInput,
  TalentSearchRepository,
} from "../repositories/talent-search.repository.js";

export class TalentSearchInvalidCriteriaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TalentSearchInvalidCriteriaError";
  }
}

export class TalentSearchService {
  constructor(private readonly repository: TalentSearchRepository) {}

  async search(request: TalentSearchRequestV1): Promise<TalentSearchResponseV1> {
    const startedAt = Date.now();
    const normalizedQuery = normalizeQuery(request.query);
    const queryTokens = tokenize(normalizedQuery);

    this.assertSupportedControlledKeys(request);
    this.assertSupportedCaribbeanCodes(request);

    const repositoryInput = this.buildRepositoryInput(request);
    const candidates = await this.repository.search(repositoryInput);

    const scored: RankedCandidate[] = [];
    for (const seller of candidates) {
      const rankedOffering = this.rankBestOffering(seller, queryTokens);
      if (!rankedOffering) continue;
      scored.push({
        seller,
        offering: rankedOffering.offering,
        score: rankedOffering.score,
        reason: rankedOffering.reason,
      });
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.seller.sellerId.localeCompare(b.seller.sellerId);
    });

    const results: TalentSearchResultV1[] = scored.slice(0, 10).map((entry) => ({
      seller: toPublicSeller(entry.seller),
      bestMatchingOffering: toPublicOffering(entry.offering),
      additionalMatchingOfferings: [],
      relevanceScore: clamp01(entry.score),
      matchReason: entry.reason,
    }));

    return {
      results,
      metadata: {
        ...(normalizedQuery ? { normalizedQuery } : {}),
        totalResults: results.length,
        processingTimeMs: Math.max(0, Date.now() - startedAt),
        strategy: "postgres-text-v1",
        appliedRequiredCriteria: request.required ?? {},
        appliedPreferredCriteria: request.preferred ?? {},
      },
    };
  }

  private assertSupportedCaribbeanCodes(request: TalentSearchRequestV1): void {
    const codes = request.preferred?.caribbeanAffiliationCodes ?? [];
    const unknown = codes.filter((code) => !isSupportedCaribbeanAffiliationCode(code));
    if (unknown.length > 0) {
      throw new TalentSearchInvalidCriteriaError(
        `Unsupported Caribbean affiliation code(s): ${unknown.join(", ")}`,
      );
    }
  }

  private assertSupportedControlledKeys(request: TalentSearchRequestV1): void {
    const requiredCategoryKeys = request.required?.primaryCategoryKeys ?? [];
    const requiredServiceKeys = request.required?.independentlyPurchasableServiceKeys ?? [];
    const preferredCategoryKeys = request.preferred?.categoryKeys ?? [];
    const preferredIncludedServiceKeys = request.preferred?.includedServiceKeys ?? [];
    const preferredSpecialtyKeys = request.preferred?.specialties ?? [];

    const allCategoryKeys = [
      ...requiredCategoryKeys,
      ...requiredServiceKeys,
      ...preferredCategoryKeys,
      ...preferredIncludedServiceKeys,
    ];
    const unknownCategories = allCategoryKeys.filter(
      (key) => !isSupportedServiceCategoryKey(key),
    );
    if (unknownCategories.length > 0) {
      throw new TalentSearchInvalidCriteriaError(
        `Unsupported service category key(s): ${[...new Set(unknownCategories)].join(", ")}`,
      );
    }

    const unknownSpecialties = preferredSpecialtyKeys.filter(
      (key) => !isSupportedSpecialtyKey(key),
    );
    if (unknownSpecialties.length > 0) {
      throw new TalentSearchInvalidCriteriaError(
        `Unsupported specialty key(s): ${[...new Set(unknownSpecialties)].join(", ")}`,
      );
    }
  }

  private buildRepositoryInput(request: TalentSearchRequestV1): RepositorySearchInput {
    return {
      serviceModes: dedupe(request.required?.serviceModes ?? []),
      primaryCategoryKeys: dedupe(request.required?.primaryCategoryKeys ?? []),
      independentlyPurchasableServiceKeys: dedupe(
        request.required?.independentlyPurchasableServiceKeys ?? [],
      ),
      basedIn: toRepositoryLocation(request.required?.basedIn),
      serviceArea: toRepositoryLocation(request.required?.serviceArea),
    };
  }

  private rankBestOffering(
    seller: RepositoryCandidateSeller,
    queryTokens: readonly string[],
  ): { offering: RepositoryCandidateOffering; score: number; reason: string } | null {
    if (queryTokens.length === 0) {
      // Structured-only query: the repository has already enforced required
      // eligibility, so the first offering of each eligible seller is the
      // deterministic best match. Score is 0 because no tokens were provided.
      const first = seller.offerings[0];
      if (!first) return null;
      return { offering: first, score: 0, reason: "eligible candidate" };
    }
    let best: { offering: RepositoryCandidateOffering; score: number; reason: string } | null =
      null;
    for (const offering of seller.offerings) {
      const { matched, fields } = scoreOffering(offering, queryTokens);
      if (matched === 0) continue;
      const score = matched / queryTokens.length;
      if (!best || score > best.score) {
        best = { offering, score, reason: describeMatch(fields) };
      }
    }
    return best;
  }
}

// ---------- Normalization ----------

function normalizeQuery(value: string | undefined): string {
  if (!value) return "";
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function tokenize(value: string): string[] {
  if (value.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/\s+/)) {
    const cleaned = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (cleaned.length === 0) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function dedupe<T>(values: readonly T[]): readonly T[] {
  return Array.from(new Set(values));
}

function toRepositoryLocation(
  filter: LocationFilterV1 | undefined,
): RepositorySearchInput["basedIn"] {
  if (!filter) return null;
  return {
    city: filter.city ?? null,
    region: filter.region ?? null,
    countryCode: filter.countryCode ?? null,
  };
}

// ---------- Scoring ----------

const FIELD_TITLE = "title" as const;
const FIELD_CATEGORY_KEY = "category-key" as const;
const FIELD_CATEGORY_NAME = "category-name" as const;
type MatchField = typeof FIELD_TITLE | typeof FIELD_CATEGORY_KEY | typeof FIELD_CATEGORY_NAME;

interface ScoreResult {
  readonly matched: number;
  readonly fields: ReadonlySet<MatchField>;
}

function scoreOffering(
  offering: RepositoryCandidateOffering,
  queryTokens: readonly string[],
): ScoreResult {
  if (queryTokens.length === 0) {
    return { matched: 0, fields: new Set() };
  }
  const titleTokens = tokenize(offering.title.toLowerCase());
  const categoryKeyTokens = tokenize(offering.primaryCategory.key.toLowerCase());
  const categoryNameTokens = tokenize(offering.primaryCategory.name.toLowerCase());

  const titleSet = new Set(titleTokens);
  const categoryKeySet = new Set(categoryKeyTokens);
  const categoryNameSet = new Set(categoryNameTokens);

  let matched = 0;
  const fields = new Set<MatchField>();
  for (const token of queryTokens) {
    const inTitle = titleSet.has(token);
    const inCategoryKey = categoryKeySet.has(token);
    const inCategoryName = categoryNameSet.has(token);
    if (inTitle || inCategoryKey || inCategoryName) {
      matched += 1;
      if (inTitle) fields.add(FIELD_TITLE);
      if (inCategoryKey) fields.add(FIELD_CATEGORY_KEY);
      if (inCategoryName) fields.add(FIELD_CATEGORY_NAME);
    }
  }
  return { matched, fields };
}

function describeMatch(fields: ReadonlySet<MatchField>): string {
  const parts: string[] = [];
  if (fields.has(FIELD_TITLE)) parts.push("matched offering title");
  if (fields.has(FIELD_CATEGORY_KEY)) parts.push("matched category key");
  if (fields.has(FIELD_CATEGORY_NAME)) parts.push("matched category name");
  if (parts.length === 0) return "matched";
  return parts.join("; ");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------- DTO mapping ----------

function toPublicSeller(seller: RepositoryCandidateSeller): PublicSellerSummaryV1 {
  const basedIn: PublicSellerSummaryV1["basedIn"] = {
    countryCode: seller.basedInCountryCode,
    ...(seller.basedInCity ? { city: seller.basedInCity } : {}),
    ...(seller.basedInRegion ? { region: seller.basedInRegion } : {}),
  };
  return {
    sellerId: seller.sellerId,
    professionalName: seller.professionalName,
    specialties: [...seller.specialtyKeys],
    bio: seller.bio,
    basedIn,
    caribbeanAffiliationCodes: [...seller.caribbeanAffiliationCodes],
    ...(seller.avatarUrl ? { avatarUrl: seller.avatarUrl } : {}),
  };
}

function toPublicOffering(offering: RepositoryCandidateOffering): PublicOfferingSummaryV1 {
  return {
    offeringId: offering.offeringId,
    title: offering.title,
    description: offering.description,
    primaryCategory: {
      key: offering.primaryCategory.key,
      name: offering.primaryCategory.name,
    },
    includedServices: offering.includedServices.map((included) => ({
      key: included.key,
      name: included.name,
      purchaseMode: "BundleOnly" as const,
    })),
    genreTags: [...offering.genreTags],
    serviceMode: offering.serviceMode,
    serviceAreas: offering.serviceAreas.map((area) => ({
      countryCode: area.countryCode,
      ...(area.city ? { city: area.city } : {}),
      ...(area.region ? { region: area.region } : {}),
    })),
    ...(offering.pricing ? { pricing: toPublicPricing(offering.pricing) } : {}),
  };
}

function toPublicPricing(pricing: RepositoryCandidateOffering["pricing"] & object) {
  if (pricing.kind === "ContactForQuote") {
    return { kind: "ContactForQuote" as const };
  }
  if (pricing.amountMinor === null || pricing.currency === null || pricing.unitKey === null) {
    return { kind: "ContactForQuote" as const };
  }
  return {
    kind: pricing.kind,
    amount: { amountMinor: pricing.amountMinor, currency: pricing.currency },
    unit: pricing.unitKey,
  };
}

interface RankedCandidate {
  seller: RepositoryCandidateSeller;
  offering: RepositoryCandidateOffering;
  score: number;
  reason: string;
}
