# Buildathon Golden Slice

- **Status:** Approved buildathon-only implementation specification
- **Deadline:** August 31, 2026
- **Governance authority:** `APPROVE_BUILDATHON_SPEC_GATE`
- **Depends on:** Completed Milestone 1 database-backed talent and offering search
- **Domain language:** `CONTEXT.md`
- **Architecture decisions:** Accepted ADRs in `docs/adr/`

This is a separately governed, cross-milestone buildathon slice. It is not completion of Milestone
2, it is not the production Milestone 3 specification, and it does not satisfy or bypass the
production freeze gate requiring acceptance of GitHub issue #31 before production Milestone 3 may
freeze. Partial implementation of an existing milestone ticket under this specification must not be
reported as acceptance of that ticket or milestone.

## Problem Statement

SoundHub can retrieve real Caribbean sellers and Active ServiceOfferings from PostgreSQL, but it
cannot yet demonstrate the complete marketplace proposition in an internet-accessible beta. A buyer
cannot sign in, describe a creative need in natural language, ask a real seller to work together,
record seller consent, approve immutable terms, or fund a Deal through even a sandbox payment
boundary.

Completing the full production Milestone 2 and then separately specifying and implementing
production Milestones 3 through 5 is not achievable before the August 31, 2026 buildathon deadline.
The buildathon therefore needs one honest vertical slice that proves discovery, agreement, and
payment-gated activation without falsely presenting unfinished production systems as complete.

## Solution

Deliver one supervised, implementation-bounded Golden Slice in which a buyer authenticates through
a managed email magic link, acts through an authorized Buyer-capable Workspace, submits a
natural-language ProjectBrief, and receives AI-assisted recommendations produced through the
existing PostgreSQL TalentSearchService. Search results include bounded MP3 discovery samples for
the matching ServiceOffering. An authenticated seller acting through the owning Seller-capable
Workspace can upload, list, play, and remove those bounded samples through Supabase Storage behind
a provider-neutral storage boundary.

The buyer selects an eligible ServiceOffering and creates a persisted ProjectRequest. A separately
authenticated seller acts through the owning Seller-capable Workspace and explicitly accepts the
request, which creates a Negotiating Deal. AI drafts an immutable structured TermsVersion, but the
buyer and seller must independently approve the same current version. The buyer then explicitly
initiates clearly labeled sandbox funding through a MockEscrowProvider. A deterministic application
service moves the Deal to Active only after seller consent, both current-version approvals, and
funding confirmation are present.

PostgreSQL remains authoritative. Managed authentication and object storage are replaceable
adapters, AI operates behind validated boundaries, and no provider or agent receives marketplace or
financial authority.

## User Stories

