# Milestone 1 Plan: Database-Backed Talent and Offering Search

- **Status:** Ready for implementation after documentation review
- **Product specification:** [Milestone 1 spec](../specs/milestone-1-talent-search.md)
- **Domain language:** [`CONTEXT.md`](../../CONTEXT.md)
- **API contract:** [Talent Search API](../contracts/search-api.md)
- **Architecture:** [Workspaces](../adr/0001-workspaces-own-marketplace-activity.md),
  [offerings](../adr/0002-sellers-publish-purchasable-offerings.md), and
  [agent boundaries](../adr/0003-agents-reason-within-deterministic-workflows.md)

## Outcome

An anonymous buyer enters a brief and optional filters in the browser and receives deterministic,
public seller-and-offering results from PostgreSQL:

```text
Seeded Workspace + SellerProfile + Active ServiceOffering
    → PostgreSQL
    → PrismaTalentSearchRepository
    → TalentSearchService
    → Express POST /api/search
    → Next.js proxy
    → buyer-facing result states
```

The slice proves the browser, HTTP, runtime contract, application service, repository, Prisma, and
PostgreSQL boundaries without requiring AI, vector, Redis, storage, authentication, wallet, or
blockchain infrastructure.

It remains the future Matchmaker's retrieval primitive:

```text
Authenticated brief
    → Matchmaker
        → clarification when needed
        → required constraints + preferences
        → SearchTalentTool
            → TalentSearchService
```

## Scope baseline

### Implement

- Minimal UserAccount, Workspace, and WorkspaceMembership schema foundation
- Independent Buyer and Seller Workspace capabilities
- SellerProfile with professional identity, specialties, location, and Caribbean affiliations
- Controlled ServiceCategory records
- ServiceOffering with category, IncludedServices, pricing summary, service mode, and lifecycle
- Reviewed Prisma migration and deterministic idempotent seed
- Repository interface plus Prisma implementation
- Deterministic structured filtering and ranking
- Versioned, allow-listed public DTOs and shared runtime validation
- Standard safe API error envelope
- Express route and Next.js proxy
- Web initial, loading, results, empty, invalid, unavailable, and retry states
- Focused unit, repository, contract, web, and runtime tests

### Establish structurally but do not expose behavior

WorkspaceMembership records exist so marketplace ownership is correct. Authentication, invitations,
Workspace switching, membership administration, and permission screens remain deferred.

### Exclude

- Authentication and onboarding
- Matchmaker, Google ADK, OpenAI, embeddings, Pinecone, and generated explanations
- ProjectRequest, Deal, negotiation, approvals, delivery, and disputes
- Wallet, escrow, stablecoin, and Polkadot behavior
- Redis and scheduled jobs
- PortfolioItem, DealDeliverable, S3, and uploads
- Sync licensing of existing works
- Availability calendars and capacity inventory
- Admin moderation and real verification
- Production deployment

## Domain baseline

### Ownership

- UserAccount is a private human login.
- Workspace is the marketplace participant and owns capabilities and SellerProfile.
- A UserAccount may join multiple Workspaces.
- One Workspace owns at most one SellerProfile in the MVP.
- Personal and organizational Workspaces may sell when they represent creatives, bands, studios, or
  collectives.

### Seller eligibility

A search candidate is eligible only when:

```text
Workspace is eligible and has Seller capability
AND SellerProfile is published and not suspended
AND ServiceOffering is Active
```

Publication and verification are separate. Milestone 1 does not display or rank a fake verification
signal.

### Offerings

- Lifecycle: `Draft | Active | Paused | Archived`
- Service mode: `Remote | InPerson | Hybrid`
- One primary ServiceCategory per offering
- Optional IncludedServices are bundle-only
- Separate offerings represent independently purchasable work
- Pricing: `StartingAt`, `Fixed`, or `ContactForQuote`
- Price units are controlled values appropriate to the category; advertised pricing is non-binding

Initial category keys:

1. `music-production`
2. `songwriting`
3. `custom-composition`
4. `session-vocals`
5. `session-instrument-performance`
6. `featured-artist-performance`
7. `mixing`
8. `mastering`
9. `recording-engineering`
10. `live-performance`

## Search behavior

TalentSearchService accepts normalized text plus structured criteria divided into:

- `required`: exclusionary constraints
- `preferred`: ranking signals

The direct Milestone 1 UI must not silently derive hard constraints from free text. Later, the
Matchmaker owns clarification and translation into structured criteria.

Searchable evidence includes:

- Seller professional name and biography
- Specialties
- Caribbean affiliations and current location
- Offering title, description, primary category, IncludedServices, genres, tags, service mode, and
  service area

Ranking rules:

- Return at most ten sellers.
- Return one result per seller.
- Lead with the seller's best matching offering and include at most two additional matches.
- Required violations never enter ranking.
- Use named weights and a stable seller identifier tie-breaker.
- Bound relevanceScore from zero through one.
- Treat relevanceScore as strategy-specific ordering, not probability.
- Produce deterministic evidence-based matchReason without AI claims.
- Do not silently relax required constraints.

