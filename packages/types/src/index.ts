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
  // Buildathon Golden Slice 3 error codes. Matchmaker-specific
  // codes share the same status-code table; the route layer maps
  // each to a buyer-safe message that never leaks provider
  // internals, AI raw output, or session material.
  "MATCHMAKER_INVALID_REQUEST",
  "MATCHMAKER_AI_UNAVAILABLE",
  "MATCHMAKER_FAILED",
  "BRIEF_NOT_FOUND",
  "BRIEF_FORBIDDEN",
  // Buildathon Golden Slice 2 (BG2) error codes. Each code maps to a
  // stable HTTP status via `mapStatus` and to a buyer-safe message.
  // They cover the seller-audio slice only; existing codes are
  // unchanged.
  "AUDIO_OFFERING_NOT_FOUND",
  "AUDIO_OFFERING_INELIGIBLE",
  "AUDIO_SAMPLE_NOT_FOUND",
  "AUDIO_SAMPLE_LIMIT_EXCEEDED",
  "AUDIO_CONTENT_TYPE_UNSUPPORTED",
  "AUDIO_PAYLOAD_TOO_LARGE",
  "AUDIO_PAYLOAD_MISSING",
  "AUDIO_PROVIDER_UNAVAILABLE",
  "AUDIO_STORAGE_FAILED",
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

// ---------- Polkadot Escrow Contract Schemas & Types ----------

export const escrowStateValuesV1 = [
  "Funded",
  "Disputed",
  "Released",
  "Refunded",
  "Unknown",
] as const;
export type EscrowStateV1 = (typeof escrowStateValuesV1)[number];
export const escrowStateV1Schema = z.enum(escrowStateValuesV1);

export const createEscrowRequestV1Schema = z.object({
  provider: z.string().min(1, "provider address is required"),
  arbitrator: z.string().optional(),
  duration: z.number().int().positive("duration must be a positive integer"),
  value: z.string().optional(),
});
export type CreateEscrowRequestV1 = z.infer<typeof createEscrowRequestV1Schema>;

export const createEscrowResponseV1Schema = z.object({
  contractAddress: z.string(),
  blockHash: z.string(),
});
export type CreateEscrowResponseV1 = z.infer<typeof createEscrowResponseV1Schema>;

export const escrowStateResponseV1Schema = z.object({
  address: z.string(),
  state: escrowStateV1Schema,
});
export type EscrowStateResponseV1 = z.infer<typeof escrowStateResponseV1Schema>;

export const escrowActionResponseV1Schema = z.object({
  address: z.string(),
  action: z.string(),
  blockHash: z.string(),
  state: escrowStateV1Schema.optional(),
});
export type EscrowActionResponseV1 = z.infer<typeof escrowActionResponseV1Schema>;

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
    // Public correlation id for the magic-link request (per ticket
    // #59 P2-001). This value is observability only; it is NOT a
    // verification credential. The managed adapter returns a
    // SoundHub-side UUID and never reads it back; the deterministic
    // adapter returns its own correlation id and keys its pending
    // request under a separate private `verificationToken`. A browser
    // that round-trips this value to `/api/auth/verify-token` is
    // rejected as an unknown credential.
    requestId: z.string().min(1).max(256),
    // Deterministic-adapter operator-mode only: a one-time
    // verification URL that the operator-driven recovery UI can
    // follow in the absence of email delivery. Production Supabase
    // magic-link emails render this field absent; the deployed
    // deterministic fallback also renders it absent so an
    // unauthenticated browser cannot choose a demo identity by
    // email. The contract documents the field name verbatim so a
    // contract-drift detector can catch an adapter that begins
    // leaking the verification URL to a deployed browser.
    devVerificationUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type Bg1MagicLinkResponseV1 = z.infer<typeof bg1MagicLinkResponseV1Schema>;

