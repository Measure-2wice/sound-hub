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

// Trim a string and reject it if it is empty after trimming. Used to
// normalize location fields and array elements before length validation.
const trimmedNonEmptyString = (minLength: number, maxLength: number, label: string) =>
  z
    .string()
    .max(maxLength, `${label} must be at most ${maxLength} characters`)
    .transform((value, ctx) => {
      const trimmed = value.trim();
      if (trimmed.length < minLength) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be at least ${minLength} non-whitespace character(s) after normalization`,
        });
        return z.NEVER;
      }
      return trimmed;
    });

// Bounded string array. Each element is trimmed, deduped, and
// rejected (ZodError) if it does not meet `minLength` after trimming.
// An empty input collapses to `undefined` so downstream usability
// checks ignore "no criteria" arrays.
const optionalBoundedStringArray = (minLength: number, maxLength: number, label: string) =>
  z
    .array(
      z
        .string()
        .max(maxLength, `${label} elements must be at most ${maxLength} characters`)
        .transform((value, ctx) => {
          const trimmed = value.trim();
          if (trimmed.length < minLength) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `${label} contains an element shorter than ${minLength} non-whitespace character(s) after normalization`,
            });
            return z.NEVER;
          }
          return trimmed;
        }),
    )
    .max(50, `${label} must contain at most 50 elements`)
    .transform((values) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
      return out;
    })
    .transform((arr) => (arr.length === 0 ? undefined : arr))
    .optional();

// ISO 3166-1 alpha-2 country code (uppercase). The contract only
// validates the shape; whether a specific code is a supported Caribbean
// affiliation is an application-layer concern.
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

// Location fields are normalized (trimmed) before min-length validation
// and rejected if they are empty after normalization. The location
// filter as a whole is also rejected if all three fields normalize to
// empty/missing values.
const trimmedCitySchema = trimmedNonEmptyString(1, 120, "city");
const trimmedRegionSchema = trimmedNonEmptyString(1, 120, "region");
const trimmedCountryCodeSchema = trimmedNonEmptyString(2, 2, "countryCode").refine(
  (value) => /^[A-Z]{2}$/.test(value),
  { message: "countryCode must be a 2-letter ISO alpha-2 code" },
);

const locationFilterV1Schema = z
  .object({
    city: trimmedCitySchema.optional(),
    region: trimmedRegionSchema.optional(),
    countryCode: trimmedCountryCodeSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.city === undefined && value.region === undefined && value.countryCode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "location filter must contain at least one of city, region, countryCode",
      });
    }
  });
export type LocationFilterV1 = z.infer<typeof locationFilterV1Schema>;

// ---------- Required criteria ----------

export const talentSearchRequiredCriteriaV1Schema = z
  .object({
    primaryCategoryKeys: optionalBoundedStringArray(1, 64, "primaryCategoryKeys"),
    independentlyPurchasableServiceKeys: optionalBoundedStringArray(
      1,
      64,
      "independentlyPurchasableServiceKeys",
    ),
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
    categoryKeys: optionalBoundedStringArray(1, 64, "categoryKeys"),
    includedServiceKeys: optionalBoundedStringArray(1, 64, "includedServiceKeys"),
    specialties: optionalBoundedStringArray(1, 64, "specialties"),
    genreTags: optionalBoundedStringArray(1, 64, "genreTags"),
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

// ---------- Stable controlled keys exposed for runtime validation ----------

const SERVICE_CATEGORIES_FOR_KEYS = [
  { key: "music-production" },
  { key: "songwriting" },
  { key: "custom-composition" },
  { key: "session-vocals" },
  { key: "session-instrument-performance" },
  { key: "featured-artist-performance" },
  { key: "mixing" },
  { key: "mastering" },
  { key: "recording-engineering" },
  { key: "live-performance" },
] as const;

export const SUPPORTED_SERVICE_CATEGORY_KEYS = SERVICE_CATEGORIES_FOR_KEYS.map((c) => c.key);

export const SUPPORTED_SPECIALTY_KEYS = [
  "Artist",
  "Producer",
  "Musician",
  "Songwriter",
  "SoundEngineer",
] as const;
export type SupportedSpecialtyKey = (typeof SUPPORTED_SPECIALTY_KEYS)[number];

export const SUPPORTED_PRICING_UNIT_KEYS = [
  "hour",
  "track",
  "project",
  "session",
  "event",
  "day",
] as const;
export type SupportedPricingUnitKey = (typeof SUPPORTED_PRICING_UNIT_KEYS)[number];

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

// ---------- Stable-controlled-key classification ----------

/**
 * Stable-controlled keys the application layer validates against the
 * canonical seeded records. Unknown keys in any of these lists produce
 * INVALID_SEARCH_CRITERIA rather than empty results.
 */
export type SupportedServiceCategoryKey = (typeof SUPPORTED_SERVICE_CATEGORY_KEYS)[number];

export function isSupportedServiceCategoryKey(key: string): key is SupportedServiceCategoryKey {
  return (SUPPORTED_SERVICE_CATEGORY_KEYS as readonly string[]).includes(key);
}

export function isSupportedSpecialtyKey(key: string): key is SupportedSpecialtyKey {
  return (SUPPORTED_SPECIALTY_KEYS as readonly string[]).includes(key);
}

export function isSupportedPricingUnitKey(key: string): key is SupportedPricingUnitKey {
  return (SUPPORTED_PRICING_UNIT_KEYS as readonly string[]).includes(key);
}
