# Milestone 2: Reconciled Personal Workspace Onboarding and Marketplace Readiness

- **Status:** Approved authoritative completion specification
- **Supersedes for completion:** `docs/specs/milestone-2-authenticated-workspaces-seller-onboarding.md`
- **Historical inputs:** the original Milestone 2 specification, `spec.md`, and the M2/M1.1
  reconciliation research
- **Delivered baseline:** Milestone 1 and the production-verified BG1–BG7 Buildathon Golden Slice
- **Domain language:** `CONTEXT.md`
- **Architecture decisions:** accepted ADRs in `docs/adr/`

This specification is the authoritative contract for declaring Milestone 2 complete. The original
Milestone 2 specification remains historical roadmap input and is not erased or represented as
implemented. Its requirements are traced below to delivered behavior, this reconciled milestone,
or an explicitly named later roadmap destination.

## Problem Statement

SoundHub's Golden Slice works end to end in production, but normal people cannot establish the
marketplace records required to use it. Managed Supabase magic-link authentication creates or maps
a durable `UserAccount`, yet a brand-new authenticated human has no Workspace, membership, or
capability and reaches a dead end. The production demonstration therefore required manual database
creation or repair of Personal Workspaces, Owner `WorkspaceMembership` rows, Buyer and Seller
`WorkspaceCapability` rows, explicit `DealApprover` authorizations, and seller supply records.

The underlying authorization model must not be weakened to hide this gap. Authentication proves a
human login only. A current `WorkspaceMembership` establishes the Workspace relationship; Buyer and
Seller are independent Workspace capabilities; and approving a `TermsVersion` requires a separate
explicit `DealApprover` authorization for the acting Workspace. Membership, Owner status, provider
metadata, `ownerUserId`, professional labels, and capabilities must not substitute for one another.

Milestone 2 must let two brand-new humans independently onboard as seller and buyer, create the
necessary Personal Workspace records through explicit self-service product flows, and complete the
existing Golden Slice without seed or manual authority edits. It must also recover safely from
partial or legacy states, expose truthful readiness and empty states, and preserve existing
production data. It must do this without absorbing the historical Milestone 2's organization
governance, broad account-security, moderation, export, closure, and audit programs or later M3–M7
delivery, dispute, and real-payment work.

## Solution

On first successful authentication, SoundHub converges the authenticated `UserAccount` to exactly
one Personal Workspace and exactly one current Owner membership for that human. This foundational
transaction grants no Buyer capability, Seller capability, or `DealApprover` authority. The
Workspace uses the private default name “My Workspace” and an opaque collision-resistant slug that
contains no email or provider identity. Naming is not part of intent selection and SellerProfile
publication is not coupled to renaming the Workspace.

SoundHub then asks the human to choose `Hire talent`, `Offer services`, or `Both`. An explicit,
retry-safe intent command provisions the corresponding Personal Workspace capabilities. Buyer
capability requires no buyer-specific attestation. Seller capability requires versioned Seller
participation/terms acceptance. `Both` provisions Buyer and Seller atomically after collecting the
Seller acceptance. The initial choice is not permanent: the Personal Workspace may later add the
other capability through the same explicit self-service policy and requirements. Capability
deactivation is deferred.

`DealApprover` remains capability-neutral and separate. An authenticated human acting through
their own Personal Workspace may accept a versioned approval-authority attestation to provision
their own `DealApprover`. SoundHub offers this as an optional dashboard readiness task and just in
time when either party attempts to approve terms. Provisioning authority never approves a Deal or
`TermsVersion`; after setup, the human returns to the same pending resource and must perform a
separate explicit approval action for their own Workspace side.

A Seller-capable Personal Workspace creates its stable SellerProfile identity lazily on the first
successful profile save. Incomplete pre-publication drafts are private, resumable, and retry-safe.
An explicit publish command validates the complete profile and records a versioned publication
attestation before making it public. Published profiles may exist without Active offerings, but
they remain excluded from ordinary M1 search and cannot receive new ProjectRequests. Post-publication
updates validate and atomically replace the complete public field set; persistent post-publication
working drafts and generalized revision history are not introduced.

ServiceOfferings follow the same lazy pre-activation pattern while allowing multiple legitimate
offerings per SellerProfile. Draft offerings are private and may be incomplete. Sellers manage the
existing bounded MP3 resources inside the relevant offering UI. Authorized sellers may upload,
list, privately preview, and remove samples for their own Draft offering; no draft media crosses
buyer or public boundaries. Each sample carries versioned media-use confirmation. Activation is a
separate explicit command requiring complete listing information, an explicit pricing choice, one
to three qualifying playable MP3 samples, and a versioned offering-activation attestation.

The dashboard becomes a Workspace-scoped readiness and activity home. It derives useful next
actions from durable records rather than a mutable onboarding-step flag or a permanent exhaustive
checklist. Buyer and Seller readiness remain independent, dual-capability Workspaces show both
surfaces, and missing contextual readiness does not globally block unrelated features. A
product-wide acting-Workspace selector replaces the BG1 engineering harness while every scoped or
consequential request continues to name and server-validate its acting Workspace.

## Already Delivered Through M1 and BG1–BG7

The following behavior is existing baseline, not new Milestone 2 implementation credit:

- Deterministic PostgreSQL-backed M1 seller and Active ServiceOffering search, controlled metadata,
  required/preferred filters, allow-listed DTOs, and buyer-facing service mode, location, service
  area, pricing, and audio presentation.
- Managed Supabase email magic-link authentication with production email delivery through Resend,
  provider-neutral identity adapters, durable provider-to-`UserAccount` mapping, server-owned
  sessions, `/me`, and sign-out.
- Explicit acting-Workspace identifiers and reusable server-side revalidation of current
  `WorkspaceMembership`, Workspace status, capability, resource ownership, and relevant authority.
- The invariant that `Workspace.ownerUserId` is metadata/legacy compatibility only and grants no
  authority without current membership.
- Independent Buyer and Seller `WorkspaceCapability` records.
- Explicit `DealApprover` and independent Workspace/human-attributed Deal approvals for the current
  `TermsVersion`; membership, Owner status, and capability do not imply approval authority.