1. As a buyer human, I want to authenticate by email magic link, so that the deployed beta feels like a usable passwordless marketplace.
2. As a returning human, I want an external provider identity mapped to my persisted SoundHub UserAccount, so that changing providers does not change my marketplace identity.
3. As a demo operator, I want deterministic authentication available for tests and emergency recovery, so that provider failure does not destroy the submission demo.
4. As a Workspace member, I want every consequential action to identify the Workspace I am acting for, so that authority is never inferred from browser context or account identity alone.
5. As a Workspace, I want the server to verify current WorkspaceMembership for every command, so that revoked or unrelated humans cannot act for me.
6. As a buyer, I want to describe my creative need in natural language, so that I do not need to understand SoundHub's search taxonomy.
7. As a buyer, I want the required demo brief interpreted directly into validated search criteria, so that clarification is not required to complete the Golden Slice.
8. As a buyer, I want hard requirements preserved as required constraints, so that AI cannot silently broaden my request.
9. As a buyer, I want recommendations drawn from real PostgreSQL-backed sellers and Active ServiceOfferings, so that the product does not fabricate marketplace supply.
10. As a buyer, I want explanations tied to actual search and offering evidence, so that I can judge a recommendation rather than trust an unsupported AI claim.
11. As a buyer, I want to play up to three MP3 samples attached to a matching ServiceOffering, so that I can hear bounded evidence relevant to the offered work.
12. As a seller, I want to upload MP3 discovery samples to my own ServiceOffering, so that buyers can hear evidence relevant to the work I offer.
13. As a seller, I want to list, play, and remove my ServiceOffering samples, so that I can manage the bounded discovery audio I publish.
14. As a seller, I want unrelated or unauthorized Workspaces prevented from changing my samples, so that storage access follows current marketplace authority.
15. As a seller, I want discovery samples kept distinct from portfolios, catalogs, licenses, and deliverables, so that publishing a sample does not imply unsupported rights or workflow behavior.
16. As a buyer, I want SoundHub to revalidate the selected seller and ServiceOffering before creating a ProjectRequest, so that a stale search result cannot bypass current eligibility.
17. As a buyer Workspace, I want my ProjectRequest persisted before a Deal exists, so that inviting a seller is not misrepresented as agreement.
18. As a seller, I want to explicitly accept or decline a ProjectRequest, so that AI or buyer intent cannot manufacture my consent.
19. As a seller, I want acceptance to create a Negotiating Deal rather than Active work, so that consent to negotiate is not approval of terms.
20. As either party, I want AI-drafted proposed terms visibly labeled as a draft, so that agent assistance is not mistaken for human approval.
21. As either party, I want scope, deliverables, schedule, price, currency, revision allowance, rights summary, and an optional displayed funding deadline captured in one structured TermsVersion, so that both parties review the same proposal.
22. As either party, I want every TermsVersion immutable, so that an approved proposal cannot change underneath my approval.
23. As either party, I want a material change to create a new version and invalidate earlier approvals, so that consent applies only to the reviewed terms.
24. As a buyer DealApprover, I want to approve the current TermsVersion explicitly, so that AI cannot bind my Workspace.
25. As a seller DealApprover, I want to approve the same current TermsVersion independently, so that buyer approval cannot stand in for mine.
26. As a buyer, I want sandbox funding to require an explicit action after mutual approval, so that approval alone never represents payment authorization.
27. As either party, I want mock funding clearly labeled in every relevant interface, so that simulated stablecoin movement is never presented as real settlement.
28. As either party, I want the Deal to become Active only after mutual current-version approval and confirmed sandbox funding, so that commissioned work begins at a deterministic boundary.
29. As either party, I want to see seller consent, both approvals, and funding confirmation together, so that the reason the Deal is Active is inspectable.
30. As an engineer, I want runtime-validated contracts at browser, API, AI, and provider boundaries, so that untrusted input cannot create ambiguous state.
31. As an engineer, I want provider-neutral authentication, storage, AI, and escrow interfaces, so that buildathon vendors do not become domain authorities.
32. As a reviewer, I want one integrated browser journey backed by real PostgreSQL, so that submission readiness is demonstrated without multiplying fragile end-to-end tests.
33. As a buildathon reviewer, I want an honest boundary between real application state and labeled mocks, so that SoundHub's demo claims remain credible.

## Implementation Decisions

### Governance and delivery boundary

- This specification alone authorizes ticket shaping and implementation for the Golden Slice. It
  does not authorize publication of the production Milestone 3 specification or modification of
  the GitHub #31 freeze gate.
- Work is optimized for the August 31 submission. Only behavior under **Required acceptance
  criteria** may block the Golden Slice. Optional and post-buildathon behavior must not become a
  dependency through ticket structure, test gates, or review expectations.
- Ralph and new orchestration infrastructure are excluded from the buildathon critical path.

### Authentication and Workspace authority

- The deployed primary path uses managed email magic-link authentication, preferably Supabase Auth,
  behind a provider-neutral authentication interface.
- Provider identity is a credential mapping to a persisted SoundHub UserAccount. Provider subjects,
  claims, roles, and metadata never identify or authorize a Workspace.
- The server validates the authenticated session. A client-supplied UserAccount identifier is never
  accepted as proof of identity.
