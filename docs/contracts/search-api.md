# Talent Search API Contract

- **Status:** Milestone 1 contract
- **Version:** `v1`
- **Endpoint:** `POST /api/search`
- **Related:** [Marketplace identity ADR](../architecture/adr-001-marketplace-identity.md),
  [Milestone 1 plan](../plans/milestone-1-talent-search.md)

## Purpose

Return public Caribbean talent profiles matching a buyer's natural-language query. Milestone 1
uses deterministic PostgreSQL-backed retrieval. OpenAI embeddings, Pinecone, LLM reranking, and
agent clarification are later implementations behind the same public boundary.

This endpoint is the retrieval primitive and non-agentic fallback, not the final conversational
discovery experience. The future Matchmaker Agent calls the underlying `TalentSearchService`
through `SearchTalentTool`; browser clients never invoke the agent runtime or database directly.

```text
POST /api/search
    → TalentSearchService
        → PostgreSQL/Pinecone

POST /api/agent/brief
    → Matchmaker Agent
        → SearchTalentTool
            → TalentSearchService
```

The primary conversational discovery UI will eventually use `POST /api/agent/brief`. It may ask a
clarifying question, call the same retrieval service, rerank candidates, and return structured
explanations. `POST /api/search` remains independently testable and available when agent/model
services are unavailable or clarification is unnecessary.

## Request

```ts
export interface TalentSearchRequest {
  readonly query: string;
}
```

Validation rules:

- `Content-Type` must be `application/json`.
- `query` is required and must be a string.
- The trimmed query must contain between 2 and 500 characters.
- Unknown fields are ignored in Milestone 1.
- Authentication is not required for public search.

Example:

```json
{
  "query": "upbeat soca vocalist for a summer campaign"
}
```

## Success response

```ts
export type SellerSpecialty =
  | "Artist"
  | "Producer"
  | "Musician"
  | "Songwriter"
  | "SoundEngineer"
  | "Videographer"
  | "VideoEditor"
  | "Influencer";

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface TalentSearchResult {
  readonly sellerId: string;
  readonly displayName: string;
  readonly specialties: readonly SellerSpecialty[];
  readonly genreTags: readonly string[];
  readonly bio: string;
  readonly country: string;
  readonly rate: Money;
  readonly avatarUrl?: string;
  readonly matchReason: string;
  readonly matchScore: number;
}

export interface TalentSearchResponse {
  readonly results: readonly TalentSearchResult[];
  readonly metadata: {
    readonly query: string;
    readonly totalResults: number;
    readonly processingTimeMs: number;
    readonly strategy: "postgres-text-v1";
  };
}
```

Response rules:

- Return at most 10 results.
- Results are ordered by descending `matchScore` with `sellerId` as a stable tie-breaker.
- `matchScore` is finite and bounded from `0` through `1`.
- Identical database state and normalized input must produce identical ordering and scores.
- `matchReason` is deterministic in Milestone 1 and identifies the matching specialties, genres,
  or biography terms. It must not claim to be AI-generated.
- An empty match set is a successful `200` response with `results: []`.
- The API returns canonical profile data from PostgreSQL, never a vector-store document as the
  source of truth.

Example:

```json
{
  "results": [
    {
      "sellerId": "cm1seller123",
      "displayName": "Island Wave",
      "specialties": ["Artist", "Songwriter"],
      "genreTags": ["Soca", "Dancehall"],
      "bio": "Trinidadian vocalist and songwriter creating energetic Caribbean records.",
      "country": "Trinidad and Tobago",
      "rate": {
        "amountMinor": 50000,
        "currency": "USD"
      },
      "matchReason": "Matched specialty Artist and genre Soca.",
      "matchScore": 0.92
    }
  ],
  "metadata": {
    "query": "upbeat soca vocalist for a summer campaign",
    "totalResults": 1,
    "processingTimeMs": 18,
    "strategy": "postgres-text-v1"
  }
}
```

## Error responses

All errors use this shape:

```ts
export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
    readonly details?: Readonly<Record<string, string>>;
  };
}
```

| Status | Code                     | Condition                                               |
| ------ | ------------------------ | ------------------------------------------------------- |
| `400`  | `INVALID_JSON`           | Body is not valid JSON                                  |
| `400`  | `INVALID_SEARCH_QUERY`   | Query is absent, not a string, or outside length limits |
| `415`  | `UNSUPPORTED_MEDIA_TYPE` | Request is not JSON                                     |
| `500`  | `SEARCH_FAILED`          | An unexpected retrieval failure occurs                  |
| `503`  | `SEARCH_UNAVAILABLE`     | PostgreSQL is unavailable                               |

Internal exception messages, database details, credentials, and stack traces are never returned.

## Privacy boundary

The response must not contain:

- User email addresses
- Wallet addresses
- Password, session, or authentication data
- `vibeEmbeddingVector` or any other embedding
- Pinecone identifiers or metadata
- S3 keys or private portfolio object locations
- Unpublished profile fields
- Internal database timestamps unless explicitly added to a future public contract

The shared `TalentSearchResult` DTO is allow-listed field by field. Implementations must not
serialize Prisma models directly.

## Application boundary

```ts
export interface TalentSearchRepository {
  search(input: {
    readonly normalizedQuery: string;
    readonly limit: number;
  }): Promise<readonly TalentSearchCandidate[]>;
}

export interface TalentSearchService {
  search(request: TalentSearchRequest): Promise<TalentSearchResponse>;
}
```

The Express route validates HTTP input and delegates to `TalentSearchService`. The service owns
normalization, deterministic ranking, DTO mapping, and metadata. The repository owns Prisma
queries and returns internal candidates. Express routes must not query Prisma directly.

## Compatibility rules

- Adding an optional response field is backward compatible.
- Renaming or removing fields requires a new API version or coordinated frontend deployment.
- Switching retrieval from PostgreSQL text search to Pinecone is internal as long as this contract
  and deterministic fallback behavior remain supported.
- `strategy` must change when ranking behavior materially changes.
- Agent-specific conversation fields such as `sessionId`, `needsClarification`, and
  `clarificationQuestion` belong to the future `/api/agent/brief` contract and must not be added to
  this deterministic retrieval contract.

## Required contract tests

1. Reject empty, non-string, one-character, and over-500-character queries.
2. Normalize leading/trailing and repeated whitespace.
3. Return an empty result set as `200`.
4. Return stable ordering for tied candidates.
5. Bound every score from `0` through `1`.
6. Exclude embeddings, email, wallet, and storage fields.
7. Map database failures to the documented error response.
8. Confirm that the Next.js `/api/search` proxy returns the same contract as Express directly.