// ---------- Verify token ----------
//
// The verify-token request carries the **private one-time verification
// credential** extracted from the magic-link callback URL — NOT a
// public correlation id. The BG1 provider-neutral contract requires
// distinct names for the two values so a future adapter cannot
// accidentally substitute one for the other (ticket #59 P2-001):
//
//   - `requestId` is the **public correlation id** returned in the
//     magic-link response and carried into logs and observability.
//     It is never a credential and cannot be used to mint a session.
//   - `verificationToken` is the **private one-time credential** the
//     browser extracts from the email callback URL (or the dev
//     recovery workflow reads from the server log). It is the only
//     value `verifySignIn` accepts. It MUST NEVER appear in public
//     DTOs, error envelopes, or log lines.
export const bg1VerifyTokenRequestV1Schema = z
  .object({
    verificationToken: z.string().min(1).max(512),
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
    // The provider key is exposed to the signed-in user so they can
    // understand how SoundHub authenticated them, but the provider
    // subject NEVER crosses a public DTO (privacy boundary). Provider
    // claims, roles, and metadata never identify or authorize a
    // Workspace — only the server-validated UserAccount does.
    identityProvider: z.string().min(1).max(64),
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

// ---------- Shared deterministic subject derivation ----------
//
// The deterministic identity adapter and the seed must agree on the
// provider subject derived from an email. Otherwise the seeded
// IdentityProvider row for a demo account never matches the row the
// adapter looks up at sign-in, and a second UserAccount is created
// for the same email.
//
// The derivation is intentionally opaque (a SHA-256 hash). It is
// scoped per-provider so a future migration to a different adapter
// cannot accidentally resolve to the same subject for an unrelated
// email. The hash function is injected so this contract lives in
// `@soundhub/types` (no Node-only imports) while every consumer
// passes Node `crypto.createHash` or an equivalent WebCrypto digest.
export type Sha256HexFn = (input: string) => string;

export function deriveDeterministicSubject(email: string, sha256Hex: Sha256HexFn): string {
  return sha256Hex(`deterministic|${email.trim().toLowerCase()}`);
}

// ===========================================================================
// Matchmaker shared runtime contracts (introduced by ticket #60
// / BG3 of the Buildathon Golden Slice).
//
// These schemas cover the Matchmaker slice: natural-language
// ProjectBrief submission, validated search criteria, evidence-
// grounded recommendations, and the AI provider provenance trail.
// They follow the same patterns as the v1 search contract: shared
// Zod is the executable contract; TypeScript types are inferred
// from it; the same schema is consumed by the API route validator
// and the browser response parser. No Prisma model, AI raw output,
// provider subject, or storage key ever crosses a public DTO.
//
// Per ticket #60, the GS 13 / GS 14 / GS 15 requirements are:
//
//   GS 13 — the required golden brief proceeds directly to runtime-
//           validated search criteria without clarification.
//   GS 14 — required constraints are never silently relaxed.
//   GS 15 — displayed recommendations and explanations refer only to
//           returned sellers, ServiceOfferings, and factual match
//           evidence.
//
// The Matchmaker never queries Prisma directly; AI output is parsed
// through a strict schema before use and falls back to a
// deterministic interpretation that crosses the same validation and
// TalentSearchService boundaries.
//
// ===========================================================================

// ---------- AI provider provenance ----------

// Stable provider keys for the Matchmaker AI boundary. SoundHub
// owns these keys; provider SDKs never read them. Adding a new
// provider requires editing this enum and the adapter factory
// together.
export const aiProviderV1Values = ["managed", "deterministic-fallback"] as const;
export type AiProviderV1 = (typeof aiProviderV1Values)[number];

// ---------- Brief submission ----------

// The buyer's raw, natural-language ProjectBrief text. The route
// layer trims and collapses internal whitespace; the schema only
// enforces a usability floor (length bounds + at least one
// letter/digit) so an empty or purely punctuation-only submission
// is rejected at the trusted boundary rather than reaching the
// search service.
const projectBriefTextV1Schema = z
  .string()
  .min(8, "Brief text must be at least 8 non-whitespace characters")
  .max(2000, "Brief text must be at most 2000 characters")
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .refine((value) => /[\p{L}\p{N}]/u.test(value), {
    message: "Brief text must contain at least one letter or digit after normalization",
  })
  .refine((value) => value.length >= 8, {
    message: "Brief text must be at least 8 non-whitespace characters after normalization",
  });

// Non-search project requirements are a free-form JSON object
// captured by the AI interpretation but never consumed by
// TalentSearchService. They carry things like buyer-acknowledged
// funding deadlines, scope hints, and any other context the brief
// produced without forcing the search contract to grow new fields.
// The schema keeps the value as an opaque record; the Matchmaker
// passes it through verbatim. The `.strict()` modifier rejects
// arrays/scalars at the trusted boundary so the persistence layer
// always reads a JSON object.
export const projectBriefNonSearchRequirementsV1Schema = z
  .object({})
  .catchall(z.string().min(1).max(500))
  .refine((value) => Object.keys(value).length <= 20, {
    message: "nonSearchRequirements must contain at most 20 entries",
  })
  .optional();
export type ProjectBriefNonSearchRequirementsV1 = z.infer<
  typeof projectBriefNonSearchRequirementsV1Schema
>;

// The brief-submission request is the trusted boundary between the
// browser and the Matchmaker service. It carries the acting
// Workspace identifier (so the route can revalidate membership),
// the original brief text, and an optional non-search requirements
// override. Required + preferred criteria are NOT supplied by the
// buyer; they are produced by the AI boundary (or its deterministic
// fallback) and persisted alongside the brief.
export const submitBriefRequestV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    briefText: projectBriefTextV1Schema,
    // Optional buyer-supplied non-search requirements. When absent
    // the AI boundary (or fallback) derives them from the brief.
    nonSearchRequirements: projectBriefNonSearchRequirementsV1Schema,
  })
  .strict();
