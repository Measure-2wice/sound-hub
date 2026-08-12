# Milestone 2 reconciliation with approved M1.1

- **Status:** Provisional shaping evidence, not a Milestone 2 specification or implementation plan
- **M1.1 authority:** merged `main` at `3d28a6a` (PR #11)
- **Reviewed implementation head:** `17a4a71`; PR #11 records an approved Codex re-review at
  `5ab0c9c` with no P0, P1, or P2 findings

## Outcome

The approved Milestone 2 product decisions remain valid. M1.1 materially changes one delivery
assumption: Milestone 2 cannot begin directly with the five approved vertical slices. It first needs
a shared schema-reconciliation gate. The M1.1 schema was sufficient for anonymous read-only search,
but several deliberately minimal representations cannot safely become authenticated onboarding
write models without migration.

This gate is not a new product feature and does not reopen a grilling decision. It makes the already
approved decisions executable against the real M1.1 database.

## Material implementation evidence and updated decisions

### 1. Workspace ownership must become membership-canonical

**M1.1 evidence:** `Workspace.ownerUserId` stores one owner independently from
`WorkspaceMembership.role`, whose closed values are `Owner | Admin | Member`. The seed treats the
singular owner pointer as a canonical invariant. This cannot represent the approved multiple-Owner
model and creates two sources of authority.

**Updated M2 implementation decision:** active `WorkspaceMembership` records are the only canonical
source of Workspace authority. M2 migrates the M1.1 `ownerUserId` owner into an Owner membership,
maps the M2 public permission model to `Owner | Editor`, and removes or demotes the singular owner
pointer so it cannot authorize. The no-orphan invariant is enforced transactionally for
organizational Workspaces; personal Workspaces retain exactly one Owner and no invitations.

### 2. Draft publication and platform enforcement require separate representations

**M1.1 evidence:** `SellerProfileStatus` combines `Draft | Published | Suspended`, and required
SellerProfile and ServiceOffering fields are stored directly on the live records. M1.1 has no
working-revision model or revision counter. Incomplete drafts and atomic review/publish of edits are
therefore impossible without changing the data shape. SellerProfile suspension also overwrites the
same field used for seller-controlled publication intent.

**Updated M2 implementation decision:** the schema-reconciliation gate separates seller-controlled
publication state from platform enforcement and introduces revisioned working/published content for
SellerProfile and ServiceOffering. Existing M1.1 seller and offering rows are preserved as the
initial published revisions. Draft completeness is validated at publication/activation, not by
requiring every field while a working draft is being prepared. Optimistic concurrency uses an
explicit revision/version value rather than `updatedAt` alone.

`ServiceOfferingStatus` already matches the approved `Draft | Active | Paused | Archived` lifecycle
and remains the lifecycle vocabulary; M2 adds command enforcement that makes `Archived` terminal.

### 3. Provider-neutral authentication needs a credential mapping

**M1.1 evidence:** `UserAccount` has a stable internal ID, which supports the approved M2 boundary,
but its only identity field is a unique email. There is no provider/subject mapping, credential
revocation version, closure state, or session-security state.

**Updated M2 implementation decision:** preserve existing `UserAccount.id` values and introduce a
separate unique authentication-identity mapping keyed by provider and provider subject. Provider
identifiers never become Workspace or marketplace identifiers. Account email remains private data
and does not substitute for the provider subject. M2 adds the account/session state required for
immediate all-device revocation and closure instead of replacing M1.1 account IDs.

### 4. Closure and audit retention cannot rely on M1.1 delete cascades

**M1.1 evidence:** deleting a Workspace cascades through memberships, capabilities, SellerProfile,
offerings, affiliations, service areas, included services, and pricing. No audit records or closure
states exist.

**Updated M2 implementation decision:** ordinary account and Workspace removal is implemented as
the approved closure-first state transition, never as a direct hard delete of the M1.1 graph. The
schema-reconciliation gate adds closure/enforcement metadata and immutable audit records before
authenticated mutation commands ship. Later retention processing may delete or anonymize only data
that its approved retention class permits.

### 5. Reuse M1.1 seams precisely rather than copying search-specific details

**M1.1 evidence:**

- Shared Zod schemas are the executable HTTP contract.
- Express owns request parsing, request IDs, and safe error mapping.
- Application services depend on repository interfaces; Prisma stays below adapters.
- The composition root supports injected services/Prisma for testing.
- PostgreSQL, not `@soundhub/types`, is canonical for ServiceCategory, Specialty, and PricingUnit
  keys.
- The current safe error codes and repository interface are search-specific.
- `x-request-id` is correlation data and does not provide idempotency.
- The guarded disposable-PostgreSQL cycle, deterministic seed, API contract tests, repository tests,
  and real browser tracer are proven infrastructure.

**Updated M2 implementation decision:** onboarding follows the same dependency direction, runtime
validation, allow-listed DTO, request-ID, safe-envelope, and real-PostgreSQL test patterns. It adds
separate command repositories/services and onboarding-specific error codes rather than expanding
`TalentSearchRepository` or reusing search codes. Controlled onboarding values are resolved from
PostgreSQL through an application seam. Consequential commands use a dedicated idempotency key and
transaction; a request ID is never treated as that key.

## Delivery-shape update

The approved five vertical slices remain in order, preceded by:

0. **Shared M2 schema reconciliation:** ownership authority, provider identity mapping,
   publication/enforcement separation, working revisions, closure/audit foundations, migration and
   backfill of the approved M1.1 data, and focused migration tests.

Only after this shared gate is accepted should the five shaped slices begin:

1. Authentication, sessions, and automatic personal Workspace
2. Explicit Workspace context plus organizational invitations and membership authority
3. Seller capability, SellerProfile onboarding, and draft publication
4. ServiceOffering onboarding, lifecycle, revisions, and search eligibility
5. Reporting, suspension, audit completeness, and the full acceptance journey

This is a reconciliation constraint for later specification work. It is not authorization to create
Milestone 2 tickets or implement the migration.

## Gate 0 conclusion classification

| Gate 0 conclusion                                                                                                                                                                       | Classification                                  | Authoritative destination                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Active WorkspaceMembership is the only source of Workspace authority; `ownerUserId` cannot authorize                                                                                    | Already implied by accepted M2/domain decisions | Clarified in ADR 0001; role names, migration, backfill, and no-orphan transaction belong in the M2 specification |
| Publication intent, offering lifecycle, and platform enforcement are separate                                                                                                           | Already implied by accepted M2/domain decisions | Existing product baseline and ADR 0002; schema migration details belong in the M2 specification                  |
| Published SellerProfile and ServiceOffering content uses immutable revisions distinct from working drafts                                                                               | New durable architecture decision               | ADR 0005                                                                                                         |
| External authentication proves login while SoundHub owns durable identity and authorization                                                                                             | New durable architecture decision               | ADR 0004                                                                                                         |
| Account and Workspace removal uses closure before selective deletion/anonymization                                                                                                      | New durable architecture decision               | ADR 0006                                                                                                         |
| Preserve M1.1 IDs and backfill current rows as initial published revisions                                                                                                              | Specification-level implementation constraint   | M2 specification                                                                                                 |
| Use explicit revision values, dedicated idempotency keys, transactional commands, command-specific repositories, and onboarding error codes                                             | Specification-level implementation constraint   | M2 specification and contracts                                                                                   |
| Reuse shared Zod contracts, allow-listed DTOs, request IDs, safe error envelopes, dependency injection, PostgreSQL-canonical controlled values, and real-PostgreSQL test infrastructure | Specification-level implementation constraint   | M2 specification and acceptance gates                                                                            |
| Gate 0 precedes the five shaped vertical slices                                                                                                                                         | Specification-level implementation constraint   | M2 specification and plan                                                                                        |
| M1.1 commit hashes, review-round history, schema observations, and rationale for reconciliation                                                                                         | Temporary research/context                      | This document only                                                                                               |

No accepted Milestone 2 product decision was reversed by M1.1 evidence. The authoritative ADRs
record only the durable boundaries; the future specification owns exact schemas, migration order,
commands, contracts, and acceptance tests.
