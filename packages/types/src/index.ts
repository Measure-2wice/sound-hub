// Milestone 1: Database-Backed Talent and Offering Search
//
// Shared runtime contract. Zod schemas are the executable contract; TypeScript
// types are inferred from them. The same schemas are used by the API request
// validator and by the web response parser, so the browser, the server, and the
// contract document cannot drift.
//
// The contract version is `v1`. See docs/contracts/search-api.md.

import { z } from "zod";

// ---------- Helpers ----------

// Bounded string array: trims, dedupes, and rejects empty/whitespace-only
// elements. An empty input collapses to `undefined` so that downstream
// usability checks ignore "no criteria" arrays.
const boundedStringArray = (minLength: number, maxLength: number) =>
  z
    .array(z.string().min(1).max(maxLength))
    .max(50, "array is too long")
    .transform((values) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const value of values) {
        const trimmed = value.trim();
        if (trimmed.length < minLength) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
      }
      return out;
    });

const optionalBoundedStringArray = (minLength: number, maxLength: number) =>
  boundedStringArray(minLength, maxLength)
    .transform((arr) => (arr.length === 0 ? undefined : arr))
    .optional();

// ISO 3166-1 alpha-2 country code (uppercase). The contract only validates
// the shape; whether a specific code is a supported Caribbean affiliation is
// an application-layer concern.
const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "countryCode must be a 2-letter ISO alpha-2 code");

// ---------- Service mode (closed behavior state) ----------

export const serviceModeSchema = z.enum(["Remote", "InPerson", "Hybrid"]);
export type ServiceMode = z.infer<typeof serviceModeSchema>;

// ---------- Pricing ----------

export const pricingKindSchema = z.enum(["StartingAt", "Fixed", "ContactForQuote"]);
export type PricingKind = z.infer<typeof pricingKindSchema>;

const moneyV1Schema = z.object({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO 4217 code"),
});
export type MoneyV1 = z.infer<typeof moneyV1Schema>;

export const pricingSummaryV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("StartingAt"),
    amount: moneyV1Schema,
    unit: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal("Fixed"),
    amount: moneyV1Schema,
    unit: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal("ContactForQuote"),
  }),
]);
export type PricingSummaryV1 = z.infer<typeof pricingSummaryV1Schema>;

// ---------- Location filter ----------

const locationFilterV1Schema = z
  .object({
    city: z.string().min(1).max(120).optional(),
    region: z.string().min(1).max(120).optional(),
    countryCode: countryCodeSchema.optional(),
  })
  .strict();
export type LocationFilterV1 = z.infer<typeof locationFilterV1Schema>;

// ---------- Required criteria ----------

export const talentSearchRequiredCriteriaV1Schema = z
  .object({
    primaryCategoryKeys: optionalBoundedStringArray(1, 64),
    independentlyPurchasableServiceKeys: optionalBoundedStringArray(1, 64),
    serviceModes: z
      .array(serviceModeSchema)
      .max(8)
      .transform((arr) => (arr.length === 0 ? undefined : arr))
      .optional(),
    basedIn: locationFilterV1Schema.optional(),
    serviceArea: locationFilterV1Schema.optional(),
  })
  .strict();
export type TalentSearchRequiredCriteriaV1 = z.infer<typeof talentSearchRequiredCriteriaV1Schema>;

// ---------- Preferred criteria ----------

export const talentSearchPreferredCriteriaV1Schema = z
  .object({
    categoryKeys: optionalBoundedStringArray(1, 64),
    includedServiceKeys: optionalBoundedStringArray(1, 64),
    specialties: optionalBoundedStringArray(1, 64),
    genreTags: optionalBoundedStringArray(1, 64),
    caribbeanAffiliationCodes: z
      .array(countryCodeSchema)
      .max(20)
      .transform((arr) => (arr.length === 0 ? undefined : arr))
      .optional(),
    basedIn: locationFilterV1Schema.optional(),
    serviceModes: z
      .array(serviceModeSchema)
      .max(8)
      .transform((arr) => (arr.length === 0 ? undefined : arr))
      .optional(),
  })
  .strict();
export type TalentSearchPreferredCriteriaV1 = z.infer<typeof talentSearchPreferredCriteriaV1Schema>;

// ---------- Request ----------