- Seller-owned ServiceOffering MP3 storage and playback through the BG2 abstraction, including
  MP3 validation, the maximum of three samples, authorization, opaque storage references, buyer-safe
  DTOs, public playback gates, removal, and bounded storage-cleanup recovery.
- PostgreSQL-backed Matchmaker, ProjectBrief and recommendation flow, ProjectRequest eligibility
  revalidation, seller acceptance/decline, atomic Negotiating Deal creation, immutable structured
  TermsVersions, independent approvals, labeled sandbox funding, and deterministic activation.
- The production-verified Golden Slice from Matchmaker through audio playback, ProjectRequest,
  seller acceptance, Deal, AI-drafted terms, independent approvals, sandbox funding, and Active
  Deal.
- Existing focused authorization, retry, repository, contract, runtime-schema, provider-adapter,
  disposable-PostgreSQL, and Playwright testing patterns.

## User Stories

1. As a newly authenticated human, I want SoundHub to create my Personal Workspace relationship, so that I do not reach an empty authenticated dead end.
2. As a newly authenticated human, I want foundational provisioning to grant no marketplace capability, so that authority reflects an explicit intent choice.
3. As a returning human, I want provisioning retries to converge on my existing Personal Workspace, so that network uncertainty cannot create duplicate Workspaces.
4. As a human with organizational memberships, I want my Personal Workspace created independently, so that existing organizational relationships remain unchanged.
5. As a human with conflicting legacy records, I want SoundHub to stop in an explicit recovery state, so that it does not guess at authority.
6. As a privacy-conscious human, I want my default Workspace slug to omit my email and provider identity, so that routing identifiers do not leak login data.
7. As a new member, I want to choose whether I will hire talent, offer services, or do both, so that capabilities reflect my intended marketplace participation.
8. As a new member choosing both, I want Buyer and Seller provisioned atomically, so that a failure cannot leave ambiguous partial intent.
9. As a Personal Workspace participant, I want to add the other capability later, so that my first intent choice is not a permanent role restriction.
10. As a buyer, I want Buyer capability without a buyer-specific attestation, so that ordinary marketplace participation remains lightweight.
11. As a buyer, I want Matchmaker and ProjectRequest access without Deal approval authority, so that discovery does not imply power to bind a Workspace.
12. As a prospective seller, I want Seller capability to require explicit versioned Seller participation acceptance, so that selling is deliberate.
13. As a prospective seller, I want Seller capability activation separated from profile and service rights representations, so that I attest only when concrete content exists.
14. As a Personal Workspace participant, I want Deal approval authority to be optional readiness, so that it does not block ordinary Buyer or Seller activity.
15. As a Personal Workspace participant, I want to explicitly accept approval authority, so that `DealApprover` is never inferred from membership, Owner status, or capability.
16. As a buyer approver, I want just-in-time authority setup at terms approval, so that missing authorization has a recoverable product flow.
17. As a seller approver, I want the same just-in-time authority setup, so that seller approval requires no manual database edit.
18. As a Deal party, I want authority setup to return me to the pending Deal and TermsVersion, so that I can resume without losing context.
19. As a Deal party, I want a separate approval action after authority setup, so that provisioning never silently approves terms.
20. As a Deal party, I want approval restricted to my acting Workspace's side, so that `DealApprover` cannot authorize the counterparty's approval.
21. As a Seller-capable participant, I want my SellerProfile created only when I first save profile information, so that capability activation does not create meaningless empty records.
22. As a seller, I want incomplete profile drafts saved privately, so that I can complete onboarding over time.
23. As a seller retrying my first save, I want the same SellerProfile returned, so that retries cannot create duplicates.
24. As a seller, I want SellerProfile publication to be a separate explicit command, so that draft existence does not imply publication.
25. As a seller, I want publication to require a professional/display name and meaningful biography, so that buyers receive a useful identity.
26. As a seller, I want publication to require at least one controlled Specialty, so that discovery uses canonical professional disciplines.
27. As a seller, I want to state where I am currently based, so that the existing M1 location contract remains usable.
28. As a diaspora seller, I want based-in location separated from Caribbean connection, so that current location does not erase regional identity.
29. As a Caribbean seller, I want at least one self-declared Caribbean connection, so that I can represent a meaningful regional cultural or professional relationship.
30. As a seller, I want SoundHub to describe Caribbean connection as self-declared and unverified, so that it does not claim to verify ethnicity, nationality, heritage, or cultural identity.
31. As a privacy-conscious seller, I want city and region to remain optional, so that publication does not require precise location.
32. As a seller, I want to confirm a versioned profile-publication attestation, so that accuracy and my right to publish the professional profile are explicit.
33. As a published seller, I want complete profile updates applied atomically, so that failed or partial edits cannot corrupt my public profile.
34. As a published seller, I want the current public profile to remain unchanged when an update fails, so that buyers retain a valid view.
35. As a seller without an Active offering, I want my published identity preserved, so that I can continue setup without losing profile work.
36. As that seller, I want clear notice that I am not marketplace ready, so that I understand I am absent from ordinary search and cannot receive new ProjectRequests.
37. As a seller, I want “Create your first ServiceOffering” as a contextual next action, so that offering creation does not globally block identity onboarding.
38. As a seller, I want an offering created lazily on first successful save, so that empty offering rows are not created by capability activation.
39. As a seller, I want incomplete offering drafts saved privately, so that I can build a listing over time.
40. As a seller retrying one creation attempt, I want it to converge on the same offering, so that retries do not create duplicates while I may still intentionally create multiple offerings.
41. As a seller, I want Draft offerings excluded from discovery and ProjectRequests, so that unfinished services cannot be commissioned.
42. As a seller, I want offering audio management inside the relevant offering, so that samples retain clear ownership and context.
43. As a seller, I want to upload, list, privately preview, and remove samples on my own Draft offering, so that I can satisfy activation requirements before publication.
44. As a seller, I want Draft media hidden from buyer/public DTOs and playback, so that private work is not exposed prematurely.
45. As a seller uploading a sample, I want to confirm I am authorized to upload and use it as a SoundHub preview, so that publication responsibility is explicit.
46. As a seller, I want SoundHub to clarify that upload neither proves nor transfers underlying ownership rights, so that the confirmation is not misrepresented.
47. As a seller, I want activation to require a title and meaningful description, so that the offering is understandable.
48. As a seller, I want activation to require one controlled primary ServiceCategory, so that the existing M1 taxonomy remains searchable.
49. As a seller, I want activation to require Remote, InPerson, or Hybrid service mode, so that the existing M1 service-mode contract is populated.
50. As an InPerson or Hybrid seller, I want to provide coarse service area, so that the existing M1 location filter is truthful without exposing an exact address.
51. As a seller, I want to choose Fixed, StartingAt, or ContactForQuote pricing, so that absence is not confused with an intentional pricing decision.
52. As a seller choosing Fixed or StartingAt, I want existing USD validation and non-binding presentation retained, so that onboarding does not invent a new pricing model.
53. As a seller choosing ContactForQuote, I want it to represent an intentional absence of an advertised amount, so that buyers receive clear pricing semantics.
54. As a seller, I want Draft offerings to permit missing pricing, so that unfinished configuration remains resumable.
55. As a seller, I want activation to require one to three valid playable MP3 samples, so that buyers can hear relevant work before initiating a ProjectRequest.
56. As a seller, I want activation to require versioned confirmation that I am authorized to offer the service and that the listing is accurate, so that publication is deliberate.
57. As a seller, I want listing details presented as non-binding until incorporated into approved terms, so that an offering is not mistaken for a contract.
58. As a seller, I want genres, tags, and included services to remain optional, so that useful enhancements do not block activation.
59. As a seller, I want activation to apply completely or not at all, so that validation or persistence failure leaves my offering private.
60. As a seller, I want to pause an Active offering explicitly, so that I can stop new marketplace contact without damaging existing engagements.
61. As a seller, I want reactivation to rerun current activation validation, so that repaired data or new audio does not silently publish my offering.
62. As a seller removing a non-final qualifying sample, I want my offering to remain Active, so that ordinary media management does not change availability.
63. As a seller removing the final qualifying sample, I want explicit notice that my offering will be paused, so that marketplace eligibility does not disappear unexpectedly.
64. As a buyer, I want final-sample removal to atomically remove Active eligibility before storage cleanup, so that an Active offering never loses its required public evidence silently.
65. As a seller, I want storage-cleanup failure to leave the offering Paused and the sample unavailable, so that PostgreSQL eligibility remains canonical.
66. As a seller, I want adding a replacement sample not to reactivate automatically, so that publication remains explicit.
67. As a seller, I want complete post-activation updates applied atomically, so that failed edits preserve the previous Active listing.
68. As a marketplace party, I want offering edits never to rewrite existing ProjectBriefs, ProjectRequests, Deals, TermsVersions, approvals, or funding requirements, so that commercial history retains its meaning.
69. As an owner of a legacy Active offering, I want rollout to preserve its existing search behavior, so that M2 does not silently deactivate production supply.
70. As that seller, I want a clear remediation task when my offering lacks current pricing, audio, or confirmation, so that grandfathered nonconformity is visible.
71. As a marketplace participant, I want grandfathering to be one-way, so that republish or reactivation must satisfy the current M2 contract.
72. As a marketplace operator, I want rollout inventory of nonconforming Active offerings by reason, so that migration impact is known before release.
73. As a Workspace member, I want a product-wide acting-Workspace selector, so that I always know which marketplace party I represent.
74. As a Workspace member, I want remembered selection treated only as convenience, so that stale client state cannot grant authority.
75. As a Workspace member, I want every scoped request to name its acting Workspace, so that the server can revalidate current authority and ownership.
76. As a member opening another accessible Workspace's resource, I want an explicit switch prompt, so that context never changes silently.
77. As a member switching Workspaces, I want scoped transient forms cleared or contained, so that draft inputs do not cross ownership boundaries.
78. As a dual-capability Personal Workspace participant, I want Buyer and Seller destinations together, so that I do not need an artificial role mode.
79. As an authenticated participant, I want a readiness dashboard derived from durable state, so that it always presents truthful next actions.
80. As a participant missing contextual readiness, I want unrelated capability surfaces to remain usable, so that setup guidance is not a blanket gate.
81. As a participant, I want the highest-value next actions prioritized, so that the dashboard does not become a permanent exhaustive checklist.
82. As a customer, I want BG1 engineering authorization controls removed from normal UX, so that the dashboard contains real product actions.
83. As an engineer, I want any retained authorization harness gated outside ordinary production UX, so that test utility does not leak into the product.
84. As a returning participant, I want SoundHub to remember my last accessible Workspace, so that routine navigation remains convenient.
85. As a revoked member, I want an inaccessible remembered Workspace ignored, so that the UI cannot preserve lost authority.
86. As a user following a valid resource link, I want onboarding or authority setup to return me to the pending resource, so that recovery does not lose context.
87. As a security-conscious user, I want invalid or cross-Workspace return targets rejected, so that redirect convenience cannot cross authorization boundaries.
88. As an operator repairing exceptional legacy membership, I want structured append-only evidence, so that the authority change remains attributable.
89. As a person accepting a versioned document, I want its historical content immutable or equivalently recoverable, so that my acceptance cannot change retroactively.
90. As a privacy-conscious participant, I want acceptance and outcome evidence allow-listed and private, so that audit needs do not expose credentials or provider internals.
91. As a reviewer, I want two brand-new humans to complete onboarding and the Golden Slice without manual records, so that M2 proves composable product readiness.
92. As a reviewer, I want focused inverse and retry tests rather than many browser journeys, so that assurance is strong without creating a fragile suite.
93. As a release operator, I want deterministic full automation plus bounded managed-provider production smoke, so that reliability and real-provider verification remain separate.

