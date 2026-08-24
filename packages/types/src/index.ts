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

// Factual coverage counts shared by the preference-atom coverage and the
// normalized-query-token coverage response fields. Both fields have
// identical shape, strictness, integer bounds, and `matched <= total`
// refinement, so the schema is declared once here as a non-exported
// internal record and re-exported under semantically named aliases.
// P2-001 deduplication: a parallel handwritten copy of this schema
// would inevitably drift; the aliases keep the public surface stable
// while leaving a single source of truth for the validation.
const coverageCountsV1Schema = z
  .object({
    matched: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.matched <= value.total, {
    message: "matched must not exceed total",
  });

// Factual coverage of the buyer's preference atoms against the best matching
// offering's matched atoms. The matched count is bounded by `total` and both
// are computed from the canonical preference atoms and the deterministic
// matcher (never derived from `relevanceScore`, which is strategy-specific
// ordering and explicitly NOT a buyer-facing confidence signal).
//
// Optional in the public DTO so adding the field is backward-compatible
// per the v1 contract's compatibility rules. Older clients see a response
// without the field and the UI falls back to `matchReason` evidence only
// (P1-002 remediation).
export const preferenceCoverageV1Schema = coverageCountsV1Schema;
export type PreferenceCoverageV1 = z.infer<typeof coverageCountsV1Schema>;

// Factual coverage of the buyer's normalized query tokens against the
// best matching offering's matched text fields. The matched count is
// bounded by `total` and both are computed from the canonical
// distinct-query-tokens set and the deterministic text matcher (never
// derived from `relevanceScore`, which is strategy-specific ordering
// and explicitly NOT a buyer-facing confidence signal).
//
// Optional in the public DTO so adding the field is backward-compatible
// per the v1 contract's compatibility rules. Older clients see a response
// without the field and the UI falls back to `matchReason` evidence only.
// Emitted whenever the buyer supplied a usable query (at least one
// distinct canonical token); omitted when the request had no query, in
// which case `textCoverage.total` would be `0` and the resulting "0 of
// 0" statement is not factual evidence. Persisted separately from
// `preferenceCoverage` so a request that supplies both a query and
// preferences carries both factual-evidence lines.
export const textCoverageV1Schema = coverageCountsV1Schema;
export type TextCoverageV1 = z.infer<typeof coverageCountsV1Schema>;

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
    preferenceCoverage: preferenceCoverageV1Schema.optional(),
    textCoverage: textCoverageV1Schema.optional(),
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

// ---------- Public metadata envelope ----------
//
// The canonical category catalog returned by `GET /api/metadata/categories`.
// The browser NEVER holds a second list of category keys; it parses the
// response against this shared Zod schema before rendering the option
// list. Unknown fields and malformed elements are rejected so a contract
// mismatch can never silently populate the page.
const categoryMetadataItemV1Schema = z
  .object({
    key: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
  })
  .strict();

export const categoryMetadataResponseV1Schema = z
  .object({
    categories: z.array(categoryMetadataItemV1Schema).max(200),
  })
  .strict();
export type CategoryMetadataItemV1 = z.infer<typeof categoryMetadataItemV1Schema>;
export type CategoryMetadataResponseV1 = z.infer<typeof categoryMetadataResponseV1Schema>;

// ---------- Standard error envelope ----------

export const apiErrorCodeV1Schema = z.enum([
  "INVALID_JSON",
  "INVALID_SEARCH_CRITERIA",
  "UNSUPPORTED_MEDIA_TYPE",
  "SEARCH_RATE_LIMITED",
  "SEARCH_FAILED",
  "SEARCH_UNAVAILABLE",
  // Buildathon Golden Slice 1 error codes. Each code maps to a stable
  // HTTP status via buildSafeError's switch table and to a buyer-safe
  // message. The codes never expose provider subjects, raw tokens,
  // session ids, or membership internals.
  "INVALID_AUTH_REQUEST",
  "AUTH_RATE_LIMITED",
  "AUTH_FAILED",
  "AUTH_PROVIDER_UNAVAILABLE",
  "SESSION_INVALID",
  "SESSION_EXPIRED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_INELIGIBLE",
  "NOT_A_MEMBER",
  "MISSING_CAPABILITY",
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
//
// The canonical service categories, specialties, and pricing units
// live in PostgreSQL (seeded by packages/db/prisma/seed.ts). The
// @soundhub/types package does NOT maintain a parallel list of those
// keys. Closed behavioral enums (the next block) remain shared
// Zod/Prisma values per the accepted architecture, but the canonical
// catalog of which categories, specialties, and pricing units exist
// is resolved by the application-layer repository from PostgreSQL.

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

// ===========================================================================
// Buildathon Golden Slice 1 (BG1) shared runtime contracts.
//
// These schemas cover the identity, session, and acting-Workspace
// surfaces. They follow the same patterns as the v1 search contract:
// shared Zod is the executable contract; TypeScript types are inferred
// from it; the same schema is consumed by the Express route validator
// and the browser response parser. No Prisma model or raw provider
// subject ever crosses a public DTO.
//
// Per ticket #59, the GS 1 / GS 2 / GS 3 / GS 4 / GS 5 / GS 6
// requirements are:
//
//   GS 1 — preserve the buildathon-only governance boundary.
//   GS 2 — deployed managed magic-link auth with the bounded fallback.
//   GS 3 — both adapters map credentials to persisted UserAccounts and
//          produce server-validated sessions through the same boundary.
//   GS 4 — every Golden Slice command names an acting Workspace and
//          rejects a human without a current qualifying membership.
//   GS 5 — a matching legacy Workspace.ownerUserId grants no authority
//          without current membership.
//   GS 6 — buyer/seller Workspaces, capabilities, and memberships are
//          persisted (no DealApprover authorization here; BG5 owns it).
//
// ===========================================================================

// ---------- Magic link request ----------

// SoundHub always uses neutral responses: the request envelope returns
// the same shape whether the email is registered or not, so the public
// surface cannot be used to enumerate accounts. The deterministic
// adapter adds a non-production `devVerificationUrl` for the
// integration test and emergency fallback paths; managed providers omit
// it because the real email delivery happens on the provider side.
export const bg1MagicLinkRequestV1Schema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("email must be a valid email address")
      .max(254, "email must be at most 254 characters"),
    // Optional human-friendly hint carried into the session metadata
    // for diagnostics. Never returned to other members.
    displayName: z.string().min(1).max(120).optional(),
  })
  .strict();
export type Bg1MagicLinkRequestV1 = z.infer<typeof bg1MagicLinkRequestV1Schema>;

export const bg1MagicLinkResponseV1Schema = z
  .object({
    // Neutral acknowledgement. `ok` is always true on a well-formed
    // request; rate-limited or otherwise rejected requests produce the
    // standard safe error envelope instead.
    ok: z.literal(true),
    // Deterministic-adapter only: a one-time verification URL that the
    // browser can follow in the absence of email delivery. Production
    // Supabase magic-link emails render this field absent. The contract
    // documents the field name verbatim so a contract-drift detector
    // can catch a managed adapter that begins leaking the verification
    // URL to production.
    devVerificationUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type Bg1MagicLinkResponseV1 = z.infer<typeof bg1MagicLinkResponseV1Schema>;

// ---------- Verify token ----------

export const bg1VerifyTokenRequestV1Schema = z
  .object({
    requestId: z.string().min(1).max(256),
  })
  .strict();
export type Bg1VerifyTokenRequestV1 = z.infer<typeof bg1VerifyTokenRequestV1Schema>;

// The verify-token response is what the server returns when a magic-link
// verification succeeds. The HttpOnly session cookie is set on the
// response side (not part of the body) so the client cannot read the
// session id; this body contains only allow-listed identity and
// membership facts the client needs to render the post-sign-in state.
export const bg1PublicWorkspaceV1Schema = z
  .object({
    workspaceId: z.string().min(1).max(128),
    slug: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    workspaceType: z.enum(["Personal", "Organization"]),
    workspaceStatus: z.enum(["Active", "Suspended"]),
    capabilities: z
      .array(z.enum(["Buyer", "Seller"]))
      .min(1)
      .max(8),
  })
  .strict();
export type Bg1PublicWorkspaceV1 = z.infer<typeof bg1PublicWorkspaceV1Schema>;

export const bg1PublicUserV1Schema = z
  .object({
    userAccountId: z.string().min(1).max(128),
    // The primary SoundHub-owned email, when present. May be absent if
    // the identity provider does not surface an email and the user has
    // not set one explicitly. Per ADR 0004 the email is private; it
    // never enters the public seller contract and the workspace UI is
    // the only place it appears (for the signed-in user themselves).
    email: z.string().email().nullable(),
    displayName: z.string().min(1).max(120).nullable(),
    identityProvider: z.string().min(1).max(64),
    identitySubject: z.string().min(1).max(256),
    workspaces: z.array(bg1PublicWorkspaceV1Schema).max(64),
  })
  .strict();
export type Bg1PublicUserV1 = z.infer<typeof bg1PublicUserV1Schema>;

export const bg1VerifyTokenResponseV1Schema = z
  .object({
    ok: z.literal(true),
    user: bg1PublicUserV1Schema,
  })
  .strict();
export type Bg1VerifyTokenResponseV1 = z.infer<typeof bg1VerifyTokenResponseV1Schema>;

// ---------- Current session info ----------

export const bg1SessionInfoV1Schema = z
  .object({
    // Null when the request carries no valid session cookie. Otherwise
    // the user the cookie authenticates, plus the workspaces they
    // currently belong to. The acting workspace is NOT in this
    // payload: per GS 4 every consequential command must carry the
    // acting workspace explicitly, so the UI chooses a workspace and
    // passes it on the command itself rather than persisting it on the
    // session.
    user: bg1PublicUserV1Schema.nullable(),
  })
  .strict();
export type Bg1SessionInfoV1 = z.infer<typeof bg1SessionInfoV1Schema>;

// ---------- Sign out ----------

export const bg1SignOutResponseV1Schema = z
  .object({
    ok: z.literal(true),
  })
  .strict();
export type Bg1SignOutResponseV1 = z.infer<typeof bg1SignOutResponseV1Schema>;

// ---------- Sample consequential command (acts as a Workspace) ----------
//
// The Buildathon Golden Slice ticket (#59) requires that
// consequential command contracts identify an acting Workspace and use
// a reusable current-membership authorization service. This is the
// minimal sample contract used to demonstrate that property at the
// HTTP boundary and in the focused authorization tests. Real
// ProjectRequest, Deal, TermsVersion, and approval commands will be
// authored against the same pattern in later tickets; this sample is
// sufficient to satisfy GS 4 / GS 5 / GS 6 today.
export const bg1ActingWorkspaceRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
  })
  .strict();
export type Bg1ActingWorkspaceRequestV1 = z.infer<typeof bg1ActingWorkspaceRequestV1Schema>;

export const bg1ActingWorkspaceResponseV1Schema = z
  .object({
    ok: z.literal(true),
    actingWorkspace: bg1PublicWorkspaceV1Schema,
    membership: z
      .object({
        role: z.enum(["Owner", "Admin", "Member"]),
        joinedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();
export type Bg1ActingWorkspaceResponseV1 = z.infer<typeof bg1ActingWorkspaceResponseV1Schema>;

// ---------- Stable provider keys exposed for runtime validation ----------
//
// The provider keys are a closed enum so a future provider can only be
// added by editing this contract and the adapter factory together.
// SoundHub owns these keys; provider SDKs never read them.
export const bg1IdentityProviderV1Values = ["managed-magic-link", "deterministic"] as const;
export type Bg1IdentityProviderV1 = (typeof bg1IdentityProviderV1Values)[number];