// Normalized query: trimmed, internal whitespace collapsed, lowercased,
// surrounding punctuation stripped. A purely punctuation-only string
// collapses to the empty string and fails the usability check.
const normalizedQuerySchema = z
  .string()
  .max(500, "query must be at most 500 characters")
  .transform((value) => value.trim().replace(/\s+/g, " ").toLowerCase())
  .transform((value) => value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
  .refine((value) => /[\p{L}\p{N}]/u.test(value), {
    message: "query must contain at least one letter or digit after normalization",
  })
  .refine((value) => value.length >= 2, {
    message: "query must be at least 2 characters after normalization",
  });

// A request is usable when at least one of `query`, `required`, or `preferred`
// has a meaningful value. The refinement enforces the contract rule.
export const talentSearchRequestV1Schema = z
  .object({
    query: normalizedQuerySchema.optional(),
    required: talentSearchRequiredCriteriaV1Schema.optional(),
    preferred: talentSearchPreferredCriteriaV1Schema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasQuery = typeof value.query === "string" && value.query.length >= 2;
    const hasRequired = value.required ? isUsable(value.required) : false;
    const hasPreferred = value.preferred ? isUsable(value.preferred) : false;
    if (!(hasQuery || hasRequired || hasPreferred)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one of query, required, or preferred must contain criteria",
      });
    }
  });
export type TalentSearchRequestV1 = z.infer<typeof talentSearchRequestV1Schema>;

// Recursively treats a value as "usable" if it has a non-empty string,
// a non-empty array, or a nested object that itself is usable. Empty
// arrays, empty objects, and undefined values are not usable.
function isUsable(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(isUsable);
  }
  return false;
}

// ---------- Public seller summary ----------

export const publicSellerSummaryV1Schema = z
  .object({
    sellerId: z.string().min(1),
    professionalName: z.string().min(1).max(200),
    specialties: z.array(z.string().min(1).max(64)).max(20),
    bio: z.string().max(2000),
    basedIn: z.object({
      city: z.string().min(1).max(120).optional(),
      region: z.string().min(1).max(120).optional(),
      countryCode: countryCodeSchema,
    }),
    caribbeanAffiliationCodes: z.array(countryCodeSchema).max(20),
    avatarUrl: z.string().url().optional(),
  })
  .strict();
export type PublicSellerSummaryV1 = z.infer<typeof publicSellerSummaryV1Schema>;

// ---------- Public offering summary ----------

const includedServiceV1Schema = z
  .object({
    key: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    purchaseMode: z.literal("BundleOnly"),
  })
  .strict();

const serviceAreaV1Schema = z
  .object({
    city: z.string().min(1).max(120).optional(),
    region: z.string().min(1).max(120).optional(),
    countryCode: countryCodeSchema,
  })
  .strict();

export const publicOfferingSummaryV1Schema = z
  .object({
    offeringId: z.string().min(1),
    title: z.string().min(1).max(200),
    description: z.string().max(4000),
    primaryCategory: z
      .object({
        key: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
      })
      .strict(),
    includedServices: z.array(includedServiceV1Schema).max(20),
    genreTags: z.array(z.string().min(1).max(64)).max(50),
    serviceMode: serviceModeSchema,
    serviceAreas: z.array(serviceAreaV1Schema).max(20),
    pricing: pricingSummaryV1Schema.optional(),
  })
  .strict();
export type PublicOfferingSummaryV1 = z.infer<typeof publicOfferingSummaryV1Schema>;

// ---------- Result and response ----------

export const talentSearchResultV1Schema = z
  .object({
    seller: publicSellerSummaryV1Schema,
    bestMatchingOffering: publicOfferingSummaryV1Schema,
    additionalMatchingOfferings: z.array(publicOfferingSummaryV1Schema).max(2),
    relevanceScore: z
      .number()
      .min(0, "relevanceScore must be at least 0")
      .max(1, "relevanceScore must be at most 1")
      .finite(),
    matchReason: z.string().min(1).max(500),
  })
  .strict();
export type TalentSearchResultV1 = z.infer<typeof talentSearchResultV1Schema>;

export const talentSearchStrategyV1Schema = z.literal("postgres-text-v1");
export type TalentSearchStrategyV1 = z.infer<typeof talentSearchStrategyV1Schema>;

