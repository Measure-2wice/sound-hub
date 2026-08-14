# Milestone 1: Database-Backed Talent and Offering Search

## Problem Statement

Buyers cannot currently discover real SoundHub sellers or purchasable services. The browser calls a
producer-only mock that returns random scores, fake vector data, artificial delays, and fabricated AI
explanations. The underlying schema conflates human identity, marketplace authority, professional
specialty, and seller presentation, while a single bare rate cannot represent the services a seller
actually offers.

Before agentic discovery, negotiation, delivery, or payment can be implemented safely, SoundHub
needs a deterministic end-to-end retrieval capability built on the approved Workspace,
SellerProfile, and ServiceOffering boundaries.

## Solution

An anonymous buyer can enter a creative brief and optional structured filters, then receive stable
public results from PostgreSQL. Each result represents one eligible seller, led by the seller's
best-matching Active offering and accompanied by deterministic match evidence.

The implementation establishes minimal UserAccount, Workspace, WorkspaceMembership, SellerProfile,
ServiceCategory, and ServiceOffering data structures; seeds representative Caribbean marketplace
fixtures; replaces the mock RagService with a deterministic TalentSearchService; exposes a strictly
validated versioned API contract; and renders all meaningful browser states through the Next.js
proxy.

Milestone 1 is the retrieval primitive and non-agentic fallback. A future authenticated Matchmaker
will translate natural language into the same service's required constraints and preferences through
SearchTalentTool.

## User Stories

1. As an anonymous buyer, I want to search public talent without creating an account, so that I can
   evaluate marketplace relevance before signing up.
2. As a buyer, I want to describe a creative need in natural language, so that I do not need to know
   SoundHub's taxonomy before searching.
3. As a buyer, I want optional structured filters, so that I can express requirements precisely.
4. As a buyer, I want required constraints to exclude invalid candidates, so that essential needs
   are never treated as preferences.
5. As a buyer, I want preferences to improve ranking without eliminating alternatives, so that a
   desirable attribute does not create false empty results.
6. As a buyer, I want required constraints preserved until I approve a relaxation, so that the
   system does not silently change my request.
7. As a buyer, I want one result per seller, so that a seller with several offerings does not flood
   the result list.
8. As a buyer, I want each result led by the best-matching offering, so that I understand what I can
   commission from the seller.
9. As a buyer, I want additional relevant offerings shown without duplication, so that I can see a
   seller's related services.
10. As a buyer, I want bundle-only services labeled accurately, so that I do not mistake an included
    component for an independently purchasable service.
11. As a buyer, I want professional specialties distinguished from service categories, so that an
    occupation is not presented as a purchasable listing.
12. As a buyer, I want Caribbean affiliation distinguished from current location and service area,
    so that diaspora talent is represented accurately.
13. As a buyer, I want Remote, InPerson, and Hybrid service modes applied per offering, so that the
    same seller can deliver different services differently.
14. As a buyer, I want only Active offerings in ordinary results, so that I do not initiate requests
    for paused or retired services.
15. As a buyer, I want advertised pricing to state whether it is fixed, starting-at, or contact for
    quote, so that a bare number is not misleading.
16. As a buyer, I want match evidence in plain language, so that I can judge relevance myself.
17. As a buyer, I do not want an algorithmic score shown as a probability, so that ranking does not
    imply unearned certainty.
18. As a buyer, I want a clear empty state, so that no matches are not presented as a system error.
19. As a buyer, I want my brief preserved after a temporary failure, so that I can retry without
    retyping it.
20. As a buyer, I want invalid filters explained beside the relevant controls, so that I can correct
    them.
21. As a buyer, I want a safe service-unavailable state, so that infrastructure failures are not
    mistaken for no available talent.
22. As a seller, I want my professional identity separated from my private login identity, so that
    public discovery does not expose account data.
23. As a seller, I want multiple specialties on one profile, so that I can be represented as both a
    producer and an artist.
24. As a seller, I want distinct offerings with distinct pricing and service modes, so that buyers
    understand what I sell.
25. As a seller, I want bundled included services distinguished from standalone offerings, so that
    buyers understand package pricing.
26. As a seller, I want a paused offering excluded from search without deleting it, so that I can
    resume it later.
27. As a Caribbean diaspora seller, I want self-declared affiliation separate from residence, so
    that my location does not erase my connection to the region.
28. As a group or studio, I want the schema to place my seller identity under a Workspace, so that
    future members can manage it without shared credentials.
29. As a marketplace operator, I want controlled category keys with seller-authored content, so that
    search remains consistent without suppressing creative descriptions.
30. As a marketplace operator, I want only allow-listed public DTO fields returned, so that emails,
    wallet data, embeddings, storage keys, and private timestamps do not leak.
31. As a marketplace operator, I want deterministic ranking, so that tests and regressions are
    meaningful.
32. As a marketplace operator, I want unknown request fields rejected, so that misspelled hard
    requirements are not silently ignored.
33. As a marketplace operator, I want stable request IDs and error codes, so that failures can be
    diagnosed without exposing internals.
34. As a future Matchmaker developer, I want a structured TalentSearchService boundary, so that the
    agent can translate a brief into validated criteria without querying Prisma directly.
35. As a future Matchmaker user, I want deterministic PostgreSQL fallback, so that AI or vector
    outages do not eliminate discovery.
36. As an engineer, I want idempotent seed data, so that repeated local setup produces the same
    fixtures.
37. As an engineer, I want real PostgreSQL repository tests, so that mock behavior does not hide
    schema or query defects.
38. As an engineer, I want one shared runtime-validated contract, so that browser, API, and agent-tool
    boundaries agree.
39. As an engineer, I want canceled requests prevented from overwriting new results, so that rapid
    searches cannot corrupt UI state.
