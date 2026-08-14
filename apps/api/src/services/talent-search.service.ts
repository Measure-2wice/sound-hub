// TalentSearchService: deterministic Milestone 1 retrieval.
//
// Implements the `postgres-text-v1` strategy as completed by issue #6 (M1.5):
//
// 1. Normalize the query by trimming, collapsing internal whitespace,
//    lowercasing, stripping surrounding punctuation, and deduplicating
//    non-empty tokens.
// 2. Match distinct query tokens against the seeded offering title and the
//    primary ServiceCategory key and name using case-insensitive comparison.
// 3. Compute relevanceScore as a deterministic blend of text coverage and
//    a fraction of the buyer's preference atoms that matched:
//        score = clamp01(textScore + PREFERENCE_WEIGHT * preferenceScore)
//    The blend preserves the M1.1 invariant that a query whose tokens all
//    match the offering fields produces a relevanceScore of 1.0; the
//    preference weight caps the additive lift at a fixed fraction so the
//    score remains bounded inside [0, 1] and is finite. Because the
//    blend can saturate at 1.0 under full text coverage, the seller sort
//    uses the count of matched preference atoms as a secondary
//    tie-breaker ahead of the stable sellerId so preference evidence
//    stays order-significant at full coverage. Stable offeringId is the
//    per-seller tie-breaker for best/additional selection.
// 4. Build matchReason only from fields that actually matched, using factual
//    wording such as `matched offering title`, `matched category`, or
//    `preferred genre: Dancehall`. Never use qualitative labels, randomness,
//    or AI claims.
// 5. Return at most ten sellers; each seller appears once. Lead with the
//    seller's standalone best-matching offering; include at most two
//    additional standalone matching offerings. Bundle-only primary-category
//    offerings are filtered out of the best/additional slots so a
//    bundle-only match is never presented as a standalone purchase; the
//    seller's eligible bundle-only IncludedServices still ride along inside
//    each presented offering's `includedServices` array, which already
//    carries `purchaseMode: "BundleOnly"` for accurate labeling.
//
// Required constraints exclude candidates. Preferred constraints influence
// ranking and never exclude (an unmatched preference is non-binding per the
// v1 contract). Unknown Caribbean affiliation codes are rejected with
// INVALID_SEARCH_CRITERIA at the service boundary.

