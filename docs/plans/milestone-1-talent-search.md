# Milestone 1: Database-Backed Talent Search

- **Status:** Ready for implementation
- **Target:** First production-shaped vertical slice
- **Depends on:** Milestone 0 build/tooling baseline
- **Architecture:** [ADR-001](../architecture/adr-001-marketplace-identity.md)
- **API contract:** [Talent Search API](../contracts/search-api.md)

## Outcome

A buyer can enter a natural-language creative brief in the browser and receive public Caribbean
talent results sourced from PostgreSQL:

```text
Seeded SellerProfile
    → PostgreSQL
    → Prisma repository
    → deterministic TalentSearchService
    → POST /api/search
    → Next.js proxy
    → search results UI
```

This slice proves the browser, API, shared contract, application service, repository, Prisma, and
PostgreSQL boundaries before introducing semantic-search infrastructure or agents.

It does not replace the planned Matchmaker Agent. Milestone 1 produces the deterministic search
capability that the agent will later invoke as a tool:

```text
Milestone 1
Browser → POST /api/search → TalentSearchService → PostgreSQL

Later agentic discovery
Browser → POST /api/agent/brief → Matchmaker Agent
                                    → SearchTalentTool
                                        → TalentSearchService
                                            → PostgreSQL/Pinecone
```

The API is the secured transport boundary. The Matchmaker owns clarification, reasoning,
reranking, and explanations; `TalentSearchService` owns candidate retrieval and deterministic
fallback behavior. The agent never receives database credentials or queries Prisma directly.

## Scope

### Included

- Capability-based account fields needed by seller profiles
- `SellerProfile` replacing the producer-only profile model
- Music-focused seller specialties
- Country/region and public rate data
- Reviewed Prisma migration
- Idempotent seed containing representative Caribbean talent
- Repository interface and Prisma implementation
- Deterministic PostgreSQL-backed matching and ranking
- Versioned public request/response DTOs
- Express input validation and error mapping
- Next.js API proxy and search UI integration
- Loading, empty, validation, and failure states
- Unit, repository, contract, and runtime smoke tests

### Explicitly excluded

- OpenAI embeddings
- Pinecone or another vector database
- LLM reranking or generated explanations
- Google ADK and agent clarification flows
- Authentication and organization membership
- Wallet connection
- Deals, negotiation, file delivery, and escrow
- S3 portfolio or delivery uploads
- Redis and scheduled jobs
- Production deployment

These exclusions apply only to Milestone 1. In the intended architecture, the Matchmaker Agent is
the primary conversational discovery path and `POST /api/search` remains its tested retrieval
primitive and non-agentic fallback.

## Domain decisions

1. Use `SellerProfile` as the sell-side domain name.
2. Use `Buyer` and `Seller` capabilities rather than one exclusive user role.
3. A seller may have multiple specialties.
4. Public search returns an allow-listed DTO, never a Prisma `User` or `SellerProfile` object.
5. PostgreSQL is canonical; later vector indexes contain derived projections only.
6. Milestone 1 ranking must be deterministic and testable.
7. Existing mock vectors, random scoring, artificial delays, and canned AI claims are removed.
8. The future Matchmaker calls search through `SearchTalentTool`; it does not replace or bypass the
   search service and repository boundaries.

## Proposed implementation shape

```text
packages/types/src/
└── search.ts                       shared request/response DTOs

packages/db/
├── prisma/schema.prisma            account capabilities + SellerProfile
├── prisma/migrations/...           reviewed migration
├── prisma/seed.ts                  idempotent Caribbean talent fixtures
└── src/repositories/
    └── prisma-talent-search.ts      Prisma repository implementation

apps/api/src/
├── routes/search.ts                HTTP validation and response mapping
├── services/talent-search.ts       normalization, ranking, public DTO mapping
└── repositories/
    └── talent-search.ts             repository interface/internal candidate type

apps/web/src/
├── app/hooks/useSearch.ts           typed client state
└── app/components/SearchPage.tsx    search and result states
```

Exact paths may change during implementation, but dependency direction may not:

```text
route → service → repository interface ← Prisma repository
                  ↓
             shared public DTO
```

## Deterministic retrieval strategy

The first implementation normalizes the query by trimming, collapsing whitespace, and applying
case-insensitive comparison. It searches public profile fields:

- Display name
- Specialties
- Genre tags
- Biography
- Country

Ranking should use explicit weighted matches and a stable `sellerId` tie-breaker. The service must
normalize the final score to `0..1`. The exact weights belong in named constants and unit tests,
not SQL magic numbers scattered across routes.

PostgreSQL full-text search may be used if it remains deterministic and the migration complexity
is proportionate. A simpler case-insensitive/tag query is acceptable for this milestone.

## Seed requirements

Seed at least six profiles covering several countries and specialties, for example:

- Soca vocalist/songwriter — Trinidad and Tobago
- Reggae artist — Jamaica
- Dancehall producer — Jamaica
- Calypso musician — Barbados or Trinidad and Tobago
- Afrobeats/Caribbean fusion producer — Caribbean diaspora
- Sound engineer — Caribbean region

The seed must:

- Use stable identifiers or unique emails suitable for upsert
- Be safe to run repeatedly
- Avoid random embeddings and random business data
- Contain no real personal contact information
- Produce fixtures that exercise empty, single-match, multi-match, and tie-order tests

## Work breakdown

### Gate 1 — Foundation contract (single owner)

Before parallel work begins:

