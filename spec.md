# SoundHub Product Specification

- **Status:** MVP architecture baseline
- **Current implementation target:** Milestone 1 — database-backed talent and offering search
- **Domain language:** [`CONTEXT.md`](./CONTEXT.md)
- **Architecture decisions:** [`docs/adr/`](./docs/adr/)

## 1. Product statement

SoundHub is an AI-assisted creative-services marketplace where people and organizations discover
Caribbean talent, commission original work, agree to project terms, exchange private deliverables,
and settle payment in stablecoins through Polkadot-compatible escrow.

The music MVP serves artists, producers, musicians, songwriters, sound engineers, managers,
executives, licensing houses, brands, agencies, and sync buyers. The model must later accommodate
videographers, video editors, influencers, and other creatives without replacing its identity,
authority, discovery, or deal boundaries.

## 2. Product problem

Caribbean creative talent is globally influential but fragmented across social platforms,
marketplaces, and informal networks. Buyers struggle to identify an appropriate collaborator;
sellers struggle to communicate purchasable services and receive international payment; both sides
lack a shared record of project scope, delivery, approval, and settlement.

SoundHub addresses three problems:

1. **Discovery:** turn a buyer's creative brief into relevant sellers and active offerings.
2. **Agreement:** help both marketplace parties negotiate and approve the same immutable terms.
3. **Trust:** preserve delivery evidence and explicit payment authorization through an auditable,
   deterministic workflow.

## 3. Canonical marketplace model

### 3.1 Identity and authority

- A `UserAccount` represents one human login.
- A `Workspace` represents the personal or organizational marketplace party the human acts for.
- A human acts for a Workspace through a revocable `WorkspaceMembership`; shared credentials are
  prohibited.
- Buyer and Seller are independent Workspace capabilities, not exclusive occupations or user roles.
- Personal creative Workspaces may buy, sell, or do both.
- Bands, studios, and creative collectives may be organizational sellers.
- Managers, executives, licensing houses, brands, and agencies remain buyer-only in the MVP when
  acting in those capacities.
- One Workspace owns at most one SellerProfile in the MVP. One UserAccount may belong to multiple
  Workspaces, enabling separate brands without multiple human logins.
- Specialty, Workspace type, and professional label never grant authorization.

SoundHub records declared platform authority but does not decide group-name ownership, copyright
ownership, internal revenue division, or membership disputes. Before real-money production use,
terms of service, authority representations, and dispute procedures require qualified legal review.

### 3.2 Seller discovery

- `SellerProfile` contains public professional identity, biography, specialties, location, and
  self-declared Caribbean affiliations.
- `Talent` is buyer-facing collective language for searchable sellers, not a database entity.
- A `Specialty` describes what a seller is professionally.
- A `ServiceOffering` describes work a buyer can commission.
- A `ServiceCategory` is a controlled record with a stable key; titles, descriptions, genres, and
  tags remain seller-authored.
- Each offering has one primary category. IncludedServices describe bundle-only work and are not
  independently purchasable without their own offering.
- Advertised pricing is optional, structured, and non-binding. Approved deal terms establish the
  binding amount.
- Offering lifecycle is `Draft | Active | Paused | Archived`.
- Only Active offerings enter ordinary search. Paused offerings may remain visible from a direct
  seller profile but cannot initiate a new ProjectRequest.
- A seller can self-publish without formal verification. Publication, verification, and platform
  enforcement remain separate concepts.

CaribbeanAffiliation is self-declared and distinct from current location, legal nationality,
service area, and verification. Service mode belongs to each offering and may be Remote, InPerson,
or Hybrid.

### 3.3 Commissioning versus licensing

The MVP supports commissioning original music and creative services for sync-related projects. It
does not support searching or licensing existing recordings or compositions. Portfolio samples do
not imply that an uploader controls all relevant rights.

The following remain distinct:

- `PortfolioItem`: future public, permissioned evidence of previous work.
- `DealDeliverable`: private work submitted under a Deal.
- Catalog asset: future licensing-domain record outside the MVP.

## 4. Discovery architecture

### 4.1 Milestone 1 retrieval

Milestone 1 implements deterministic PostgreSQL-backed talent search. The browser may submit text
and optional structured criteria. The core search input distinguishes:

- **Required constraints:** candidates that do not satisfy them are excluded.
- **Preferences:** matches improve ranking but do not become exclusions.

The response returns one result per seller, led by the best matching Active offering and optionally
including additional matching offerings. `relevanceScore` is an algorithm-specific ordering value,
not a probability or confidence level, and is not shown as a buyer-facing percentage.

Search results are discovery snapshots. Before creating a ProjectRequest, SoundHub revalidates the
Workspace, Seller capability, SellerProfile publication, and ServiceOffering state. Another buyer's
request does not consume an offering as inventory.

### 4.2 Matchmaker

The authenticated Matchmaker experience later:

1. Interprets the buyer's natural-language brief.
2. Asks one targeted clarification when a hard requirement is ambiguous.
3. Produces required constraints and preferences.
4. Invokes TalentSearchService through SearchTalentTool.
5. Reranks or explains valid candidates without bypassing eligibility rules.

Required constraints are never silently relaxed. The Matchmaker may propose a relaxation, but must
obtain buyer approval before rerunning search.

Public deterministic search remains anonymous. Matchmaker sessions and ProjectRequest creation
require an authenticated UserAccount; ProjectRequest creation also requires a Buyer-capable
Workspace.

## 5. Engagement and deal lifecycle

### 5.1 Seller consent

A buyer creates a `ProjectRequest`, not a Deal. The seller may ask a preliminary question, decline,
allow the request to expire, or accept it. Acceptance starts negotiation and creates a Deal in a
Negotiating state; it does not approve terms or activate paid work.