## Implementation Decisions

### Authority and foundational provisioning

- The first-authentication convergence operation creates the provider/UserAccount mapping when
  needed, exactly one Personal Workspace, and exactly one Owner `WorkspaceMembership` for the human.
  It creates no capability and no `DealApprover`.
- Owner establishes the Personal Workspace relationship only. This specification defines explicit
  Personal Workspace self-service commands; it does not establish a generic rule that Owner status
  grants arbitrary capability or approval-authority administration.
- Active/current membership remains the only authorization source for acting through a Workspace.
  `ownerUserId` may remain populated for schema compatibility and may be inspected as legacy
  reconciliation evidence, but cannot authorize or independently justify membership creation.
- “My Workspace” is the default private name. Its slug is opaque and collision-resistant and must
  contain neither normalized email nor provider identity. Naming is not part of intent selection,
  and SellerProfile publication does not require renaming.
- Foundational recovery-first states are limited to (a) no unambiguous valid Personal Workspace and
  current Owner membership, or (b) no successfully provisioned marketplace capability. Missing
  `DealApprover`, SellerProfile, or ServiceOffering is contextual readiness, not a global blocker.
- Progress is derived from durable domain records. No mutable “current onboarding step” is
  authoritative.
- Existing organizational memberships remain unchanged and usable. Every authenticated account
  still converges independently to its own Personal Workspace.
