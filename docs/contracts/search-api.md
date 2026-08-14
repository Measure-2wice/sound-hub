# Talent Search API Contract

- **Status:** Milestone 1 baseline
- **Contract version:** `v1`
- **Endpoint:** `POST /api/search`
- **Authentication:** Public
- **Specification:** [Milestone 1](../specs/milestone-1-talent-search.md)

## Purpose

Return eligible public Caribbean talent and their matching Active ServiceOfferings. Milestone 1 uses
deterministic PostgreSQL retrieval. A future authenticated Matchmaker calls the same
TalentSearchService through SearchTalentTool after converting a brief into required constraints and
preferences.

The endpoint is a public retrieval primitive and non-agentic fallback. It never invokes an LLM,
queries a vector index, creates a ProjectRequest, or exposes database models directly.

## Request

Conceptual shared contract:

```ts
interface TalentSearchRequestV1 {
  readonly query?: string;
  readonly required?: TalentSearchRequiredCriteria;
  readonly preferred?: TalentSearchPreferredCriteria;
}

interface TalentSearchRequiredCriteria {
  readonly primaryCategoryKeys?: readonly string[];
  readonly independentlyPurchasableServiceKeys?: readonly string[];
  readonly serviceModes?: readonly ("Remote" | "InPerson" | "Hybrid")[];
  readonly basedIn?: LocationFilter;
  readonly serviceArea?: LocationFilter;
}

interface TalentSearchPreferredCriteria {
  readonly categoryKeys?: readonly string[];
  readonly includedServiceKeys?: readonly string[];
  readonly specialties?: readonly string[];
  readonly genreTags?: readonly string[];
  readonly caribbeanAffiliationCodes?: readonly string[];
  readonly basedIn?: LocationFilter;
  readonly serviceModes?: readonly ("Remote" | "InPerson" | "Hybrid")[];
}

interface LocationFilter {
  readonly city?: string;
  readonly region?: string;
  readonly countryCode?: string;
}
```

The implementation may refine type names while preserving these semantics. The runtime schema is
the executable contract and must be shared across browser and API packages.

The executable contract uses Zod schemas owned by `@soundhub/types`. TypeScript request, response,
and safe-error types are inferred from those schemas; callers must not maintain parallel handwritten
DTO interfaces. Express parses requests and the web client parses responses at runtime before either
side trusts the values.

Validation rules:

- At least one of `query`, `required`, or `preferred` must contain usable criteria.
- Query is trimmed, internal whitespace is collapsed, and length must be 2 through 500 characters.
- Arrays are bounded, deduplicated, and reject empty strings.
- Country and affiliation values use approved stable codes.
- Unknown fields are rejected at every nesting level.
- Invalid JSON returns a distinct error from valid JSON with invalid criteria.
- Required criteria are never silently converted into preferences or dropped.

Example:

```json
{
  "query": "Haitian producer in New York for a remote dancehall single",
  "required": {
    "primaryCategoryKeys": ["music-production"],
    "serviceModes": ["Remote"]
  },
  "preferred": {
    "genreTags": ["Dancehall"],
    "caribbeanAffiliationCodes": ["HT"],
    "basedIn": {
      "city": "New York",
      "countryCode": "US"
    }
  }
}
```

## Response