export type SubmitBriefRequestV1 = z.infer<typeof submitBriefRequestV1Schema>;

// ---------- Matchmaker criteria (AI output, validated) ----------

// The validated search criteria the Matchmaker produces from the
// buyer's brief. This is the single point where AI output (or the
// deterministic fallback) is normalized into the existing M1
// search contract; every field is one of the M1 schema's strict
// shapes so the validated value flows into TalentSearchService
// without further transformation. `required` may never be silently
// relaxed: the schema validates the persisted JSON on read so a
// stored Brief whose required criteria are empty fails closed
// instead of producing an unconstrained search.
function hasHardRequiredAxis(value: TalentSearchRequiredCriteriaV1): boolean {
  if (value.serviceModes && value.serviceModes.length > 0) return true;
  if (value.primaryCategoryKeys && value.primaryCategoryKeys.length > 0) return true;
  if (
    value.independentlyPurchasableServiceKeys &&
    value.independentlyPurchasableServiceKeys.length > 0
  ) {
    return true;
  }
  if (value.basedIn !== undefined) return true;
  if (value.serviceArea !== undefined) return true;
  return false;
}

export const matchmakerCriteriaV1Schema = z
  .object({
    query: normalizedQuerySchema.optional(),
    required: talentSearchRequiredCriteriaV1Schema,
    preferred: talentSearchPreferredCriteriaV1Schema.optional(),
    // Optional non-search requirements derived from the brief.
    nonSearchRequirements: projectBriefNonSearchRequirementsV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasQuery = typeof value.query === "string" && value.query.length >= 2;
    const requiredHasValue = isUsable(value.required);
    const preferredHasValue = value.preferred ? isUsable(value.preferred) : false;
    // A criteria payload must yield a usable search call so a
    // malformed AI output cannot reach TalentSearchService with
    // nothing to do.
    if (!hasQuery && !requiredHasValue && !preferredHasValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Matchmaker criteria must yield at least one of query, required, or preferred",
      });
    }
    // GS 14: when the buyer DID express a hard constraint, that
    // constraint must survive the AI boundary. We detect "hard
    // constraint was expressed" by checking that either the
    // required block has a hard axis OR the buyer-only non-search
    // requirements carry a signal that implies a hard axis. In
    // practice the deterministic fallback always maps the brief
    // to a hard axis when the buyer's text contains a recognised
    // phrase; this check only enforces that the AI boundary did
    // not silently drop it.
    //
    // We do NOT force a hard axis when the buyer only supplied a
    // query — the buyer is entitled to describe the work without
    // naming a category.
    if (requiredHasValue && !hasHardRequiredAxis(value.required)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Matchmaker criteria.required must contain at least one hard constraint axis",
      });
    }
  });
export type MatchmakerCriteriaV1 = z.infer<typeof matchmakerCriteriaV1Schema>;

// ---------- Explanation payload (evidence-grounded, never AI-invented) ----------