- Exactly one unambiguous existing Personal Workspace/current Owner membership is reused. No
  candidate causes atomic creation. Multiple candidates, contradictory ownership/membership, or
  other ambiguity causes an explicit recovery state; the system does not select, merge, delete, or
  rewrite authority relationships automatically.
- **Recovery reason classification.** When the Personal Workspace convergence classification
  cannot link the authenticated human to exactly one unambiguous Personal Workspace + current
  Owner membership, the server classifies the contradiction as one of the server-internal
  recovery reasons defined alongside the convergence service. The existing six reasons retain
  their current definitions and precedence: `pointer-workspace-missing`, `pointer-not-personal`,
  `owner-membership-missing`, `membership-not-owner`, `contradictory-personal-relationships`,
  `multiple-personal-workspaces`. When an existing contradiction already applies, that reason
  keeps its precedence.
  - `co-owned-personal-workspace` — A Personal Workspace considered for the user's Personal
    Workspace authority has current Owner memberships belonging to more than one distinct
    UserAccount. This reason blocks otherwise-safe `attachable` and `converged` classifications.
    Public behavior is unchanged: `setupState: "recovery"`. The reason remains server-internal and
    never crosses the HTTP boundary.
- The same logical provisioning or repair attempt is retry-safe and converges on the same records.
  Exact keys, uniqueness constraints, receipts, and transaction mechanics are deferred to the
  implementation specification and must be verified against the current schema.
- There is no automatic or open self-service claim of an existing seller Workspace or SellerProfile.
  Exceptional production attachment uses a bounded operator-assisted recovery path that verifies
  the intended UserAccount/Workspace relationship and records structured repair evidence. It does
  not infer authority from email, provider metadata, `ownerUserId`, or seller content and does not
  automatically grant capability or `DealApprover`.

### Intent and capabilities

- The intent choices are `Hire talent`, `Offer services`, and `Both`.
- `Hire talent` explicitly provisions Buyer capability and requires no buyer-specific attestation.
- `Offer services` collects current versioned Seller participation/terms acceptance and atomically
  records that acceptance with Seller capability.
- `Both` collects the Seller acceptance and atomically creates Buyer and Seller capabilities
  together. It never creates `DealApprover`.
- A Personal Workspace may add the other capability later through a dedicated self-service command
  satisfying the same requirements as initial selection. Changing intent is not a capability
  removal mechanism.
- Capability deactivation/removal is deferred from this slice.

### Personal Workspace DealApprover

- `DealApprover` self-provisioning is capability-neutral for Personal Workspaces. It is an explicit
  Personal Workspace policy, not an inference from Owner status or sole membership.
- The human accepts an immutable versioned approval-authority document. The retry-safe command
  records acceptance and creates the Personal Workspace/UserAccount `DealApprover` authorization.
- Setup appears as optional dashboard readiness and as a just-in-time flow from either party's
  attempted terms approval. It blocks no ordinary Buyer- or Seller-capable activity.
- Just-in-time setup returns to the same pending Deal and current TermsVersion but requires a new,
  separate approval action. It never creates `DealApproval`.
- Actual approval continues to require current authentication, exact acting Workspace membership,
  the exact `DealApprover`, the Workspace's buyer or seller party relationship to the Deal, the
  current TermsVersion, and all existing approval invariants. Authority for one side never approves
  or authorizes the counterparty side.
- Organization approval-authority delegation and multi-member administration are deferred.

### SellerProfile onboarding

- Seller capability alone does not create a SellerProfile. The stable identity is created on the
  first successful draft save. First-save retries converge on the Workspace's at-most-one profile.
- Before first publication, incomplete drafts are private and resumable.
- Publication requires a professional/display name, meaningful biography, at least one controlled
  Specialty, required `basedInCountryCode`, and at least one self-declared Caribbean connection.
  Region and city are optional.
- The based-in field is labeled “Where are you currently based?” and represents marketplace
  location only. It is not nationality, citizenship or residence status, heritage, Caribbean
  identity, or verification. It remains required because the current M1 schema, DTO, rendering,
  and filtering contracts materially depend on it. Optionalizing it is deferred to a later Search
  Contract Evolution milestone.
- Caribbean connection is stored and presented separately. The UI calls it self-declared and
  unverified and never uses “verified Caribbean artist” or implies verification of ethnicity,
  nationality, heritage, or cultural identity.
- Publication requires versioned confirmation that the profile is accurate to the actor's knowledge
  and that they have the right to publish that professional profile. Service, copyright, sample,
  and third-party media representations do not belong to this boundary.
- A published SellerProfile completes seller professional-identity setup. It does not make the
  seller marketplace ready without at least one eligible Active ServiceOffering.
- Post-publication editing begins from the current valid public profile. A complete update and
  current publication confirmation replace the public field set atomically. Failure preserves the
  previous public state. Persistent post-publication drafts, browsable history, and historical
  restoration are deferred.
- This specification does not promise a new standalone public SellerProfile page. Existing M1
  discovery eligibility remains unchanged.

### ServiceOffering onboarding and lifecycle

- A ServiceOffering stable identity is created on its first successful save. Incomplete Drafts are
  private and resumable. Retry behavior must distinguish retry of one creation attempt from a new
  intentional offering because a SellerProfile may own multiple offerings.
- `Draft`, `Active`, `Paused`, and `Archived` are the canonical ServiceOffering lifecycle states per
  ADR 0002 and remain distinct: Draft is not marketplace-ready; Paused is intentionally unavailable;
  Active is ready and available; Archived is a terminal state whose transition semantics are
  governed by existing authoritative repository behavior and existing accepted ADRs. Existing
  Archived records remain legitimate canonical records. M2 exposes self-service Active → Paused
  and Paused → Active only; self-service Archive, restore-from-Archive, and archived-offering
  duplication are not introduced.