```ts
interface MoneyV1 {
  readonly amountMinor: number;
  readonly currency: string;
}

type PricingSummaryV1 =
  | {
      readonly kind: "StartingAt";
      readonly amount: MoneyV1;
      readonly unit: string;
    }
  | {
      readonly kind: "Fixed";
      readonly amount: MoneyV1;
      readonly unit: string;
    }
  | { readonly kind: "ContactForQuote" };

interface PublicSellerSummaryV1 {
  readonly sellerId: string;
  readonly professionalName: string;
  readonly specialties: readonly string[];
  readonly bio: string;
  readonly basedIn: {
    readonly city?: string;
    readonly region?: string;
    readonly countryCode: string;
  };
  readonly caribbeanAffiliationCodes: readonly string[];
  readonly avatarUrl?: string;
}

interface PublicOfferingSummaryV1 {
  readonly offeringId: string;
  readonly title: string;
  readonly description: string;
  readonly primaryCategory: {
    readonly key: string;
    readonly name: string;
  };
  readonly includedServices: readonly {
    readonly key: string;
    readonly name: string;
    readonly purchaseMode: "BundleOnly";
  }[];
  readonly genreTags: readonly string[];
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid";
  readonly serviceAreas: readonly {
    readonly city?: string;
    readonly region?: string;
    readonly countryCode: string;
  }[];
  readonly pricing?: PricingSummaryV1;
}

interface TalentSearchResultV1 {
  readonly seller: PublicSellerSummaryV1;
  readonly bestMatchingOffering: PublicOfferingSummaryV1;
  readonly additionalMatchingOfferings: readonly PublicOfferingSummaryV1[];
  readonly relevanceScore: number;
  readonly matchReason: string;
  readonly preferenceCoverage?: {
    readonly matched: number;
    readonly total: number;
  };
}

interface TalentSearchResponseV1 {
  readonly results: readonly TalentSearchResultV1[];
  readonly metadata: {
    readonly normalizedQuery?: string;
    readonly totalResults: number;
    readonly processingTimeMs: number;
    readonly strategy: "postgres-text-v1";
    readonly appliedRequiredCriteria: TalentSearchRequiredCriteria;
    readonly appliedPreferredCriteria: TalentSearchPreferredCriteria;
  };
}
```

## Result semantics

- Return at most ten seller results.
- A seller appears at most once.
- `bestMatchingOffering` is the seller's highest-scoring eligible offering.
- Include at most two additional eligible matching offerings.
- Only published SellerProfiles under eligible Seller-capable Workspaces and Active offerings enter
  results.
- A required standalone category cannot be satisfied solely by a bundle-only IncludedService.
- Required violations are excluded before preference scoring.
- Results order by descending relevanceScore, then stable sellerId tie-breaker.
- relevanceScore is finite and bounded from zero through one.
- Identical canonical data, strategy, and normalized request produce identical ordering, score, and
  matchReason.
- relevanceScore is not a probability, confidence estimate, quality rating, or guarantee. The buyer
  UI must not render it as a percentage.
- matchReason names deterministic evidence and never claims AI participation.
- `preferenceCoverage.matched` is the count of canonical preference atoms that matched the best matching
  offering; `preferenceCoverage.total` is the count of canonical preference atoms the buyer supplied.
  Both are derived from the deterministic preference matcher, never from `relevanceScore`. The buyer
  UI may surface this coverage as a factual qualitative-fit description but must not render it as a
  percentage and must not derive a confidence or quality band from it.
- `preferenceCoverage` is optional in the public DTO. When the service omits the field, the legacy
  client surfaces the deterministic factual evidence in `matchReason` alone and the qualitative-fit
  block is omitted. The field is omitted only when the buyer supplied no usable preferences (in
  which case `preferenceCoverage.total` would be `0` and the resulting "0 of 0" statement is not
  factual evidence); clients that do not render the field at all therefore receive the same
  buyer-facing behavior as a client that renders "no preferences were requested" for that case. The
  field is always present when the buyer supplied at least one canonical preference atom so the
  coverage line is never absent on a meaningful preference-bearing result.
- Empty results return `200` with `results: []`; constraints are not relaxed automatically.

### Incremental M1.1 semantics

Issue #2 establishes `postgres-text-v1` with deterministic query-token coverage over offering title
and primary-category key/name. Its relevanceScore is matched distinct tokens divided by distinct
normalized query tokens, and its matchReason names only the fields that supplied those matches. The
first tracer returns one best matching offering and no additional offerings. This behavior is an
approved incremental subset, not permission to invent preference weights or AI explanations;
issue #6 completes the final Milestone 1 ranking and grouping semantics.

## Standard error envelope

```ts
interface ApiErrorResponseV1 {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly {
      readonly path: string;
      readonly code: string;
      readonly message: string;
    }[];
    readonly requestId: string;
  };
}
```