- Every ProjectRequest, response, terms, approval, and funding command explicitly carries the acting
  Workspace identifier. The application service revalidates the authenticated human's current
  WorkspaceMembership and the required Workspace capability or record ownership within the command
  boundary.
- `Workspace.ownerUserId` may remain structurally present, but no new Golden Slice command may read
  it as an authorization source. GitHub issue #17 is not a prerequisite for this slice.
- The buyer and seller demo identities, Workspaces, capabilities, memberships, and one explicit
  DealApprover authorization per party are persisted. Being authenticated, being an Owner, or
  possessing a Buyer or Seller capability does not itself record approval.
- A deterministic local authentication adapter implements the same application-facing contract for
  automated tests and emergency demo recovery. It must still establish server-validated identity;
  the browser may not freely assert or select an arbitrary UserAccount.
- Managed authentication receives one bounded implementation slice. If deployed email delivery,
  callback/session integration, or deployment configuration cannot pass its bounded environment
  smoke test within that slice, the deterministic adapter is the approved deployed fallback. This
  fallback changes credential verification only and requires no redesign or relaxation of
  Workspace authorization.
- Production session lifetime, all-device revocation, email-change recovery, invitations, operator
  MFA, and organizational administration are not required here.

### ServiceOffering audio samples

- A ServiceOffering may own zero through three `ServiceOfferingAudioSample` records. The concept is
  a bounded discovery attachment, not a PortfolioItem, playlist, catalog asset, licensed work, or
  Deal deliverable.
- Each sample records an identifier, owning ServiceOffering, buyer-facing title or label, MIME type,
  byte size, deterministic display order, and an opaque storage reference. PostgreSQL is canonical
  for this metadata; object bytes live in bounded external storage.
- The deployed primary storage adapter uses Supabase Storage. Application contracts remain
  provider-neutral and never expose bucket names, object keys, credentials, or private storage
  locations.
- Only MP3 content is allowed and each object is limited to 25 MB. Duration validation is not
  required. The server enforces count, declared/observed content type, and size at the trusted
  upload or seed boundary rather than trusting browser metadata.
- Public playback uses an allow-listed public asset URL or a narrowly scoped read URL derived by the
  server. Search DTOs expose only buyer-safe metadata and the playable URL.
- An authenticated seller acting through a currently authorized Seller-capable Workspace can
  upload a sample to, list samples for, play samples from, and remove samples from a ServiceOffering
  owned by that Workspace. Each write revalidates authenticated UserAccount identity, current
  WorkspaceMembership, Seller capability, and ServiceOffering ownership.
- Upload persists the PostgreSQL metadata and opaque storage reference only after the storage
  operation succeeds. Removal makes the sample unavailable to buyer-facing discovery and removes
  or schedules cleanup of the bounded stored object without exposing provider internals.
- Replacement requires no specialized operation; the seller may remove a sample and upload a new
  one. Reordering, drag-and-drop, waveform generation, duration enforcement, transcoding, album art,
  and generalized media management are not required.
- Guarded seed/import ingestion remains available for automated tests, deterministic browser
  fixtures, and backup demo data, but seeded ingestion alone does not satisfy the deployed seller
  upload requirement.

### Matchmaker and search

- The Matchmaker accepts a natural-language buyer need under the acting buyer Workspace and creates
  a Workspace-owned ProjectBrief containing the original text, validated required constraints,
  validated preferences, and non-search project requirements.
- The required golden brief proceeds directly from natural-language interpretation to validated
  search criteria without clarification. The architecture may support at most one targeted
  clarification when a hard requirement is materially ambiguous, but that interaction is optional
  and cannot block acceptance. Required constraints may never be silently relaxed.
- AI output is parsed through a strict runtime schema before use. Invalid, unavailable, or unsafe AI
  output falls back to a deterministic interpretation suitable for the seeded golden request; the
  fallback crosses the same validation and TalentSearchService boundaries.
- The Matchmaker invokes the existing TalentSearchService rather than Prisma or a new retrieval
  implementation. PostgreSQL eligibility and deterministic ranking remain authoritative.