- Activation requires all of the following:
  - title and meaningful description;
  - one controlled primary ServiceCategory;
  - `Remote`, `InPerson`, or `Hybrid` service mode;
  - at least one coarse service area for `InPerson` or `Hybrid`;
  - an explicit `Fixed`, `StartingAt`, or `ContactForQuote` pricing choice;
  - valid existing USD amount/unit semantics for `Fixed` or `StartingAt`;
  - one to three qualifying playable MP3 samples carrying applicable media-use confirmation; and
  - versioned confirmation that the seller is authorized to offer the described service, the
    listing is accurate to their knowledge, and marketplace listing details are non-binding until
    incorporated into an approved TermsVersion.
- Service mode, service area, and all three pricing kinds are existing M1 schema, runtime-contract,
  filtering, DTO, and rendering semantics. M2 exposes them; it does not introduce a new search or
  pricing model.
- A missing pricing row is incomplete configuration, not intentional public state.
  `ContactForQuote` is the explicit no-advertised-amount choice. Drafts may lack pricing.
- Genres, tags, and included services remain optional. Audio is required as the narrow current
  marketplace evidence type; no other portfolio or media types are introduced.
- Activation validates and applies atomically. Failure leaves the offering private/non-Active and
  does not publish partial state.
- Explicit pause immediately removes ordinary-search and new-ProjectRequest eligibility without
  changing existing engagements. Explicit reactivation reruns the entire current activation
  contract; repairing data does not reactivate automatically.
- Removing a non-final qualifying sample changes no offering state. Removing the final qualifying
  sample from an Active offering requires explicit confirmation that eligibility will cease. The
  database operation atomically changes the offering to Paused and hides/removes the sample from
  application-visible state before provider cleanup. Database failure changes neither. Storage
  cleanup failure leaves the offering Paused, buyers unable to access the sample, and existing
  bounded cleanup evidence available for retry.
- Adding a qualifying sample to a Paused offering never reactivates it automatically.
- Post-activation editing starts from current valid public fields. Republish/update validates the
  complete resulting state and current confirmation and atomically replaces the public field set.
  Failure preserves the preceding Active listing. No persistent post-activation draft or generalized
  offering revision history is introduced.
- A listing change must not retroactively change the meaning or requirements of an existing
  ProjectBrief, ProjectRequest, Deal, TermsVersion, approval, or funding record. Whether current
  BG4–BG6 references/snapshots satisfy this invariant is a mandatory repository-verification item.

### Audio management and evidence

- Audio management moves from the standalone Workspace navigation surface into the relevant
  ServiceOffering management UI. Workspace-level seller requests and Deals remain navigation and
  dashboard destinations.
- The seller-management boundary expands to allow an authenticated, current member acting through
  its Seller-capable owning Personal Workspace to upload, list, privately preview, and remove audio
  for Draft offerings. Draft media never enters public/buyer DTOs, discovery, buyer playback, or
  ProjectRequest eligibility.
- Each upload records versioned confirmation that the seller represents they are authorized to
  upload and use that file as a SoundHub marketplace preview. SoundHub states that this confirmation
  neither proves nor transfers underlying ownership rights.
- Existing BG2 MP3 observed-content validation, byte limit, maximum-three cap, storage abstraction,
  opaque-reference handling, ownership/authorization checks, public eligibility, playback gates,
  and bounded cleanup remain in force. The public Active range under new M2 activation is one to
  three; Drafts remain zero to three. Grandfathered legacy Active offerings are addressed below.
- No generalized media-processing lifecycle, transcoding, waveform, duration validation, broader
  media type, portfolio, catalog, licensing, or rights-management system is added.

### Workspace context, dashboard, and recovery UX

- A product-wide selector displays the acting Workspace prominently. The initial selection is the
  new Personal Workspace; later sessions may remember the last selected accessible Workspace.
- Remembered selection is client convenience only. Every Workspace-scoped or consequential request
  carries an explicit acting Workspace ID and revalidates current membership, Workspace status,
  capability, authority, party relationship, and resource ownership as applicable.
- An inaccessible remembered Workspace is ignored. SoundHub falls back to the Personal Workspace
  or an explicit selection flow.
- A resource link owned by another accessible Workspace offers an explicit “Switch to this
  Workspace” transition. It never silently changes context. Switching never transfers or reinterprets
  domain ownership, and Workspace-scoped transient forms do not silently carry across the switch.
- Buyer and Seller destinations derive from capabilities. A dual-capability Workspace shows both;
  there is no role-mode switch.
- The dashboard derives independent readiness from durable state and prioritizes useful next actions:
  intent selection/retry, Matchmaker, optional approval authority, SellerProfile creation/resumption/
  publication, ServiceOffering creation/resumption/activation/remediation, seller requests, and Deals.
- A published profile without an eligible Active offering is truthfully labeled identity-complete
  but not marketplace-ready, absent from ordinary search, and unable to receive new ProjectRequests.
- Missing contextual readiness guides at the affected surface rather than globally redirecting the
  user. Foundational blockers receive recovery-first or intent-selection experiences.
- BG1 “Verify acting Workspace” and “Send consequential command” controls are removed from ordinary
  customer UX. Any retained engineering harness is explicitly gated outside normal production UI;
  server authorization remains unchanged.
- Login defaults to the Workspace-scoped dashboard. A narrowly allow-listed return target may resume
  a pending resource after onboarding or authority setup only after revalidation. Cross-Workspace
  targets require explicit switching, and provisioning authority never auto-replays a consequential
  action.

### Legacy convergence and rollout

- Existing Active offerings keep their status and current search behavior even when they lack an
  M2 pricing choice, qualifying audio, or current confirmation. They are grandfathered
  nonconforming records, not examples satisfying the new activation contract.
- Conformity is derived from current durable records where practical. Migration creates no fake
  `ContactForQuote`, acceptance, attestation, confirmation, or media evidence and does not require a
  permanent legacy-state field unless repository verification demonstrates it is necessary.
- Owners receive a clear remediation task. Grandfathering is one-way: after pause, reactivation
  requires the full current contract; explicit Active republish/update must also converge the listing
  or preserve the prior legacy Active state on failure.