| HTTP  | Code                      | Meaning                                               |
| ----- | ------------------------- | ----------------------------------------------------- |
| `400` | `INVALID_JSON`            | Body is not valid JSON                                |
| `400` | `INVALID_SEARCH_CRITERIA` | Missing, malformed, unknown, or out-of-range criteria |
| `415` | `UNSUPPORTED_MEDIA_TYPE`  | Request is not JSON                                   |
| `429` | `SEARCH_RATE_LIMITED`     | Public search limit exceeded                          |
| `500` | `SEARCH_FAILED`           | Unexpected internal failure                           |
| `503` | `SEARCH_UNAVAILABLE`      | Canonical PostgreSQL retrieval is unavailable         |

Field messages are safe for display. Internal exception text, database details, credentials, and
stack traces never enter the response.

Suggested UI mappings:

- Field errors appear beside the relevant control.
- A contract mismatch caused by an outdated client asks the user to refresh.
- `SEARCH_UNAVAILABLE` preserves the brief and offers retry.
- Unexpected errors show a generic message plus request ID.

## Privacy boundary

Public results must not contain:

- Account email or authentication identifiers
- WorkspaceMembership or private authority data
- Wallet addresses, challenges, or authorization records
- Internal embeddings or vector metadata
- S3/object keys or private storage locations
- Unpublished profiles or non-Active offerings
- Internal timestamps not explicitly added to a later contract
- Raw Prisma models

All public objects are mapped field by field through allow-listed response schemas.

## Application boundary

```ts
interface TalentSearchRepository {
  search(input: RepositorySearchInput): Promise<readonly TalentSearchCandidate[]>;
}

interface TalentSearchService {
  search(request: TalentSearchRequestV1): Promise<TalentSearchResponseV1>;
}
```

- Express owns HTTP parsing, content type, runtime validation, request IDs, and error mapping.
- TalentSearchService owns normalization, required/preferred semantics, deterministic scoring,
  deduplication, match evidence, DTO mapping, and strategy metadata.
- The repository owns Prisma queries and returns internal candidates.
- Routes and agents never query Prisma directly.
- SearchTalentTool validates its structured input and invokes TalentSearchService without bypassing
  eligibility or required constraints.

## Browser transport

The approved Milestone 1 browser transport is the existing Next.js rewrite. Browser code calls
same-origin `/api/search`; Next.js forwards `/api/:path*` to the server-only `API_URL` origin (with
`http://localhost:4000` as the local default). The rewrite contains no validation or business logic
and must preserve Express success/error status, response body, and request ID.

## Compatibility

- The existing pre-release producer-only response is intentionally replaced.
- Adding an optional response field is backward-compatible.
- Removing, renaming, or changing field semantics requires a new contract version or coordinated
  client release before public launch.
- A material ranking change requires a new `strategy` value.
- Vector retrieval is internal only while canonical hydration, eligibility, public fields, required
  constraints, and deterministic PostgreSQL fallback remain supported.
- Agent conversation fields belong to a future authenticated Matchmaker contract, not this endpoint.

## Contract acceptance

1. Validate text-only, structured-only, and combined requests.
2. Reject unknown fields and invalid nested values.
3. Verify required constraints exclude and preferences rank.
4. Verify bundle-only services cannot satisfy standalone requirements.
5. Verify one result per seller and stable best/additional offerings.
6. Verify deterministic ordering, reasons, and bounded scores.
7. Verify empty results return `200` without relaxation.
8. Verify private fields never serialize.
9. Verify database failure maps to the safe `503` envelope.
10. Verify the Next.js proxy preserves both success and error contracts.

## Contract revisions

The shared runtime contract is the executable source of truth. The conceptual interface, the
semantics, and the runtime schema are reviewed together so that the browser, the API, and the
contract document cannot drift.

- **v1 (current) — `preferenceCoverage` added as an optional response field.** Issue #6 (M1.5)
  extends the M1.1 result with deterministic preference-atom coverage so the buyer UI can surface a
  factual qualitative-fit line in addition to the existing `matchReason` evidence. The field is
  declared optional in the conceptual interface and in the runtime schema (`preferenceCoverageV1Schema`
  is used inside `talentSearchResultV1Schema` through `.optional()`) for backward compatibility with
  in-flight clients; semantically the service emits it whenever the buyer supplied at least one
  canonical preference atom and omits it only when no preferences were requested. The service-owned
  fallback for the omitted case is the existing `matchReason` evidence. The field is never rendered
  as a percentage and never derived from `relevanceScore`, which remains strategy-specific ordering.