- Recommendations reference only returned eligible sellers and ServiceOfferings. Explanations must
  be grounded in the validated brief and actual search result evidence; AI cannot invent
  qualifications, availability, verification, prices, or sample rights.
- `relevanceScore` remains strategy-specific ordering and is not displayed as confidence or a
  buyer-facing percentage.

### ProjectRequest and seller consent

- ProjectRequest creation requires an authenticated human, an authorized Buyer-capable acting
  Workspace, a persisted ProjectBrief, and one selected ServiceOffering returned by or compatible
  with the brief's validated search criteria.
- Immediately before creation, the server revalidates Workspace state, Seller capability,
  SellerProfile publication, ServiceOffering Active state, and ownership. A stale or ineligible
  selection fails safely and creates neither ProjectRequest nor Deal.
- A ProjectRequest persists the buyer Workspace, seller Workspace, selected ServiceOffering,
  ProjectBrief snapshot/reference, creation actor, creation time, and status. The required statuses
  are `Pending | Accepted | Declined`.
- Only a currently authorized member of the seller Workspace may accept or decline. A terminal
  response cannot be reversed within this slice.
- Decline records the seller human and time and creates no Deal. Acceptance records seller consent
  and atomically creates exactly one Deal in `Negotiating`; retries cannot create duplicate Deals.

### Deal, TermsVersion, and approvals

- The Golden Slice requires only `Negotiating` and `Active` Deal states. Negotiating begins only from
  ProjectRequest acceptance. Active is reached only through the deterministic activation invariant.
- AI may propose structured terms only for a Negotiating Deal. The UI identifies the proposal as
  AI-drafted and states that it is not approved.
- Every TermsVersion is append-only and belongs to exactly one Deal. It has a monotonically
  increasing version number and captures at minimum scope, one or more deliverable requirements,
  schedule, USD price in minor units, revision allowance, and rights summary. A funding deadline may
  also be stored and displayed, but the Golden Slice does not enforce its passage.
- Material changes create a new TermsVersion; existing rows are never updated in place. Creation of
  a new current version makes all approval records for earlier versions ineffective.
- Buyer and seller approval records are independent and bind a Workspace, human actor, explicit
  DealApprover permission, TermsVersion, and timestamp. An approval is accepted only for the current
  version while the Deal is Negotiating.
- The application derives approval completeness from durable approval records. AI output, UI state,
  provider metadata, and one party's approval cannot synthesize the other party's approval.

### Mock escrow and deterministic activation

- `MockEscrowProvider` is behind a provider-neutral escrow interface intended for later replacement.
  It simulates funding only; it does not transfer tokens, verify wallets, decide permissions, or
  transition Deal state.
- The buyer's authorized human explicitly requests funding for the current TermsVersion after both
  parties have approved it. Funding cannot be initiated for an unapproved, superseded, or
  non-current version. A displayed funding deadline does not expire or invalidate terms in this
  slice.
- The request identifies a fixed buildathon sandbox asset and network label. Every relevant UI and
  persisted presentation labels the provider and confirmation as mock, simulated, or sandbox.
- The mock provider returns a deterministic confirmation containing an opaque reference, confirmed
  amount, asset/network label, current TermsVersion identifier, and confirmation time. PostgreSQL
  persists the funding attempt and confirmation.
- A deterministic application service, not the provider or AI, transitions the Deal to Active when
  and only when all of the following are true for the same current TermsVersion:
  1. The originating ProjectRequest contains explicit seller acceptance.
  2. The buyer Workspace has a valid independent approval.
  3. The seller Workspace has a valid independent approval.
  4. Mock funding is confirmed for the exact approved amount and version.
- The transition and confirmation persistence use database transactions, natural uniqueness
  constraints, durable identifiers, and guarded state transitions so repeated callbacks or command
  retries cannot duplicate confirmation or activate the Deal twice. A generalized idempotency-key
  subsystem is not required.