- Before rollout, a bounded inventory reports each currently Active nonconforming offering and
  reason category. The inventory is evidence and planning input, not authorization to rewrite data.
- Legacy membership repair is exceptional, structured, attributable, and append-only. Contradictory
  records never authorize automatic repair.

### Narrow evidence model

- M2 adds narrowly allow-listed append-only evidence, not generalized audit/event infrastructure.
- Every versioned acceptance or confirmation identifies the immutable document/version, human
  `UserAccount` actor, acting Workspace, applicable domain resource, timestamp, and request/
  correlation identifier. The document version resolves to immutable content or equivalent
  immutable evidence so accepted text cannot change retroactively.
- Existing domain provenance is reused where sufficient. A narrow append-only outcome is required
  where current state would otherwise erase meaningful history, including activation,
  pause/reactivation, `DealApprover` provisioning, and exceptional legacy membership repair.
- Provisioning and publication/lifecycle operations remain attributable. Evidence is not duplicated
  solely to imitate a general audit framework.
- Evidence excludes credentials, magic-link/session tokens, raw provider payloads, arbitrary
  sensitive operational text, IP/device surveillance, and public DTO exposure.

## Invariants and Failure/Recovery Behavior

1. Authentication identifies a human; it grants no Workspace authority.
2. A Personal Workspace Owner membership grants the Workspace relationship only.
3. `ownerUserId` never authorizes, including during recovery.
4. Buyer and Seller are independent capabilities created only by explicit Personal Workspace intent
   commands; `Both` creates both or neither.
5. Buyer capability never implies `DealApprover`; Seller capability never implies SellerProfile;
   SellerProfile never implies publication; publication never implies search eligibility.
6. `DealApprover` provisioning never creates Deal approval, and Deal approval never covers the
   counterparty Workspace.
7. A new Active offering satisfies the complete current activation contract, including one to three
   qualifying playable samples and an explicit pricing choice.
8. Draft media is private. Public listing/playback and ProjectRequest creation use current canonical
   eligibility.
9. Removing the final qualifying sample cannot leave a conforming Active offering with zero samples.
10. Pause, reactivation, publication, republish, activation, and authority provisioning are explicit
    human commands; repairing data does not trigger them automatically.
11. Consequential commands are atomic and retry-safe. A failed command creates neither partial
    authority nor ambiguous partial intent.
12. Existing organizational relationships and legacy Active offerings are preserved unless an
    explicit authorized command changes them.
13. Ambiguous legacy authority fails into recovery; it is never guessed, merged, deleted, or
    reconstructed from identity/profile metadata.
14. PostgreSQL remains canonical. Provider, browser, cache, AI, storage, and remembered UI state
    cannot override current marketplace authority or eligibility.
15. Updates to seller content cannot retroactively alter durable commercial meaning.

Expected failure behavior:

- Provider failure fails closed for new authentication while anonymous M1 search remains available.
- Foundational provisioning failure leaves a recoverable authenticated state and safely retries the
  same logical operation.
- Intent failure leaves no partial `Both` capability state and presents intent retry.
- Missing contextual readiness returns a stable, actionable product state without globally blocking
  unrelated capabilities.
- Schema/field validation failure returns allow-listed field errors and preserves prior durable state.
- Authorization loss or Workspace mismatch rejects the command at its boundary even when UI state
  is stale.
- Publication, activation, republish, pause/reactivation, and final-sample database failures apply
  no partial marketplace transition.
- Storage failure follows existing BG2 cleanup behavior; public visibility is governed by canonical
  database state and never restored implicitly.
- Return-target failure falls back to the active Workspace dashboard or explicit selection without
  replaying the pending command.
- Conflicting legacy state enters explicit recovery and produces no automatic authority change.

## Repository Verification Required Before Implementation Planning

The following are implementation assumptions to verify against current `main`; this specification
does not silently assert them:

- Whether current uniqueness and relationship constraints can guarantee exactly one Personal
  Workspace per UserAccount while preserving existing organizational and legacy data.
- How the first-authentication transaction composes with the existing provider-identity linking
  transaction, including concurrent callbacks and response loss.
- Which schema representation best permits incomplete SellerProfile and ServiceOffering drafts
  without weakening complete public DTOs or requiring generalized revision infrastructure.
- How retry identity distinguishes one offering-creation retry from a deliberate second offering.
- Whether current acceptance/document models exist and can provide immutable versioned evidence;
  otherwise, what narrow model is required.
- Whether current audio persistence can attach confirmation evidence per sample and authorize
  private Draft preview without exposing draft bytes through buyer playback URLs.
- How activation transactionally verifies playable storage state without making external storage a
  database-transaction authority or introducing an unbounded media lifecycle.
- How final-sample removal composes atomic database eligibility changes with existing
  `PendingCleanup` and orphaned-storage recovery.
- Whether current BG4–BG6 records snapshot enough seller/offering meaning to satisfy the no-retroactive-
  change invariant; if not, add only the narrow durable evidence necessary for existing engagements.
- Which existing Active offerings lack explicit pricing, qualifying audio, or confirmation, and how
  to derive their readiness without fabricating state.
- Whether current auth/session DTOs and navigation consumers can carry product-wide Workspace
  context without making selection authoritative or leaking provider subjects.
- Which current BG1 engineering surfaces or deterministic controls are reachable in production and
  what environment/build gate safely retains any required test harness.
- Which current routes already provide appropriate safe envelopes, request IDs, runtime validation,
  and transaction/repository seams for the new commands, and where the smallest new seams are needed.

## Testing Decisions

- Tests assert observable contracts, durable state, authorization outcomes, privacy boundaries,
  state transitions, and recovery behavior rather than ORM call order, component structure, or
  internal helper calls.
- Prefer the highest existing seams: one browser-to-real-PostgreSQL acceptance journey; HTTP contract
  tests for public behavior and error envelopes; application-service tests for state and authority;
  real repository tests for transaction, uniqueness, concurrency, and eligibility; provider-adapter
  tests for authentication/storage equivalence.