1. Add the shared DTOs from the API contract.
2. Add the repository interface and internal candidate type.
3. Agree on Prisma model and enum names.
4. Add compile-only fakes where necessary.
5. Merge this foundation into the integration branch.

Shared files are frozen after this gate unless the integration owner approves a contract change.

### Stream A — Database

**Branch/worktree:** `codex/m1-database`

**Owns:**

- `packages/db/prisma/**`
- `packages/db/src/repositories/**`
- DB repository tests

**Tasks:**

1. Implement account type, capabilities, specialties, and `SellerProfile`.
2. Review the generated SQL before accepting the migration.
3. Replace random/non-idempotent seed behavior with stable upserts.
4. Implement the Prisma talent-search repository.
5. Test query behavior against PostgreSQL.

**Must not edit:** frontend files, API routes, root scripts, or shared DTOs.

### Stream B — API

**Branch/worktree:** `codex/m1-api-search`

**Owns:**

- `apps/api/src/routes/search.ts`
- `apps/api/src/services/**`
- `apps/api/src/repositories/**` except the DB implementation owned by Stream A
- API and contract tests

**Tasks:**

1. Replace `RagService` with `TalentSearchService`.
2. Remove random scores, fake vectors, artificial delay, and AI wording.
3. Validate the request and map documented errors.
4. Rank candidates deterministically.
5. Map internal candidates to the allow-listed public DTO.
6. Test with an in-memory fake repository before DB integration.

**Must not edit:** Prisma schema/migrations, frontend files, or shared DTOs.

### Stream C — Web

**Branch/worktree:** `codex/m1-web-search`

**Owns:**

- `apps/web/**`
- Web search tests

**Tasks:**

1. Consume the shared talent-search contract.
2. Preserve request cancellation and prevent stale-result races.
3. Add initial, loading, empty, validation-error, server-error, and results states.
4. Render specialties, genres, country, rate, match reason, and score.
5. Confirm `/api/search` uses the Next.js proxy.

**Must not edit:** Prisma, API internals, root scripts, or shared DTOs.

## Worktree coordination

Use an integration branch such as `codex/m1-talent-search`; do not merge independent worktrees
directly into `main`.

Recommended order:

```text
foundation contract
    ↓
database ─────┐
API fake repo ├──→ integration → runtime tests → review → main
web UI ───────┘
```

Rules:

1. One agent owns each worktree.
2. `packages/types/**`, root configuration, and the lockfile have one integration owner.
3. Dependency additions are requested from the integration owner to avoid lockfile conflicts.
4. Agents report assumptions and file ownership in their handoff.
5. No agent runs a migration against shared, staging, or production databases.
6. Stream A may use a disposable local PostgreSQL database only.
7. Every stream runs its focused checks before handoff.
8. The integration owner runs the complete verification after every merge.

## Migration safety

Before running `prisma migrate dev`:

1. Confirm the target is disposable local PostgreSQL.
2. Inspect `DATABASE_URL` without printing credentials.
3. Generate the migration with a descriptive name.
4. Read the SQL for destructive operations, table renames, and data loss.
5. Prefer explicit rename/data-copy SQL when replacing `ProducerProfile` with `SellerProfile`.
6. Do not use `prisma db push` as a substitute for a reviewed migration.

The migration must preserve existing users and profile data if any local data is considered useful.

## Test strategy

### Unit tests

- Query normalization
- Validation boundaries
- Weighted deterministic ranking
- Stable tie-breaking
- Match-reason generation
- Public DTO allow-listing

### Repository tests

- Specialty match
- Genre match
- Biography match
- Country match
- Empty result
- Result limit
- Stable ordering
- Database failure behavior

### Contract tests

Implement every case listed in [`docs/contracts/search-api.md`](../contracts/search-api.md).

### Runtime smoke test

With disposable PostgreSQL running:

1. Seed the database.
2. Start API and web applications.
3. Call Express directly.
4. Call the same endpoint through Next.js.
5. Confirm equivalent public response shapes.
6. Confirm no embedding, email, wallet, or storage fields are present.

## Acceptance criteria

- [ ] The old exclusive `Role` model no longer controls marketplace authorization.
- [ ] A creative account can hold both `Buyer` and `Seller` capabilities.
- [ ] Buyer-only accounts cannot create a seller profile through application services.
- [ ] At least six deterministic Caribbean seller profiles are seeded idempotently.
- [ ] `POST /api/search` reads candidates from PostgreSQL.
- [ ] Search produces deterministic results without OpenAI or Pinecone credentials.
- [ ] The browser renders database-backed results through the Next.js proxy.
- [ ] Loading, empty, invalid-input, and server-failure states are implemented.
- [ ] Search responses satisfy the documented contract.
- [ ] Private/internal fields never cross the HTTP boundary.
- [ ] Unit, repository, contract, and runtime smoke tests pass.
- [ ] Migration SQL has been reviewed and contains no unexplained destructive operation.
- [ ] `pnpm check` passes from a clean checkout after Prisma generation.

## Verification commands

```bash
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm db:up
pnpm --filter @soundhub/db db:migrate
pnpm --filter @soundhub/db db:seed
pnpm check
pnpm dev
```

`pnpm db:down` currently removes named volumes with `-v`; use it only when deleting the local
database is intentional.

## Definition of done

Milestone 1 is complete when a fresh local environment can install, start disposable PostgreSQL,
apply the reviewed migration, seed talent, search through the browser, and pass the complete test
and build pipeline without AI, vector-database, wallet, or blockchain credentials.