- Wallet verification, browser-wallet signing, payout authorization, real token movement, release,
  refund, cancellation, and blockchain connectivity are not prerequisites.

### Contracts, privacy, and failure behavior

- Shared runtime schemas allow-list authenticated requests and responses. Prisma models, provider
  subjects, private emails, session tokens, storage keys, and internal AI data never cross public or
  counterparty DTOs.
- Express owns untrusted request parsing, safe error envelopes, and request IDs. Application
  services own authorization and state transitions; repositories own persistence; adapters own
  provider translation.
- PostgreSQL failure fails closed for persistence and authority. Authentication failure never falls
  through to a demo identity. AI failure may use the approved deterministic fallback but cannot
  bypass search validation. Storage failure removes or disables playback without fabricating a
  sample. Escrow-provider failure leaves the Deal Negotiating.
- Consequential writes must apply completely or not at all and be safe under the retries exercised
  by the integrated journey. Retry safety should use database transactions, natural uniqueness
  constraints, durable identifiers, and guarded state transitions; it does not require a generalized
  idempotency framework.

## Required Acceptance Criteria

1. The production M3 freeze gate and GitHub #31 remain unchanged, and the Golden Slice is labeled as neither M2 completion nor production M3.
2. The deployed beta can authenticate the buyer and seller through managed email magic links, subject to the approved bounded fallback trigger.
3. Both authentication adapters map credentials to persisted UserAccounts and produce server-validated sessions through the same application boundary.
4. Every Golden Slice command names an acting Workspace and rejects a human without a current qualifying WorkspaceMembership.
5. A matching legacy `Workspace.ownerUserId` grants no Golden Slice authority without current membership.
6. The selected buyer and seller Workspaces, capabilities, memberships, and DealApprover authorizations are persisted in PostgreSQL.
7. An authenticated seller acting through a current WorkspaceMembership in the owning Seller-capable Workspace can upload an MP3 sample to its ServiceOffering, list existing samples, play them, and remove them.
8. An unrelated Workspace, a non-member, or a member without the required authority cannot upload or remove samples for the ServiceOffering.
9. A successful upload persists buyer-safe ServiceOfferingAudioSample metadata and an opaque storage reference in PostgreSQL and produces playable buyer-facing output without exposing storage internals.
10. An Active ServiceOffering can expose zero to three playable MP3 discovery samples, and removal stops a sample from appearing in buyer-facing discovery.
11. The upload boundary rejects a fourth sample, a non-MP3 object, or an object larger than 25 MB; duration is not an acceptance condition.
12. The deployed upload path uses Supabase Storage behind the provider-neutral boundary, while deterministic storage fixtures can replace it in automated tests.
13. A natural-language golden brief proceeds directly to runtime-validated search criteria and invokes the existing PostgreSQL TalentSearchService without requiring clarification.
14. Required constraints are never silently relaxed, whether criteria come from AI or the deterministic fallback.
15. Every displayed recommendation and explanation refers to a returned eligible seller and ServiceOffering and uses factual match evidence.
16. ProjectRequest creation revalidates current eligibility and persists a Pending request owned by the buyer Workspace; it does not create a Deal.
17. Only an authorized seller Workspace member can accept or decline the request.
18. Decline creates no Deal; acceptance records seller consent and creates exactly one Negotiating Deal.
19. AI-drafted terms are visibly non-approved and persist as an immutable structured TermsVersion.
20. A material terms change creates a new version and makes approvals of all earlier versions insufficient for activation.
21. Buyer and seller DealApprovers can independently approve the same current version, with Workspace and human attribution persisted.
22. Funding is unavailable until both approvals exist for the current version and must be initiated explicitly by the authorized buyer; a displayed funding deadline is not enforced for Golden Slice acceptance.
23. MockEscrowProvider and every funding status are clearly identified as sandbox or simulated behavior.
24. Provider confirmation is persisted for the exact current TermsVersion and amount, and provider failure leaves the Deal Negotiating.
25. The Deal becomes Active only when seller acceptance, buyer approval, seller approval, and matching funding confirmation all exist.
26. Database transactions, natural uniqueness constraints, durable identifiers, and guarded state transitions prevent retries from creating duplicate ProjectRequests, Deals, approvals, funding confirmations, or activation transitions along the golden path; no generalized idempotency-key subsystem is required.
27. The Active Deal view displays seller consent, buyer approval, seller approval, sandbox funding confirmation, and the terminal message: **Deal Active — escrow funded; commissioned work may begin.**
28. The one integrated golden browser journey passes against a real disposable PostgreSQL database; focused automated tests cover each rejected inverse without adding another end-to-end journey.
29. Type checking, linting, focused tests, production builds, formatting checks, and a deployed-beta smoke test pass for the Golden Slice.