- There is exactly one primary integrated browser journey. It uses two brand-new human identities
  and no seeded/manual UserAccount, Workspace, membership, capability, `DealApprover`, SellerProfile,
  or ServiceOffering provisioning:

  ```text
  seller completes deterministic production-shaped magic-link authentication
  → first-auth convergence creates UserAccount mapping + Personal Workspace + Owner membership only
  → seller chooses Offer services and accepts versioned Seller participation terms
  → Seller capability is provisioned
  → seller creates and resumes a SellerProfile draft
  → seller satisfies profile fields and explicitly publishes with versioned confirmation
  → seller creates and resumes a ServiceOffering draft
  → seller completes existing service mode, service area, category, and pricing fields
  → seller uploads and privately previews a rights-confirmed MP3
  → seller explicitly activates the offering
  → buyer completes independent brand-new authentication and foundational provisioning
  → buyer chooses Hire talent and receives Buyer capability only
  → buyer submits a natural-language brief through the real PostgreSQL-backed Matchmaker
  → the exact newly created eligible offering is recommended
  → buyer plays its public sample and creates a ProjectRequest
  → seller switches back to the seller Personal Workspace and explicitly accepts
  → exactly one Negotiating Deal and an AI-drafted unapproved TermsVersion are created
  → seller attempts approval and completes just-in-time DealApprover setup
  → seller separately approves the current TermsVersion for the seller Workspace
  → buyer attempts approval and completes independent just-in-time DealApprover setup
  → buyer separately approves the same current TermsVersion for the buyer Workspace
  → buyer explicitly initiates labeled sandbox funding
  → matching confirmation is persisted and the Deal becomes Active
  ```

- The browser journey crosses the UI, same-origin Next.js boundary, Express runtime validation,
  current authorization services, onboarding services, repositories, real disposable PostgreSQL,
  existing TalentSearchService, audio storage abstraction, Deal/TermsVersion services, and sandbox
  funding boundary.
- Deterministic provider adapters make the full automated journey reliable. A separate bounded
  deployed smoke proves managed Supabase magic-link Auth, Resend delivery/callback/session behavior,
  Supabase Storage, and brand-new production foundational provisioning. It is not a second full
  product journey and creates no authorization shortcut.
- Focused authentication/provisioning tests cover no-capability first auth, exactly-one Personal
  Workspace convergence, concurrent callback/retry, response loss, existing valid Personal reuse,
  preservation of organization memberships, ambiguous/conflicting recovery, and prohibition on
  `ownerUserId` authorization.
- Focused intent tests cover each choice, atomic `Both`, later capability addition, versioned Seller
  acceptance, no buyer attestation, no automatic `DealApprover`, and retry convergence.
- Focused `DealApprover` tests cover capability-neutral Personal self-service, immutable acceptance,
  dashboard and just-in-time entry, separate approval action, buyer/seller party scoping,
  counterparty rejection, retry, and membership loss.
- SellerProfile tests cover lazy first save, incomplete draft/resume, duplicate prevention,
  publication field validation, based-in versus Caribbean connection semantics, immutable
  confirmation, atomic publication/update, and no public leakage of drafts.
- ServiceOffering tests cover lazy/multiple creation semantics, incomplete drafts, controlled
  fields, service area rules, explicit pricing choice, amount/unit validation, optional metadata,
  media requirement, activation confirmation, atomic activation/update, and continued M1 search
  eligibility behavior.
- Audio tests extend BG2 coverage to owned Draft upload/list/private preview/removal and prove draft
  media is absent from search, buyer DTOs, public playback, and ProjectRequest eligibility. They
  cover per-sample confirmation, sample limits, invalid/unplayable MP3, final-sample pause
  confirmation, transaction failure, provider cleanup failure, and explicit reactivation.
- Workspace UI/contract tests cover remembered convenience, inaccessible fallback, explicit linked-
  resource switching, scoped form containment, dual-capability navigation, contextual readiness,
  safe return targets, and absence of BG1 engineering controls from normal production UX.
- Real PostgreSQL repository tests cover command atomicity, retry/concurrency behavior, unique
  Personal Workspace convergence, capability provisioning, SellerProfile uniqueness, deliberate
  multiple offerings, acceptance/outcome evidence, eligibility transitions, and legacy repair.
- Legacy tests cover derived nonconformity by reason, unchanged grandfathered Active search behavior,
  remediation presentation, no fabricated decisions/evidence, one-way convergence on republish or
  reactivation, and the pre-rollout inventory.
- Existing Golden Slice inverse authorization and activation tests remain regression gates. Focused
  tests, not additional full browser journeys, cover `Both`, recovery, grandfathering,
  pause/reactivation, Workspace switching, and negative authorization combinations.
- The full acceptance gate includes type-check, lint, formatting, unit/contract tests, disposable-
  PostgreSQL repository and migration verification, the one browser journey, production builds,
  and runtime smoke. Automated acceptance does not require live email, AI, storage, blockchain, or
  external provider availability.

## Historical M2 Traceability and Named Deferrals

The historical user-story numbers below refer to
`docs/specs/milestone-2-authenticated-workspaces-seller-onboarding.md`.