40. As an engineer, I want Milestone 1 to run without AI, vector, Redis, storage, wallet, or
    blockchain credentials, so that the first vertical slice remains bounded and reproducible.

## Implementation Decisions

- UserAccount represents a private human login; Workspace represents the marketplace participant.
- WorkspaceMembership is structurally present but authentication, invitations, switching, and
  permission interfaces are deferred.
- Buyer and Seller are independent Workspace capabilities.
- A Workspace may be personal or organizational and owns at most one SellerProfile in the MVP.
- SellerProfile contains the public professional name, biography, specialties, current location,
  and self-declared Caribbean affiliations.
- Formal verification is not required for publication and is not represented as a fake seeded badge.
- ServiceOffering is a first-class child of SellerProfile and is the purchasable discovery unit.
- Every searchable seller has at least one Active offering.
- Offering lifecycle is Draft, Active, Paused, or Archived.
- Service mode is Remote, InPerson, or Hybrid and belongs to an offering.
- Each offering has one primary ServiceCategory and may reference bundle-only IncludedServices.
- Independently purchasable work requires its own offering.
- Initial category keys are music-production, songwriting, custom-composition, session-vocals,
  session-instrument-performance, featured-artist-performance, mixing, mastering,
  recording-engineering, and live-performance.
- Categories are records with stable keys, not ORM enums.
- Pricing is optional and either StartingAt with a Money amount and unit, Fixed with a Money amount
  and unit, or ContactForQuote. Advertised pricing is non-binding.
- Location, service area, CaribbeanAffiliation, genre, Specialty, and service mode are distinct.
- Public portfolio items, private deal deliverables, and licensable catalog assets are distinct;
  none are implemented in Milestone 1.
- The producer-only Role, ProducerProfile, MusicTrack, IQueryResponse, and RagService scaffold is
  replaced without compatibility layers. Disposable mock fixtures are reseeded.
- TalentSearchService accepts text plus structured required constraints and preferences.
- Required constraints exclude candidates; preferences contribute deterministic ranking weight.
- Search returns at most ten results, one per seller, ordered by relevanceScore and a stable seller
  identifier tie-breaker.
- Each result includes an allow-listed seller summary, best matching offering, up to two additional
  offerings, deterministic match reason, relevanceScore, and factual preference coverage.
- relevanceScore is finite, bounded from zero through one, specific to the declared strategy, and
  not displayed as a buyer-facing percentage. The buyer UI may surface the deterministic preference
  coverage as a factual qualitative-fit description but must not render it as a percentage and must
  not derive a confidence or quality band from relevanceScore.
- Unknown request fields are rejected with the shared safe error envelope.
- PostgreSQL is canonical. Model/vector failure later falls back to deterministic PostgreSQL;
  PostgreSQL failure returns a retriable unavailable response.
- Public search is anonymous and stateless beyond minimized operational telemetry.
- ProjectRequest creation, authentication, agents, Redis, uploads, Deals, and payments are excluded.
- The primary end-to-end test seam is browser request through the Next.js proxy, Express route,
  TalentSearchService, Prisma repository, and real disposable PostgreSQL.
- Issue #2 is both Gate 1 and the first vertical slice. Its owner is the integration owner for shared
  types, approved dependencies, root configuration, and lockfile changes until the foundation lands.
- Shared request, response, and safe-error runtime schemas use Zod, with TypeScript types inferred
  from those schemas.

## Testing Decisions

- Tests assert externally observable behavior and stable contracts, not private helper structure.
- TalentSearchService unit tests use an in-memory repository fake to cover normalization, hard
  constraints, preference weighting, bundle labeling, deduplication, tie-breaking, score bounds,
  and deterministic match reasons.
- Prisma repository integration tests use disposable PostgreSQL to cover eligibility filters,
  category and location queries, Active-only offerings, and stable seed behavior.
- API contract tests cover valid text and structured requests, strict unknown-field rejection,
  field errors, empty results, safe internal failure, database unavailable behavior, response
  privacy, and the standard error envelope.
- Web tests cover initial, loading, results, empty, validation, unavailable, retry, preserved-input,
  cancellation, and stale-response states.
- The first browser tracer is an automated Playwright Chromium test against real Next.js, Express,
  and isolated disposable PostgreSQL; later tickets expand browser-state coverage.
- Runtime smoke testing starts clean PostgreSQL, applies the reviewed migration, seeds twice, starts
  API and web, exercises a successful and invalid search through the browser proxy, and verifies a
  service-unavailable state.
- Completion requires type-check, lint, tests, build, and formatting checks across the workspace.
- No test requires OpenAI, Pinecone, Redis, S3, wallet, or blockchain credentials.

## Out of Scope

- Authentication, onboarding, invitations, Workspace switching, and team-management screens
- Matchmaker, other agents, embeddings, vector retrieval, and model calls
- ProjectRequest, Deal, negotiation, TermsVersion, and approvals
- Wallet verification, escrow, stablecoin transfer, and Polkadot integration
- Redis, scheduled jobs, notifications, and deployment
- PortfolioItem, object-storage uploads, and private DealDeliverable
- Licensing existing recordings or compositions
- Availability calendars or capacity-based inventory
- Verification and moderation administration interfaces
- Migration compatibility for disposable pre-release mock fixtures

## Further Notes

- The Milestone 1 scope and contract form a baseline for parallel database, API, and web work. Shared
  changes require integration-owner approval and notification to all streams.
- The approved domain vocabulary lives in the root glossary. Architecture rationale lives in the
  accepted ADRs; this specification should not redefine those terms inconsistently.
- Later milestone sequencing remains provisional and requires separate stress-testing before
  implementation.