## Testing Decisions

- Tests assert observable contracts, authorization outcomes, state transitions, and persisted
  evidence rather than ORM call order, provider SDK internals, component structure, or private
  helper functions.
- There is exactly one integrated golden browser journey:

  ```text
  buyer opens deployed-style app
  → requests and completes deterministic magic-link authentication
  → acts through the seeded Buyer-capable Workspace
  → submits one natural-language creative brief
  → Matchmaker emits validated criteria
  → real PostgreSQL TalentSearchService returns eligible recommendations
  → buyer plays a ServiceOffering MP3 sample
  → buyer selects that ServiceOffering
  → server revalidates eligibility and persists a ProjectRequest
  → buyer signs out
  → seller completes deterministic magic-link authentication
  → acts through the owning Seller-capable Workspace
  → seller explicitly accepts the ProjectRequest
  → one Negotiating Deal is created
  → AI-drafted structured TermsVersion 1 is persisted and shown as unapproved
  → seller explicitly approves TermsVersion 1
  → seller signs out
  → buyer signs in and explicitly approves TermsVersion 1
  → buyer explicitly initiates labeled sandbox funding
  → MockEscrowProvider confirms funding for TermsVersion 1
  → deterministic service transitions the Deal to Active
  → UI displays seller consent, both approvals, sandbox confirmation, and the terminal message
  ```

- The browser journey uses the deterministic authentication, AI, storage-fixture, and escrow
  adapters while crossing the same application interfaces as deployed providers. It crosses the
  browser UI, same-origin Next.js boundary, Express runtime validation, authorization and domain
  services, Prisma repositories, and real disposable PostgreSQL.
- One bounded deployed-environment smoke test covers Supabase magic-link delivery/callback/session
  handling and Supabase Storage upload and playback. It is provider verification, not a second
  product journey.
- Focused adapter contract tests require managed and deterministic authentication adapters to obey
  the same identity/session contract; live and deterministic storage adapters to enforce the same
  upload, removal, and safe-reference contract; AI adapters to return validated structures or fail;
  and MockEscrowProvider to return deterministic, version-bound confirmations.
- Authorization service and API tests prove explicit acting Workspace, current membership,
  capability/ownership checks, explicit DealApprover authority, rejection after membership loss,
  and the prohibition on `ownerUserId` authorization.
- Focused audio tests prove that an authorized seller Workspace can upload to its own
  ServiceOffering; unrelated and unauthorized Workspaces cannot upload or remove; a fourth sample,
  non-MP3 sample, and sample larger than 25 MB are rejected; successful upload persists PostgreSQL
  metadata and produces playable buyer-facing output; removal removes the sample from buyer-facing
  discovery; and deterministic storage fixtures replace live Supabase Storage in automated tests.
- Matchmaker tests prove strict structured-output validation, the required direct brief-to-criteria
  path, required-constraint preservation, factual explanations, real TalentSearchService invocation,
  and deterministic fallback behavior. Clarification interaction tests are optional.
- Repository and service tests use real disposable PostgreSQL where persistence semantics matter.
  They cover eligibility revalidation, ProjectRequest response atomicity, one-Deal creation,
  immutable version numbering, approval invalidation, independent approvals, version-bound funding,
  and the full activation invariant.