import {
  isSupportedCaribbeanAffiliationCode,
  type LocationFilterV1,
  type PublicOfferingSummaryV1,
  type PublicSellerSummaryV1,
  type TalentSearchPreferredCriteriaV1,
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

// Named preference weight exposed via the strategy comment so the constant
// can be reasoned about in isolation. The M1.5 contract requires that the
// relevanceScore is bounded inside [0, 1] and finite, that it preserves
// the M1.1 invariant that full text overlap produces 1.0, and that
// preferences additively influence ranking without excluding candidates.
// Keeping the weight at 0.5 means preferences can lift a candidate at most
// halfway toward the unattainable "above 1.0" ceiling, which the clamp
// then enforces. Tuned once and reviewed; changing it moves the strategy.
const PREFERENCE_WEIGHT = 0.5;

export class TalentSearchService {
  constructor(private readonly repository: TalentSearchRepository) {}

  async search(request: TalentSearchRequestV1): Promise<TalentSearchResponseV1> {
    const startedAt = Date.now();
    const normalizedQuery = normalizeQuery(request.query);
    const queryTokens = tokenize(normalizedQuery);

    // Resolve the canonical controlled keys from the repository (the
    // canonical source per the M1.1 architecture) before validating
    // any stable-key field exposed by the v1 request. The repository
    // is the only source of truth for which service categories,
    // specialties, and pricing units exist; the types package only
    // validates the structural shape of those keys.
    const controlledKeys = await this.repository.getControlledKeys();
    this.assertSupportedControlledKeys(request, controlledKeys);
    this.assertSupportedCaribbeanCodes(request);

    const repositoryInput = this.buildRepositoryInput(request);
    const candidates = await this.repository.search(repositoryInput);

    const preferenceAtoms = collectPreferenceAtoms(request.preferred);

    const ranked: RankedSeller[] = [];
    for (const seller of candidates) {
      const standalone = filterStandaloneOfferings(seller.offerings);
      if (standalone.length === 0) continue;
      const rankedOfferings = rankOfferingsForSeller(
        seller,
        standalone,
        queryTokens,
        preferenceAtoms,
      );
      if (rankedOfferings.length === 0) continue;
      const best = rankedOfferings[0]!;
      const additional = rankedOfferings.slice(1, 3);
      ranked.push({ seller, best, additional });
    }

    ranked.sort((a, b) => {
      // Primary: bounded score desc. Secondary: matched preference
      // count desc (a seller whose preferences all matched outranks a
      // seller who matched a smaller number of preferences, even when
      // the bounded score saturated at 1.0 under full text coverage).
      // Tertiary: stable sellerId asc so identical evidence produces
      // identical order. See P1-001 remediation.
      if (a.best.score !== b.best.score) return b.best.score - a.best.score;
      if (a.best.matchedAtomCount !== b.best.matchedAtomCount)
        return b.best.matchedAtomCount - a.best.matchedAtomCount;
      return a.seller.sellerId.localeCompare(b.seller.sellerId);
    });

    const results: TalentSearchResultV1[] = ranked.slice(0, 10).map((entry) => ({
      seller: toPublicSeller(entry.seller),
      bestMatchingOffering: toPublicOffering(entry.best.offering),
      additionalMatchingOfferings: entry.additional.map((ranked) =>
        toPublicOffering(ranked.offering),
      ),
      relevanceScore: clamp01(entry.best.score),
      matchReason: entry.best.reason,
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

  private assertSupportedControlledKeys(
    request: TalentSearchRequestV1,
    controlledKeys: {
      serviceCategoryKeys: ReadonlySet<string>;
      specialtyKeys: ReadonlySet<string>;
      pricingUnitKeys: ReadonlySet<string>;
    },
  ): void {
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
      (key) => !controlledKeys.serviceCategoryKeys.has(key),
    );
    if (unknownCategories.length > 0) {
      throw new TalentSearchInvalidCriteriaError(
        `Unsupported service category key(s): ${[...new Set(unknownCategories)].join(", ")}`,
      );
    }

    const unknownSpecialties = preferredSpecialtyKeys.filter(
      (key) => !controlledKeys.specialtyKeys.has(key),
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

// ---------- Preferences ----------

// A normalized representation of one preference the buyer requested. Each
// (kind, value) pair is treated as a single "atom": it is collected once
// when assembling the buyer's preference list and is matched once per
// (seller, offering) candidate. The set of atoms is what preferenceScore
// divides by. Adding a new preference axis means adding a new descriptor
// entry in PREFERENCE_ATOM_DESCRIPTORS so the collection, matching, and
// labeling rules stay co-located and exhaustive.
type PreferenceKind =
  | "category"
  | "includedService"
  | "specialty"
  | "genre"
  | "affiliation"
  | "basedInCountryCode"
  | "basedInRegion"
  | "basedInCity"
  | "serviceMode";

interface PreferenceAtom {
  readonly kind: PreferenceKind;
  readonly value: string;
}

interface PreferenceAtomDescriptor {
  readonly kind: PreferenceKind;
  // Canonicalize a raw preference value into the form the matching
  // predicate compares against. Genre tags, locality, and ISO codes
  // have per-axis case conventions; stable controlled keys
  // (category / includedService / specialty / serviceMode) are
  // returned unchanged so the schema's strict keys stay verbatim.
  readonly normalize: (raw: string) => string;
  // Extract the raw values supplied by the buyer for this axis.
  readonly rawValues: (preferred: TalentSearchPreferredCriteriaV1) => readonly string[];
  // Test whether this axis matches a (seller, offering) candidate
  // given the canonical value.
  readonly matches: (
    seller: RepositoryCandidateSeller,
    offering: RepositoryCandidateOffering,
    canonicalValue: string,
  ) => boolean;
  // Buyer-facing factual label for the canonical value.
  readonly label: (canonicalValue: string) => string;
}

const trimAndNormalizeLower = (raw: string): string => raw.trim().toLowerCase();
const trimAndNormalizeUpper = (raw: string): string => raw.trim().toUpperCase();
const identityNormalize = (raw: string): string => raw.trim();

// One typed descriptor per axis owns collection, matching, and labeling.
// Adding a new axis only requires a new entry here; the iteration order
// in collectPreferenceAtoms and the matchReason emission in
// describePreferenceMatches both walk the descriptor entries so the
// axis order is defined in exactly one place. See P2-001 remediation.
const PREFERENCE_ATOM_DESCRIPTORS: readonly PreferenceAtomDescriptor[] = [
  {
    kind: "category",
    normalize: identityNormalize,
    rawValues: (p) => p.categoryKeys ?? [],
    matches: (_seller, offering, value) => offering.primaryCategory.key === value,
    label: (value) => `preferred category: ${value}`,
  },
  {
    kind: "includedService",
    normalize: identityNormalize,
    rawValues: (p) => p.includedServiceKeys ?? [],
    matches: (_seller, offering, value) =>
      offering.includedServices.some((included) => included.key === value),
    label: (value) => `preferred bundle component: ${value}`,
  },
  {
    kind: "specialty",
    normalize: identityNormalize,
    rawValues: (p) => p.specialties ?? [],
    matches: (seller, _offering, value) => seller.specialtyKeys.includes(value),
    label: (value) => `preferred specialty: ${value}`,
  },
  {
    kind: "genre",
    normalize: trimAndNormalizeLower,
    rawValues: (p) => p.genreTags ?? [],
    matches: (_seller, offering, value) =>
      offering.genreTags.some((tag) => tag.toLowerCase() === value),
    label: (value) => `preferred genre: ${value}`,
  },
  {
    kind: "affiliation",
    normalize: trimAndNormalizeUpper,
    rawValues: (p) => p.caribbeanAffiliationCodes ?? [],
    matches: (seller, _offering, value) => seller.caribbeanAffiliationCodes.includes(value),
    label: (value) => `preferred Caribbean affiliation: ${value}`,
  },
  {
    kind: "basedInCountryCode",
    normalize: trimAndNormalizeUpper,
    rawValues: (p) => (p.basedIn?.countryCode ? [p.basedIn.countryCode] : []),
    matches: (seller, _offering, value) => seller.basedInCountryCode === value,
    label: (value) => `preferred based-in country: ${value}`,
  },
  {
    kind: "basedInRegion",
    normalize: trimAndNormalizeLower,
    rawValues: (p) => (p.basedIn?.region ? [p.basedIn.region] : []),
    matches: (seller, _offering, value) => seller.basedInRegion?.toLowerCase() === value,
    label: (value) => `preferred based-in region: ${value}`,
  },
  {
    kind: "basedInCity",
    normalize: trimAndNormalizeLower,
    rawValues: (p) => (p.basedIn?.city ? [p.basedIn.city] : []),
    matches: (seller, _offering, value) => seller.basedInCity?.toLowerCase() === value,
    label: (value) => `preferred based-in city: ${value}`,
  },
  {
    kind: "serviceMode",
    normalize: identityNormalize,
    rawValues: (p) => p.serviceModes ?? [],
    matches: (_seller, offering, value) => offering.serviceMode === value,
    label: (value) => `preferred service mode: ${value}`,
  },
];

function atomKey(atom: PreferenceAtom): string {
  return `${atom.kind}:${atom.value}`;
}

function atomLabel(atom: PreferenceAtom): string {
  const descriptor = PREFERENCE_ATOM_DESCRIPTORS.find((d) => d.kind === atom.kind);
  if (!descriptor) return atom.value;
  return descriptor.label(atom.value);
}

// Canonicalize one preference axis: trim, apply the axis-specific case
// normalization, drop empties, dedupe, and stably sort so that the
// denominator of preferenceScore and the order of labels in matchReason
// are deterministic regardless of how the buyer supplied the values.
// See P1-002 remediation.
function canonicalizeAxis(
  rawValues: readonly string[],
  normalize: (raw: string) => string,
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawValues) {
    const canonical = normalize(raw);
    if (canonical.length === 0) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out.sort();
}

function collectPreferenceAtoms(
  preferred: TalentSearchPreferredCriteriaV1 | undefined,
): readonly PreferenceAtom[] {
  if (!preferred) return [];
  const atoms: PreferenceAtom[] = [];
  // Iterate the descriptor table in canonical order so the resulting
  // atoms and labels are deterministic across identical requests
  // regardless of the order the buyer supplied fields. The descriptor
  // table owns the order; there is no parallel kind-order array.
  for (const descriptor of PREFERENCE_ATOM_DESCRIPTORS) {
    const canonical = canonicalizeAxis(descriptor.rawValues(preferred), descriptor.normalize);
    for (const value of canonical) {
      atoms.push({ kind: descriptor.kind, value });
    }
  }
  return atoms;
}

function matchPreferenceAtoms(
  seller: RepositoryCandidateSeller,
  offering: RepositoryCandidateOffering,
  atoms: readonly PreferenceAtom[],
): readonly PreferenceAtom[] {
  const matched: PreferenceAtom[] = [];
  const seen = new Set<string>();
  for (const atom of atoms) {
    if (seen.has(atomKey(atom))) continue;
    const descriptor = PREFERENCE_ATOM_DESCRIPTORS.find((d) => d.kind === atom.kind);
    if (!descriptor) continue;
    if (descriptor.matches(seller, offering, atom.value)) {
      matched.push(atom);
      seen.add(atomKey(atom));
    }
  }
  return matched;
}

// ---------- Standalone filter ----------

// A standalone offering is one whose primary category is independently
// purchasable (the buyer's "buy this directly" presentation). The contract
// prohibits presenting bundle-only matches as standalone purchases, so the
// bestMatchingOffering / additionalMatchingOfferings slots must never hold
// a bundle-only primary-category offering. The offerer's eligible
// bundle-only IncludedServices still ride along with each presented offering
// inside its `includedServices` array, where they are labeled
// `purchaseMode: "BundleOnly"` and never mistaken for standalone services.
function filterStandaloneOfferings(
  offerings: readonly RepositoryCandidateOffering[],
): readonly RepositoryCandidateOffering[] {
  return offerings.filter((offering) => !offering.primaryCategory.bundleOnly);
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

function describePreferenceMatches(matches: readonly PreferenceAtom[]): string {
  // Emit labels in canonical preference-atom order so the same canonical
  // match set produces an identical matchReason regardless of the order the
  // buyer supplied atoms in. This keeps the M1.5 determinism contract.
  // The order is defined by PREFERENCE_ATOM_DESCRIPTORS so there is no
  // parallel kind-order list to drift out of sync.
  const byKind = new Map<PreferenceKind, PreferenceAtom[]>();
  for (const atom of matches) {
    const bucket = byKind.get(atom.kind);
    if (bucket) bucket.push(atom);
    else byKind.set(atom.kind, [atom]);
  }
  const labels: string[] = [];
  for (const descriptor of PREFERENCE_ATOM_DESCRIPTORS) {
    const bucket = byKind.get(descriptor.kind);
    if (!bucket) continue;
    for (const atom of bucket) labels.push(atomLabel(atom));
  }
  return labels.join("; ");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

interface RankedOffering {
  readonly offering: RepositoryCandidateOffering;
  readonly score: number;
  // Number of canonical preference atoms that matched for this offering.
  // Carried through to the seller-level sort as a secondary tie-breaker
  // so the bounded score saturating at 1.0 under full text coverage does
  // not collapse the order onto sellerId alone. See P1-001 remediation.
  readonly matchedAtomCount: number;
  readonly reason: string;
}

function rankOfferingsForSeller(
  seller: RepositoryCandidateSeller,
  offerings: readonly RepositoryCandidateOffering[],
  queryTokens: readonly string[],
  preferenceAtoms: readonly PreferenceAtom[],
): readonly RankedOffering[] {
  const scored: RankedOffering[] = [];
  for (const offering of offerings) {
    const text = scoreOffering(offering, queryTokens);

    // textScore: matched / total distinct query tokens, or 0 when no
    // query was supplied. The score is unchanged from M1.1: a query whose
    // tokens all overlap the offering's title + primary category fields
    // produces 1.0 so the long-standing M1.1 invariant holds.
    let textScore = 0;
    if (queryTokens.length > 0) {
      textScore = text.matched / queryTokens.length;
    }

    const matchedAtoms = matchPreferenceAtoms(seller, offering, preferenceAtoms);
    const preferenceScore =
      preferenceAtoms.length === 0 ? 0 : matchedAtoms.length / preferenceAtoms.length;

    // Combined score: text coverage is the foundation; preferences can lift,
    // but the total is bounded inside [0, 1] by clamp01. The named weight
    // PREFERENCE_WEIGHT (declared at module top) keeps the additive lift
    // bounded so preference density alone cannot push the score above 1.
    // Eligibility rules (M1.5):
    //   - Structured-only path (no query): every eligible standalone
    //     offering from this seller stays in the result set.
    //   - Text path (queryTokens > 0, no preferences): an offering with
    //     zero token matches stays out. The buyer explicitly asked for a
    //     text description and there is no evidence that this offering
    //     satisfies it.
    //   - Text path with preferences: an offering surfaces when either the
    //     text or the preference set produces evidence, since per the v1
    //     contract "preferences affect ordering without excluding
    //     candidates." A buyer who combines a query with a preference
    //     therefore gets sellers whose offerings match EITHER the query
    //     OR the preference (or both), never silently fewer.
    if (queryTokens.length > 0 && text.matched === 0 && matchedAtoms.length === 0) {
      continue;
    }

    const combinedScore = textScore + PREFERENCE_WEIGHT * preferenceScore;
    const reasonParts: string[] = [];
    if (text.matched > 0) {
      reasonParts.push(describeMatch(text.fields));
    }
    if (matchedAtoms.length > 0) {
      reasonParts.push(describePreferenceMatches(matchedAtoms));
    }
    const reason = reasonParts.length > 0 ? reasonParts.join("; ") : "eligible standalone offering";

    scored.push({
      offering,
      score: clamp01(combinedScore),
      matchedAtomCount: matchedAtoms.length,
      reason,
    });
  }
  // Stable three-key sort: score desc, matched-preference-atom count
  // desc, then offeringId asc. The matchedAtomCount tie-breaker keeps
  // preferences order-significant at full text coverage where the
  // bounded score saturates at 1.0; see P1-001 remediation.
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.matchedAtomCount !== b.matchedAtomCount) return b.matchedAtomCount - a.matchedAtomCount;
    return a.offering.offeringId.localeCompare(b.offering.offeringId);
  });
  return scored;
}

interface RankedSeller {
  readonly seller: RepositoryCandidateSeller;
  readonly best: RankedOffering;
  readonly additional: readonly RankedOffering[];
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