## Proposed implementation seams

```text
HTTP route
    → runtime request schema
    → TalentSearchService
        → TalentSearchRepository interface
            ← PrismaTalentSearchRepository
    → public response schema
```

Likely ownership shape:

```text
packages/types
    versioned request, response, error, and runtime schemas

packages/db
    schema, migration, seed, Prisma repository

apps/api
    route, service, repository interface, composition root, tests

apps/web
    proxy, client hook, filters, result cards, state tests
```

Exact private paths may change. Dependency direction and shared contracts may not change without
integration-owner approval.

## Work breakdown

### Gate 1 — Shared foundation

Single integration owner:

1. Add shared request, response, and error schemas.
2. Add repository interface and internal candidate contract.
3. Establish domain names and identifiers.
4. Add compile-only fakes where useful.
5. Freeze shared files after focused checks pass.

### Stream A — Database

**Suggested worktree:** `codex/m1-database`

Owns Prisma schema, reviewed migration, seed, Prisma repository, and repository integration tests.

Tasks:

1. Replace the pre-release role/ProducerProfile/MusicTrack scaffold.
2. Implement minimal Workspace ownership and marketplace discovery records.
3. Seed stable solo, multi-brand, and group Workspace examples.
4. Seed at least six Caribbean sellers and Active offerings across all major query scenarios.
5. Implement eligibility and candidate retrieval.
6. Apply and test migration only against disposable local PostgreSQL.

### Stream B — API and search service

**Suggested worktree:** `codex/m1-api-search`

Owns service, internal repository seam, HTTP route, runtime mapping, and API/service tests.

Tasks:

1. Replace RagService with TalentSearchService.
2. Remove random scores, fake vectors, delay, and fabricated AI text.
3. Validate strict text and structured criteria.
4. Apply required filters and deterministic preference ranking.
5. Deduplicate by seller and map best/additional offerings.
6. Map safe validation, internal, and database-unavailable errors.

### Stream C — Web

**Suggested worktree:** `codex/m1-web-search`

Owns Next.js proxy, search state, filters, result presentation, and web tests.

Tasks:

1. Consume shared request/response schemas.
2. Preserve cancellation and prevent stale responses or stale loading state.
3. Render all approved states and preserve input after retryable failure.
4. Show match evidence, pricing kind, category, service mode, location, and affiliations.
5. Do not show relevanceScore as a buyer-facing percentage.
6. Label bundle-only IncludedServices accurately.

## Worktree coordination

Use an integration branch such as `codex/m1-talent-search`; do not merge independent worktrees
directly into `main`.

```text
shared foundation
       ↓
database ─────┐
API fake repo ├──→ integration → full checks → runtime smoke → review
web UI ───────┘
```

Rules:

1. One owner per worktree.
2. The integration owner exclusively owns shared types, root configuration, and lockfile.
3. Dependency requests go through the integration owner.
4. Shared contract changes require evidence, explicit approval, and notification to all streams.
5. No migration runs against shared, staging, or production databases.
6. Every stream runs focused checks before handoff.
7. The integration owner runs full verification after every merge.

## Migration safety

Before migration work:

1. Confirm the target is disposable local PostgreSQL without printing credentials.
2. Confirm no valuable data depends on the pre-release scaffold.
3. Generate a descriptively named migration.
4. Read SQL for destructive operations, data loss, indexes, constraints, and unintended enum lock-in.
5. Run migration from an empty database.
6. Seed twice and verify stable row counts and values.
7. Do not use `prisma db push` as an acceptance substitute.

## Acceptance gates

### Repository

```bash
pnpm type-check
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

### Database

- Fresh migration succeeds against empty PostgreSQL.
- Seed succeeds twice without duplication or random changes.
- Repository integration tests use real PostgreSQL.
- Draft, Paused, Archived, unpublished, suspended, and ineligible records are excluded correctly.

### Service and API

- Repeated input and state produce identical ordering, reasons, and scores.
- Required/preferred semantics, bundles, deduplication, and tie-breaking are covered.
- Empty results return `200`.
- Invalid and unknown fields use the standard error envelope.
- Database unavailability returns safe retriable `503`.
- Public DTOs exclude private account, wallet, embedding, storage, and internal timestamp fields.
- Next.js proxy preserves the Express contract.

### Web

- Initial, loading, results, empty, invalid, unavailable, and retry states work.
- Input survives retryable failures.
- Canceled or older requests cannot overwrite newer state.
- No percentage-confidence claim appears.

### Runtime smoke

```text
clean PostgreSQL
→ migrate
→ seed twice
→ start API and web
→ health check
→ successful browser search
→ strict invalid request
→ unavailable dependency state
```

No AI, vector, Redis, storage, wallet, or blockchain credentials are permitted in this gate.

## Completion handoff

Milestone 1 is complete only when the acceptance gates pass, runtime behavior matches the published
contract, the obsolete mock path is gone, and documentation reflects any approved contract changes.
Authentication and later MVP milestones require a new stress-test before implementation.