export const talentSearchResponseV1Schema = z
  .object({
    results: z.array(talentSearchResultV1Schema).max(10),
    metadata: z
      .object({
        normalizedQuery: z.string().min(2).max(500).optional(),
        totalResults: z.number().int().nonnegative(),
        processingTimeMs: z.number().int().nonnegative(),
        strategy: talentSearchStrategyV1Schema,
        appliedRequiredCriteria: talentSearchRequiredCriteriaV1Schema,
        appliedPreferredCriteria: talentSearchPreferredCriteriaV1Schema,
      })
      .strict(),
  })
  .strict();
export type TalentSearchResponseV1 = z.infer<typeof talentSearchResponseV1Schema>;

// ---------- Standard error envelope ----------

export const apiErrorCodeV1Schema = z.enum([
  "INVALID_JSON",
  "INVALID_SEARCH_CRITERIA",
  "UNSUPPORTED_MEDIA_TYPE",
  "SEARCH_RATE_LIMITED",
  "SEARCH_FAILED",
  "SEARCH_UNAVAILABLE",
]);
export type ApiErrorCodeV1 = z.infer<typeof apiErrorCodeV1Schema>;

export const apiFieldErrorV1Schema = z
  .object({
    path: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type ApiFieldErrorV1 = z.infer<typeof apiFieldErrorV1Schema>;

export const apiErrorResponseV1Schema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeV1Schema,
        message: z.string().min(1).max(500),
        fields: z.array(apiFieldErrorV1Schema).max(50).optional(),
        requestId: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();
export type ApiErrorResponseV1 = z.infer<typeof apiErrorResponseV1Schema>;

// ---------- Supported Caribbean affiliation codes ----------
//
// The application layer validates the user's `preferred` Caribbean
// affiliation codes against this canonical set. Unknown codes return
// INVALID_SEARCH_CRITERIA, not empty results.
export const SUPPORTED_CARIBBEAN_AFFILIATION_CODES = [
  "AG",
  "BB",
  "BS",
  "BZ",
  "DM",
  "DO",
  "GD",
  "GY",
  "HT",
  "JM",
  "KN",
  "LC",
  "SR",
  "TT",
  "VC",
] as const;
export type SupportedCaribbeanAffiliationCode =
  (typeof SUPPORTED_CARIBBEAN_AFFILIATION_CODES)[number];

export function isSupportedCaribbeanAffiliationCode(
  code: string,
): code is SupportedCaribbeanAffiliationCode {
  return (SUPPORTED_CARIBBEAN_AFFILIATION_CODES as readonly string[]).includes(code);
}

// ---------- Closed Prisma enum surfaces (for drift testing) ----------
//
// These mirror the values used by the Prisma enums in packages/db/prisma/schema.prisma.
// The drift test compares them at module load time and fails fast if the
// persistence layer and the public contract diverge.

export const workspaceTypeValuesV1 = ["Personal", "Organization"] as const;
export type WorkspaceTypeV1 = (typeof workspaceTypeValuesV1)[number];
export const workspaceStatusValuesV1 = ["Active", "Suspended"] as const;
export type WorkspaceStatusV1 = (typeof workspaceStatusValuesV1)[number];
export const workspaceMembershipRoleValuesV1 = ["Owner", "Admin", "Member"] as const;
export type WorkspaceMembershipRoleV1 = (typeof workspaceMembershipRoleValuesV1)[number];
export const marketplaceCapabilityValuesV1 = ["Buyer", "Seller"] as const;
export type MarketplaceCapabilityV1 = (typeof marketplaceCapabilityValuesV1)[number];
export const sellerProfileStatusValuesV1 = ["Draft", "Published", "Suspended"] as const;
export type SellerProfileStatusV1 = (typeof sellerProfileStatusValuesV1)[number];
export const serviceOfferingStatusValuesV1 = ["Draft", "Active", "Paused", "Archived"] as const;
export type ServiceOfferingStatusV1 = (typeof serviceOfferingStatusValuesV1)[number];
export const serviceModeValuesV1 = ["Remote", "InPerson", "Hybrid"] as const;
export type ServiceModeV1 = (typeof serviceModeValuesV1)[number];
export const pricingKindValuesV1 = ["StartingAt", "Fixed", "ContactForQuote"] as const;
export type PricingKindV1 = (typeof pricingKindValuesV1)[number];
export const purchaseModeValuesV1 = ["BundleOnly"] as const;
export type PurchaseModeV1 = (typeof purchaseModeValuesV1)[number];