// A single explanation line refers to one factual match-evidence
// axis from the eligibility-determined search result. AI cannot
// invent qualifications, availability, verification, prices, or
// sample rights; every line cites the evidence that already exists
// in the search result. The label is human-friendly wording
// restricted to a small allow-list so the UI cannot render
// arbitrary agent output.
export const explanationKindV1Values = [
  "matched-offering-title",
  "matched-category-key",
  "matched-category-name",
  "preferred-genre",
  "preferred-category",
  "preferred-specialty",
  "preferred-affiliation",
  "preferred-service-mode",
  "preferred-included-service",
  "preferred-locality",
  "standalone-offering",
] as const;
export type ExplanationKindV1 = (typeof explanationKindV1Values)[number];

export const explanationEntryV1Schema = z
  .object({
    kind: z.enum(explanationKindV1Values),
    // The factual label derived from the validated search
    // result's matched fields (e.g. "matched offering title",
    // "preferred genre: Dancehall"). The schema restricts the
    // string to a sane length; the AI boundary never constructs
    // these values.
    label: z.string().min(1).max(200),
  })
  .strict();
export type ExplanationEntryV1 = z.infer<typeof explanationEntryV1Schema>;

// ---------- Brief public DTO ----------

// Allow-listed public DTO returned by GET /api/matchmaker/brief/:id.
// The persisted required/preferred criteria are re-validated against
// the M1 schema on every read so a tampered or corrupted row cannot
// leak malformed data into the UI. Provenance (`aiProvider`,
// `aiModelId`, `aiFallbackUsed`) is exposed so the UI can disclose
// which path produced the criteria.
export const projectBriefPublicV1Schema = z
  .object({
    briefId: z.string().min(1).max(128),
    actingWorkspaceId: z.string().min(1).max(128),
    createdByUserId: z.string().min(1).max(128),
    briefText: z.string().min(8).max(2000),
    criteria: matchmakerCriteriaV1Schema,
    aiProvider: z.enum(aiProviderV1Values),
    aiModelId: z.string().min(1).max(120).nullable(),
    aiFallbackUsed: z.boolean(),
    createdAt: z.string().datetime(),
    // Allow-listed BuyerWorkspaceView (id + slug + name). The
    // Workspace's capabilities and status are intentionally NOT
    // exposed here — the caller already authorised through them.
    buyerWorkspace: z
      .object({
        workspaceId: z.string().min(1).max(128),
        slug: z.string().min(1).max(120),
        name: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict();
export type ProjectBriefPublicV1 = z.infer<typeof projectBriefPublicV1Schema>;

// ---------- Recommendation DTO (search results grounded to the brief) ----------

// Allow-listed recommendation entry. Re-uses the public seller /
// public offering schemas already shipped with the v1 search
// contract so a Matchmaker response is structurally identical to a
// direct search response; the only difference is the addition of
// `explanations`, which is derived from the returned result (never
// the AI provider).
export const matchmakerRecommendationV1Schema = z
  .object({
    sellerId: z.string().min(1),
    professionalName: z.string().min(1).max(200),
    bestMatchingOfferingId: z.string().min(1),
    relevanceScore: z
      .number()
      .min(0, "relevanceScore must be at least 0")
      .max(1, "relevanceScore must be at most 1")
      .finite(),
    // Buyer-facing factual evidence the AI boundary assembled from
    // the returned result's matched fields + preference atom
    // coverage + query token coverage. Each entry maps to a
    // structured allow-listed kind; AI-generated text never crosses
    // this boundary.
    explanations: z.array(explanationEntryV1Schema).max(20),
    matchReason: z.string().min(1).max(500),
    preferenceCoverage: preferenceCoverageV1Schema.optional(),
    textCoverage: textCoverageV1Schema.optional(),
    // Best-matching offering snapshot. The full v1 public offering
    // summary is inlined so the UI can render without a follow-up
    // call; the `seller` snapshot follows the same v1 public shape.
    bestMatchingOffering: publicOfferingSummaryV1Schema,
    seller: publicSellerSummaryV1Schema,
    additionalMatchingOfferings: z.array(publicOfferingSummaryV1Schema).max(2),
  })
  .strict();
export type MatchmakerRecommendationV1 = z.infer<typeof matchmakerRecommendationV1Schema>;

// ---------- Matchmaker response ----------

// The submit-brief response returns the persisted brief AND the
// recommendations produced by the eligibility-determined search in
// a single round trip, so the buyer can render the results without
// a follow-up fetch (per the brief+results UI). `totalResults`
// mirrors the M1 search metadata field so the UI can render a
// stable count without depending on the v1 metadata envelope shape.
export const submitBriefResponseV1Schema = z
  .object({
    ok: z.literal(true),
    brief: projectBriefPublicV1Schema,
    recommendations: z.array(matchmakerRecommendationV1Schema).max(10),
    totalResults: z.number().int().nonnegative(),
    strategy: talentSearchStrategyV1Schema,
    // Surfaced when the AI provider failed and the deterministic
    // fallback crossed the same boundary. The UI uses this to
    // disclose the fallback; the field is absent on the managed
    // path so a misconfigured UI cannot mis-attribute provenance.
    fallbackNotice: z.string().min(1).max(500).optional(),
  })
  .strict();
export type SubmitBriefResponseV1 = z.infer<typeof submitBriefResponseV1Schema>;

// ---------- Brief fetch response (no recommendations) ----------

export const briefResponseV1Schema = z
  .object({
    brief: projectBriefPublicV1Schema,
  })
  .strict();
export type BriefResponseV1 = z.infer<typeof briefResponseV1Schema>;

// ---------- AI adapter contract ----------

// Provider-neutral input handed to the AI adapter. Includes the
// acting Workspace identifier so the AI boundary cannot be confused
// about whose brief it is interpreting; the AI never receives raw
// Prisma models, provider subjects, session tokens, or storage
// keys.
export const aiInterpretBriefInputV1Schema = z
  .object({
    actingWorkspaceId: z.string().min(1).max(128),
    briefText: z.string().min(8).max(2000),
    buyerNonSearchRequirements: projectBriefNonSearchRequirementsV1Schema,
  })
  .strict();
export type AiInterpretBriefInputV1 = z.infer<typeof aiInterpretBriefInputV1Schema>;

// Provider-neutral output the AI adapter returns. The structure is
// the candidate criteria payload (NOT yet validated) plus
// provenance metadata the application persists alongside the brief.
// The application is the only layer that validates the payload
// against `matchmakerCriteriaV1Schema`; AI output NEVER crosses
// the validation boundary untyped.
export const aiInterpretBriefOutputV1Schema = z
  .object({
    provider: z.enum(aiProviderV1Values),
    modelId: z.string().min(1).max(120).nullable(),
    // The unvalidated candidate payload. The application parses it
    // through `matchmakerCriteriaV1Schema` and rejects any
    // adapter that returns malformed JSON. The schema here is a
    // permissive record because the goal is to catch anything
    // obviously wrong (top-level type) without re-implementing the
    // validation that already lives on the M1 side.
    candidate: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AiInterpretBriefOutputV1 = z.infer<typeof aiInterpretBriefOutputV1Schema>;

// ===========================================================================
// Buildathon Golden Slice 2 (BG2) shared runtime contracts.
//
// These schemas cover the bounded MP3 discovery samples a seller may
// attach to a ServiceOffering. The contracts follow the same patterns
// as the v1 search and BG1 contracts: shared Zod is the executable
// contract; TypeScript types are inferred from it; the same schema is
// consumed by the Express route validator, the seller management UI,
// the buyer-facing discovery renderer, and the deterministic browser
// journey. No Prisma model, storage reference, bucket name, or
// provider credential ever crosses a public DTO.
//
// Per ticket #61 the BG2 slice satisfies the Golden Slice GS 7–GS 12
// acceptance criteria:
//
//   GS 7  — an authorized seller Workspace can upload an MP3 sample
//           to its own ServiceOffering and list, play, and remove it.
//   GS 8  — an unrelated Workspace, non-member, or insufficiently
//           authorized member cannot upload or remove samples.
//   GS 9  — a successful upload persists buyer-safe metadata and an
//           opaque storage reference in PostgreSQL only after the
//           storage operation succeeds.
//   GS 10 — an Active ServiceOffering exposes zero to three playable
//           MP3 discovery samples; removal stops a sample from
//           appearing in buyer-facing discovery.
//   GS 11 — a fourth sample, a non-MP3 object, or an object larger
//           than 25 MB is rejected at a trusted boundary; duration
//           is not an acceptance condition.
//   GS 12 — Supabase Storage is exercised by a bounded deployed-
//           provider smoke; deterministic storage fixtures satisfy
//           the same application-facing contract in tests.
//
// ===========================================================================

// ---------- Audio sample DTOs ----------

// The only audio sample shape that ever crosses the public HTTP
// boundary. The buyer-facing `<audio>` tag renders `playbackUrl`
// directly; the application server uses the persisted storage ref
// for upload/remove operations but never serializes it. Storage
// credentials, bucket names, object keys, and provider subjects
// never enter this schema. `playbackUrl` resolves to either a
// narrowly scoped Supabase signed URL or the in-app buyer-safe
// playback route, depending on which adapter the server wires.
// Both adapters produce a URL that resolves to actual playable
// audio without further resolution on the client.
export const bg2AudioSamplePublicV1Schema = z
  .object({
    sampleId: z.string().min(1).max(128),
    offeringId: z.string().min(1).max(128),
    label: z.string().min(1).max(120),
    contentType: z.literal("audio/mpeg"),
    byteSize: z
      .number()
      .int()
      .nonnegative()
      .max(25 * 1024 * 1024),
    displayOrder: z.number().int().min(1).max(3),
    // Fully-formed URL the browser attaches to the `<audio>` `src`
    // attribute without inspecting the internals. For Supabase
    // Storage this is a narrowly scoped signed URL; for the
    // deterministic adapter this is the in-app
    // `/api/services/:offeringId/audio-samples/:sampleId/play`
    // route. Eligibility and removal checks are applied before the
    // URL is emitted, so an ineligible or removed sample never
    // appears with a playable handle.
    playbackUrl: z.string().url(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Bg2AudioSamplePublicV1 = z.infer<typeof bg2AudioSamplePublicV1Schema>;

// ---------- Seller list response (one offering's bounded samples) ----------

export const bg2AudioSampleListResponseV1Schema = z
  .object({
    offeringId: z.string().min(1).max(128),
    samples: z.array(bg2AudioSamplePublicV1Schema).max(3),
  })
  .strict();
export type Bg2AudioSampleListResponseV1 = z.infer<typeof bg2AudioSampleListResponseV1Schema>;

// ---------- Upload response ----------

// The upload command returns the persisted buyer-safe sample. The
// request body itself is multipart/form-data (Content-Disposition:
// form-data), so the JSON schema is only for the RESPONSE side; the
// request boundary enforces the file content type and size at the
// trusted multipart parser.
export const bg2AudioSampleUploadResponseV1Schema = z
  .object({
    ok: z.literal(true),
    sample: bg2AudioSamplePublicV1Schema,
  })
  .strict();
export type Bg2AudioSampleUploadResponseV1 = z.infer<typeof bg2AudioSampleUploadResponseV1Schema>;

// ---------- Remove response ----------

export const bg2AudioSampleRemoveResponseV1Schema = z
  .object({
    ok: z.literal(true),
    sampleId: z.string().min(1).max(128),
    offeringId: z.string().min(1).max(128),
    removedAt: z.string().datetime(),
  })
  .strict();
export type Bg2AudioSampleRemoveResponseV1 = z.infer<typeof bg2AudioSampleRemoveResponseV1Schema>;

// ---------- Stable limits exposed for runtime validation ----------
//
// The application uses these constants to enforce the GS 11 / GS 12
// limits at the trusted boundary. A future contract drift detector
// can compare them against the values the application service
// enforces.
export const BG2_AUDIO_SAMPLE_MAX_PER_OFFERING = 3;
export const BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE = 25 * 1024 * 1024;
export const BG2_AUDIO_SAMPLE_CONTENT_TYPE = "audio/mpeg" as const;
export const BG2_AUDIO_SAMPLE_MAX_LABEL_LENGTH = 120;
export const BG2_AUDIO_SAMPLE_MAX_DISPLAY_ORDER = 3;

// ===========================================================================
// BG2 error code additions to the shared safe envelope.
//
// Existing codes remain unchanged. The new BG2 codes cover the
// rejection surfaces unique to the seller-audio slice and round-trip
// through `mapStatus` in `apps/api/src/lib/errors.ts`. The codes
// never expose provider subjects, raw tokens, session ids, storage
// credentials, bucket names, or membership internals.
// ===========================================================================

// The new codes are appended to the existing enum so a contract-drift
// detector can compare this list against the runtime error builder.
// The drift test (`apps/api/src/lib/enum-drift.test.ts`) is the only
// place that consults this list outside the route layer.