- Focused negative tests cover all incomplete activation combinations, stale or superseded terms,
  wrong-Workspace actors, declined requests, ineligible offerings, provider failure, and duplicate
  retries. They do not require clock-driven funding-expiration cases or additional browser journeys.
- Existing M1 shared Zod contracts, safe error envelopes, injected service/repository seams,
  in-memory unit fakes, guarded PostgreSQL tests, deterministic seed behavior, and Playwright tracer
  are preferred prior art.
- Automated acceptance must not depend on live email, live AI, external storage availability, or a
  blockchain. The deployed smoke test is the bounded evidence for configured managed providers.

## Optional If Ahead

- One visible material terms edit that demonstrates approval invalidation in the product UI.
- A small activity timeline derived from already-required state evidence.
- An at-most-one-material-clarification Matchmaker interaction and improved provider-fallback
  messaging.
- Additional seeded Caribbean marketplace presentation and deployment polish.
- A backup demo recording and operational runbook.

These items must be independently removable. Their absence or failure cannot block acceptance,
deployment, or submission.

## Out of Scope

- Completion or acceptance of Milestone 2 or GitHub issue #31.
- Publication or implementation of the production Milestone 3 specification.
- GitHub issue #17 legacy-model contraction, provided all new authority uses current
  WorkspaceMembership exclusively.
- Full consent/versioned-notice infrastructure, production seller onboarding, publication revision
  breadth, invitations, team administration, activity feeds, exports, closure, restoration,
  reporting, moderation, contested-control freezes, and operator security breadth.
- Production session lifecycle, inactivity and absolute expiry policies, all-device revocation,
  protected email change, recovery, and operator passkeys.
- General PortfolioItem, playlist, media library, waveform, catalog, licensing, rights-management,
  delivery, or private-file systems.
- Audio reordering, drag-and-drop, waveform generation, duration enforcement, transcoding,
  playlists, album art, specialized replacement, and generalized media management.
- Vector search, a new search engine, required Redis infrastructure, or generalized background jobs.
- Required Matchmaker clarification, open-ended Matchmaker conversation, broad safety workflows,
  autonomous negotiation, or AI approval.
- Terms negotiation breadth beyond creating immutable structured versions and proving invalidation.
- Funding-deadline expiration enforcement, clock-driven terms invalidation, and expired-terms
  behavior. A deadline may remain in structured terms for display only.
- A generalized idempotency-key framework; Golden Slice retry safety remains required at its
  concrete write and transition boundaries.
- Wallet verification, WorkspaceWalletAuthorization, wallet rotation, browser-wallet signing, real
  stablecoin movement, production Polkadot integration, payout, release, refund, cancellation,
  partial payment, or blockchain hardening.
- Delivery, revisions, acceptance, monitoring, reminders, disputes, operator adjudication, and the
  production audit program.
- New orchestration infrastructure or restoration of Ralph to the buildathon critical path.

## Further Notes

- The Golden Slice intentionally consumes completed M1 seller/offering data and search behavior. It
  does not require production onboarding to recreate that supply before the demo.
- Seller upload, list/play, and removal are required deployed behavior. Guarded seed/import ingestion
  remains supported for deterministic tests and backup demo data but cannot substitute for the
  deployed seller-upload path.
- The required 3–5 minute browser journey may use a previously uploaded or deterministically seeded
  sample and need not demonstrate seller audio management live.
- A displayed funding deadline carries no Golden Slice state-transition effect. Activation depends
  only on seller consent, both parties approving the same current TermsVersion, and matching
  confirmed sandbox funding.
- The approved managed-auth fallback is a deadline protection mechanism, not permission to weaken
  identity, session validation, or Workspace authorization.
- Any ticket derived from this specification must identify which required acceptance criteria it
  satisfies and must not absorb optional or post-buildathon work as a dependency.
- If the Golden Slice is later promoted into the production roadmap, it must be reconciled through
  the unchanged production milestone governance process rather than silently becoming the
  production M3 contract.