| Historical M2 requirement                                                                                 | Disposition                                                                                        | Authoritative destination                                                                 |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Stories 1–6 and 14: unified privacy-safe magic-link identity                                              | Delivered narrowly by BG1; M2 adds first-auth provisioning                                         | BG1 baseline + this M2                                                                    |
| Story 7: broad adaptive abuse/rate-limit program                                                          | Deferred beyond existing provider controls                                                         | **Account Security and Recovery milestone**                                               |
| Stories 8–10: inactivity/absolute session expiry and all-device revocation                                | Deferred beyond existing server session/revocation behavior                                        | **Account Security and Recovery milestone**                                               |
| Stories 11–13: recent authentication, protected email change, and recovery policy                         | Deferred                                                                                           | **Account Security and Recovery milestone**                                               |
| Stories 15–20: Personal Workspace, active context, explicit commands, revocation response                 | Personal path covered; organization-sensitive behavior remains explicit                            | This M2; organization extensions in **Organization Workspace Governance milestone**       |
| Stories 21–31: self-service organizations, invitations, Owner/Editor administration, no-orphan governance | Deferred as one coherent domain                                                                    | **Organization Workspace Governance milestone**                                           |
| Stories 32–35: Editor drafting/publication/availability permissions                                       | Deferred because Personal Workspaces are single-member and Owner does not become generic authority | **Organization Workspace Governance milestone**                                           |
| Stories 36–41: Buyer default, Seller activation, public/private identity                                  | Reconciled: Buyer is explicit rather than automatic; Seller and privacy boundaries covered         | This M2                                                                                   |
| Stories 42–50: profile draft, required fields, publication, direct unavailable profile                    | Covered except new standalone direct-profile UX and generalized revision history                   | This M2; standalone profile UX in **Marketplace Discovery Evolution milestone**           |
| Stories 51–62: offering draft, controlled fields, service mode/area, pricing, activation, pause           | Covered with MP3 activation evidence added                                                         | This M2                                                                                   |
| Stories 63–66: archive, duplication, generalized optimistic revisions                                     | Seller-facing archive/duplication and generalized revisions deferred                               | **Seller Content Lifecycle milestone**                                                    |
| Stories 67–70: immediate eligibility, capability deactivation/reactivation                                | Eligibility and offering reactivation covered; capability deactivation deferred                    | This M2 + **Seller Content Lifecycle milestone**                                          |
| Stories 71–78: reports, moderation, operator permissions/passkeys, suspension, contested control          | Deferred                                                                                           | **Marketplace Trust and Operations milestone** (aligned with provisional M7 hardening)    |
| Stories 79–83: broad Workspace/authentication audit and Owner activity view                               | Narrow evidence only; broad audit/feed deferred                                                    | **Marketplace Trust and Operations milestone**                                            |
| Stories 84–86: general policy-document classification and reconsent engine                                | Narrow immutable M2 documents only; general framework deferred                                     | **Policy, Consent, and Data Governance milestone**                                        |
| Stories 87–89: account/Workspace exports                                                                  | Deferred                                                                                           | **Policy, Consent, and Data Governance milestone**                                        |
| Stories 90–96: account/Workspace closure, restoration, retention, deletion/anonymization                  | Deferred                                                                                           | **Account and Workspace Lifecycle milestone**                                             |
| Stories 97–99: transactional invitation, authority, and enforcement email program                         | Existing auth mail remains; broader notifications deferred with owning domains                     | **Organization Workspace Governance** and **Marketplace Trust and Operations milestones** |
| Stories 100–102: comprehensive provider-outage/session-continuity policy                                  | Existing fail-closed auth and anonymous search remain; breadth deferred                            | **Account Security and Recovery milestone**                                               |
| Stories 103–104: generalized command idempotency/audit completeness                                       | Required only for M2 commands at concrete boundaries; generalized platform framework deferred      | This M2 + **Platform Reliability and Audit Hardening milestone**                          |
| Story 105: sign-in-to-discovery seller acceptance journey                                                 | Expanded to two-human onboarding through Active Deal                                               | This M2                                                                                   |
| Original Gate 0 immutable published-revision architecture                                                 | Not required as generalized infrastructure; narrow atomic publication/update invariants apply      | This M2; broader history in **Seller Content Lifecycle milestone**                        |
| Original Gate 0 closure, enforcement, operator, export, and retention foundations                         | Deferred with their user-facing domains; not schema prerequisites for this M2                      | Named milestones above                                                                    |

The following later roadmap boundaries remain unchanged and are not pulled into M2:

- **M3 Matchmaker and ProjectRequest:** BG3/BG4 behavior remains a delivered Golden Slice baseline;
  broader conversation, clarification, messaging, expiration, and production M3 breadth require
  separate governance.
- **M4 Negotiation and mutual approval:** existing Golden Slice terms and approvals are regression
  baseline; broader negotiation UX, material-edit flows, deadlines, and production M4 breadth are
  deferred.
- **M5 escrow and Deal lifecycle:** existing labeled sandbox activation remains baseline; wallet
  verification, Workspace wallet authorization, real Polkadot/stablecoin movement, release, refund,
  cancellation, and deadline enforcement remain deferred.
- **M6 private delivery and acceptance:** deliverables, file submissions, revisions, acceptance,
  and release remain entirely deferred.
- **M7 monitoring, disputes, audit integration, and hardening:** schedulers, reminders, disputes,
  operator adjudication, and the production-wide audit program remain deferred.

## Out of Scope

- Self-service Organization Workspace creation, invitations, membership administration, ownership
  transfer, organization capability administration, and multi-member approval delegation.
- Capability deactivation/removal.
- Seller-facing Archive controls, archived-offering duplication/restoration, and generalized seller
  content revision history.
- Automatic claiming or transfer of an existing SellerProfile or ServiceOffering.
- A new standalone public SellerProfile experience.
- Making based-in location optional or changing M1 location/search semantics.
- New pricing types, currencies, exchange rates, binding listing prices, or settlement semantics.
- General copyright/rights adjudication, formal verification, portfolios, catalogs, licensing,
  broader media types, transcoding, waveform, or generalized media processing.
- Advanced session lifecycle, all-device logout guarantees, email change, manual identity recovery,
  ordinary-user MFA/passkeys, and operator security.
- Reporting, moderation, suspension/restoration, contested-control freezes, appeals, or operator
  administration.
- Customer activity feeds, generalized event sourcing/audit infrastructure, exports, retention
  automation, closure, restoration, deletion, or anonymization.
- Matchmaker expansion, broad negotiation, delivery, revisions, acceptance, monitoring, disputes,
  real wallets, Polkadot escrow, release, refund, or other post-M2 features.
- A generalized cross-platform idempotency framework beyond concrete M2 command correctness.
- Tickets, implementation plans, migrations, code, commits, or deployment changes under this
  specification alone.

## Further Notes

- This specification changes the M2 completion claim, not the historical record. The historical M2
  remains available for rationale and traceability.
- The reconciled boundary intentionally promotes the working Golden Slice into an onboarding-backed
  user journey without claiming completion of untouched historical M2 or provisional M3–M7 scope.
- Production legal/privacy review is still required for the exact Seller participation terms,
  profile publication confirmation, service activation confirmation, media-use confirmation, and
  approval-authority attestation. Implementation must version immutable approved text and must not
  invent legal claims in code or UI copy.
- `to-spec` establishes product and engineering behavior. Exact data models, API shapes,
  transaction ordering, idempotency mechanisms, migration SQL, rollout sequence, and ticket sizing
  require later repository verification and planning.
- No GitHub issue or ticket is created by this document. Ticket shaping begins only after separate
  user approval through the requested `to-tickets` workflow.