### 5.2 Terms and approval

- Negotiated scope, price, schedule, revision allowance, rights, and deliverables belong to an
  immutable `TermsVersion`.
- A material edit creates a new version and invalidates previous approvals.
- Buyer and seller Workspaces independently approve the same version through a member with explicit
  DealApprover authority.
- One authorized DealApprover is sufficient for a Workspace in the MVP; threshold or multisignature
  application approvals are deferred.
- Every approval records the Workspace party, human actor, permission, version, and timestamp.
- Approved terms expire if escrow is not funded by their agreed funding deadline.

Delivery schedules may use either a fixed date or a duration measured from successful activation.
Late funding must not silently compress a fixed delivery schedule.

### 5.3 Activation and payment

A Deal becomes Active only after:

1. The buyer approves TermsVersion N.
2. The seller approves TermsVersion N.
3. Escrow funding for TermsVersion N is confirmed.

Wallets are neutral blockchain resources. `WalletVerification` records proof of control at a point
in time; `WorkspaceWalletAuthorization` separately assigns a verified address for funding or payout.
Already funded deals retain payer and payout address snapshots when later authorizations change.

The first lifecycle implementation uses a clearly labeled `MockEscrowProvider` behind the interface
planned for a Polkadot provider. Stablecoin is the payment asset; network and fee asset are separate
transaction-time concerns.

### 5.4 Delivery

- Terms contain one or more DeliverableRequirements.
- Sellers submit one or more files against each requirement.
- Resubmissions create immutable DeliverableSubmissions; files are never overwritten.
- PostgreSQL stores metadata, version, checksum, size, and audit relationships. File bytes live in
  bounded external object storage.
- Buyers accept delivery or request an in-scope revision.
- The MVP releases one escrow amount only after all required deliverables are accepted.
- Partial milestone payments and partial escrow releases are deferred.

Pausing or archiving the originating offering does not alter an existing Deal. Workspace enforcement
may freeze affected funded deals for authorized operational review rather than triggering an
automatic release or refund.

## 6. Agent authority

Agents may search, clarify, rank, explain, draft terms, summarize evidence, draft reminders, identify
missing evidence, and recommend actions. They may not approve terms, fund escrow, accept delivery,
release or refund funds, cancel a Deal, or make a binding dispute decision.

Deterministic application services own permissions, state transitions, deadlines, approval
validation, and financial actions. A recoverable scheduler/job workflow owns time-based monitoring;
the Delivery Monitor Agent assists with analysis and communication but does not own the clock.

Every material agent invocation produces a privacy-bounded AgentRun audit containing agent/model and
prompt versions, redacted structured input, tool activity, validated structured output, outcome,
latency, and request ID. SoundHub does not request or store hidden chain-of-thought, credentials,
wallet challenges, or unrestricted raw private file content.

## 7. Data and reliability

- PostgreSQL is authoritative for marketplace data, conversations, agent audits, deals, approvals,
  and payment state.
- Vector indexes are derived projections and never canonical public profiles.
- Redis is not required for Milestone 1. Later it may provide replaceable queues, caches, locks, and
  rate limits; critical work must be recoverable from PostgreSQL.
- OpenAI or vector failure degrades discovery to deterministic PostgreSQL search.
- PostgreSQL failure returns a safe retriable service-unavailable response; stale vector documents
  are not served as canonical results.
- APIs use a standard safe error envelope containing a stable code, user-safe message, optional
  field errors, and request ID.
- Unknown or misspelled structured search fields are rejected rather than ignored.

## 8. Current repository state

The repository is a pnpm TypeScript monorepo with:

- Next.js frontend under `apps/web`
- Express API under `apps/api`
- Shared TypeScript package under `packages/types`
- Prisma/PostgreSQL package under `packages/db`
- Docker Compose services for PostgreSQL and Redis

The current search is an obsolete producer-only mock: it uses random scores, fake vectors,
artificial delay, and fabricated AI explanations. The Prisma and shared-type models likewise use
the older exclusive Artist/Producer role design. Milestone 1 intentionally replaces these
pre-release contracts without compatibility layers or preservation of disposable mock fixtures.

## 9. MVP scope

### Included across the MVP

- Talent and active-offering discovery
- Authenticated Workspaces and memberships
- Matchmaker clarification and recommendations
- ProjectRequest seller-consent boundary
- AI-assisted negotiation and immutable mutual approval
- Mock escrow followed by explicit wallet-authorized funding and release
- Private, versioned file delivery
- Buyer acceptance, bounded revisions, and human-admin dispute decisions
- Deterministic workflow monitoring and auditable agent assistance

### Excluded from the MVP

- Licensing existing recordings or compositions
- Automated royalty or revenue splitting
- Tokenized ownership or NFTs
- Partial milestone escrow releases
- Autonomous agent approval or financial authority
- AI dispute adjudication
- Full rights and licensing management
- Production-grade team administration beyond the approved Workspace foundation
- Public portfolio publishing until permissions, credits, and rights attestations are designed

## 10. Delivery sequence

Only Milestone 1 is implementation-ready. The remaining sequence is provisional and must be grilled
before implementation:

1. Database-backed talent and offering search
2. Authentication, Workspaces, memberships, and seller onboarding
3. Matchmaker and ProjectRequest flow
4. Negotiation, TermsVersions, and mutual approval
5. Mock escrow and deterministic Deal lifecycle
6. Private versioned delivery and acceptance
7. Monitoring, disputes, audit integration, and MVP hardening

Milestone 1's approved product and engineering specification is
[`docs/specs/milestone-1-talent-search.md`](./docs/specs/milestone-1-talent-search.md).
