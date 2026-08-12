# Milestone 2: Authenticated Workspaces and Seller Onboarding

- **Status:** Approved product and engineering specification
- **Depends on:** Accepted Milestone 1.1 implementation and Gate 0 schema reconciliation
- **Domain language:** `CONTEXT.md`
- **Architecture decisions:** ADRs 0001–0006

## Problem Statement

SoundHub can now retrieve real public sellers and Active ServiceOfferings from PostgreSQL, but a
human cannot authenticate, establish durable authority to act for a Workspace, or create and publish
the seller content that search consumes. The current M1.1 schema also contains deliberately minimal
read-oriented representations: a singular Workspace owner pointer, broad membership roles, mutable
published fields, combined publication/enforcement state, direct account email identity, and
cascading deletion behavior. Using those representations directly for authenticated writes would
create ambiguous authority, lost updates, partial public edits, unsafe recovery, and destructive
closure behavior.

A new or returning human needs a secure, understandable way to authenticate as a private
UserAccount, act explicitly through an authorized personal or organizational Workspace, collaborate
without shared credentials, and deliberately publish a SellerProfile and Active ServiceOffering.
SoundHub must preserve the distinction between human identity, Workspace authority, public seller
identity, seller-controlled lifecycle, and platform enforcement while giving operators a minimal
safety path for abuse and contested control.

## Solution

Milestone 2 introduces managed email magic-link authentication behind a provider-neutral boundary,
creates one personal Workspace after first successful authentication, and adds self-service
organizational Workspaces with revocable Owner and Editor memberships. Every consequential command
names the acting Workspace, and the server revalidates current membership and permission from
PostgreSQL.

Owners can deliberately activate Seller capability, prepare and atomically publish immutable
SellerProfile and ServiceOffering revisions, and control offering availability. Editors can prepare
draft content and pause an Active offering for safety, but Owners retain publication, capability,
membership, and irreversible lifecycle authority. Publication requirements preserve SoundHub's
Caribbean marketplace boundary without presenting self-declared affiliation as verified identity.

A Gate 0 migration first reconciles M1.1 with these approved boundaries. It makes
WorkspaceMembership canonical for authority, separates platform enforcement from seller intent,
introduces working and published revisions, adds provider identity and account-security state, and
establishes closure and audit foundations while preserving M1.1 identifiers and searchable content.

The milestone is proven by one golden automated journey: a new human authenticates, receives a
personal Workspace, activates Seller capability, publishes a valid SellerProfile, activates a valid
ServiceOffering, signs out, and is found by an anonymous visitor through the existing Milestone 1
search path. Edge cases and inverse eligibility states are proven at focused contract, service,
repository, migration, and integration seams rather than multiplying browser journeys.

## User Stories

1. As a new human, I want to continue with my email address, so that I can begin without creating a password.
2. As a returning human, I want the same email flow to sign me in, so that I do not need to remember whether I previously registered.
3. As a new human, I want to understand that continuing may create an account, so that account creation is deliberate.
4. As a new human, I want my account created only after I prove control of my inbox, so that another person cannot register my address for me.
5. As a person requesting a magic link, I want a neutral response, so that SoundHub does not reveal whether an email is registered.
6. As an account holder, I want magic links to expire quickly and work only once, so that copied links have limited value.
7. As an account holder, I want abusive magic-link requests rate-limited, so that attackers cannot flood my inbox.
8. As an account holder, I want to remain signed in on a trusted device for a reasonable period, so that normal use is convenient.
9. As an account holder, I want inactive and very old sessions to expire, so that forgotten sessions do not remain valid forever.
10. As an account holder, I want “log out all devices” to block authenticated SoundHub actions immediately, so that I can respond to compromise.
11. As an account holder, I want sensitive account changes to require recent authentication, so that an unattended session cannot easily take over my account.
12. As an account holder changing email, I want both the old and new addresses confirmed, so that the login credential cannot be silently redirected.
13. As an account holder, I want recovery limitations explained before onboarding, so that I understand the consequences of losing my mailbox.
14. As a privacy-conscious person, I want private login data kept separate from public seller content, so that authentication does not expose me.
15. As a new account holder, I want one personal Workspace created automatically, so that I can participate without first designing an organization.
16. As a person acting for myself, I want my personal Workspace to remain single-member, so that nobody else is ambiguously authorized as me.
17. As a person with multiple brands, I want to join multiple Workspaces through one UserAccount, so that I do not need shared or duplicate logins.
18. As a Workspace member, I want the active Workspace shown clearly, so that I know which marketplace party I am representing.
19. As a Workspace member, I want each consequential command to identify its acting Workspace, so that another browser tab cannot change my authority context.
20. As a Workspace member whose access was revoked, I want the next command rejected, so that remembered browser state does not preserve authority.
21. As a band, studio, collective, or business representative, I want to create an organizational Workspace myself, so that collaboration does not require staff setup.
22. As an organizational Workspace creator, I want to attest that I am authorized to establish its presence, so that the declaration is deliberate and auditable.
23. As an organizational Workspace creator, I want SoundHub to avoid claiming that my attestation proves legal ownership, so that platform authority is not misrepresented.
24. As an organizational Owner, I want to invite people by email as Owners or Editors, so that collaborators use individual credentials.
25. As an invitee, I want to authenticate as the invited email and explicitly accept, so that membership cannot be assigned silently.
26. As an Owner, I want to revoke a pending invitation, so that obsolete access offers cannot be accepted.
27. As an invitee, I want invitations to expire, so that old links do not remain authority grants indefinitely.
28. As an Owner, I want to revoke a member or change their authority, so that Workspace access remains current.
29. As a member, I want to leave an organizational Workspace, so that I can end my authority relationship.
30. As an organizational Owner, I want multiple Owners, so that one lost account does not strand the Workspace.
31. As a Workspace stakeholder, I want the final Owner protected from removal or departure, so that the Workspace cannot be orphaned.
32. As an Editor, I want to prepare SellerProfile and ServiceOffering drafts, so that I can contribute without controlling publication.
33. As an Owner, I want all Editor abilities plus publication and control permissions, so that responsibility matches authority.
34. As an Editor who discovers a dangerous mistake, I want to pause an Active offering, so that it can leave search immediately.
35. As an Owner, I want only Owners to activate, reactivate, archive, or publish seller content, so that public commitments receive accountable review.
36. As an Owner, I want Buyer capability available without extra onboarding, so that ordinary marketplace participation is easy.
37. As an Owner, I want Seller capability to require explicit self-activation, seller terms, and an authority attestation, so that selling is deliberate.
38. As a legitimate seller, I want self-publication without staff approval or formal verification, so that verification is not a hidden gate.
39. As a Workspace representative, I want Workspace type to guide explanations rather than grant authority, so that labels do not become brittle permission rules.
40. As a seller, I want my public professional identity separated from my private UserAccount, so that I control what buyers see.
41. As a seller, I want to enter or explicitly confirm every public field, so that private account information is never published automatically.
42. As a seller, I want to save an incomplete SellerProfile draft, so that onboarding can be completed over time.
43. As a seller, I want publication to require a professional name, meaningful biography, at least one controlled Specialty, a country, at least one CaribbeanAffiliation, and authority acceptance, so that public profiles are useful and intentional.
44. As a Caribbean seller, I want affiliation represented separately from residence, so that diaspora identity is not erased.
45. As a seller declaring CaribbeanAffiliation, I want it clearly described as self-declared and unverified, so that SoundHub does not misstate nationality or identity.
46. As a seller, I want public location limited to country and optional region or city, so that discovery does not require exposing a precise address.
47. As a published seller, I want to prepare profile changes privately, so that buyers continue seeing the last complete revision.
48. As an Owner, I want to publish a complete SellerProfile revision atomically, so that buyers never see a half-edited profile.
49. As a seller, I want my published profile to remain available without an Active offering, so that I can maintain a professional presence while unavailable.
50. As a buyer visiting such a profile directly, I want it labeled as not currently accepting work, so that availability is clear.
51. As a seller, I want to create an incomplete ServiceOffering draft, so that I can refine it before activation.
52. As a seller, I want to choose from controlled ServiceCategories, so that buyers can search consistently.
53. As a seller, I want to write my own title, description, genres, and tags, so that controlled categories do not flatten creative expression.
54. As a seller, I want an offering to state Remote, InPerson, or Hybrid service mode, so that buyers understand delivery expectations.
55. As an InPerson or Hybrid seller, I want to provide coarse service areas, so that buyers understand coverage without seeing exact addresses.
56. As a seller, I want to choose StartingAt, Fixed, or ContactForQuote pricing, so that advertised pricing is structured but flexible.
57. As a seller, I want advertised amounts expressed in USD, so that buyers can compare listings without live exchange rates.
58. As a marketplace participant, I want advertised pricing labeled non-binding until incorporated into approved terms, so that a listing is not mistaken for a contract.
59. As a seller, I want IncludedServices distinguished from independently purchasable offerings, so that bundles are represented honestly.
60. As an Owner, I want activation to validate all required offering fields at once, so that incomplete drafts cannot enter search.
61. As a seller, I want Active and Paused states to be reversible, so that temporary unavailability does not retire my offering.
62. As a returning buyer, I want a Paused offering visible by direct profile link as unavailable, so that I understand the seller's service history.
63. As a seller, I want Archived to be terminal, so that a retired offering identifier keeps stable historical meaning.
64. As a seller reusing archived content, I want to duplicate it into a new Draft, so that convenience does not rewrite history.
65. As a collaborator, I want stale edits rejected, so that another person's newer work is not silently overwritten.
66. As an Owner, I want publication to require the current revision, so that I review the exact content becoming public.
67. As a seller, I want search eligibility to change immediately when publication or offering state changes, so that search does not advertise stale availability.
68. As a marketplace operator, I want canonical PostgreSQL eligibility to override caches or derived indexes, so that stale projections cannot expose ineligible sellers.
69. As an Owner, I want Seller capability deactivation to remove search eligibility without destroying content, so that I can stop selling safely.
70. As a seller reactivating capability, I want current publication requirements and authority attestations revalidated, so that stale declarations are not reused blindly.
71. As a public visitor, I want to report impersonation, fraud, misrepresentation, or harmful seller content without signing in, so that anonymous discovery has a safety path.
72. As a reported seller, I want reports to trigger human review rather than automatic suspension, so that abusive reports cannot punish me automatically.
73. As a marketplace operator, I want narrow permissions to review reports, suspend or restore seller visibility, and freeze contested control, so that enforcement does not impersonate a Workspace.
74. As a marketplace operator, I want stronger email-plus-passkey authentication, so that compromise of one mailbox cannot expose many Workspaces.
75. As a marketplace participant, I want operator actions recently reauthenticated, reasoned, and audited, so that emergency power is accountable.
76. As a seller, I want platform suspension separate from my publication and offering choices, so that enforcement does not rewrite what I selected.
77. As a party in a control dispute, I want consequential control and publication changes frozen, so that the fastest actor cannot seize the Workspace.
78. As an unaffected seller, I want existing public content to remain visible during a control dispute unless separately unsafe, so that a dispute is not automatically treated as harmful content.
79. As a Workspace Owner, I want a privacy-bounded activity view, so that I can understand consequential Workspace changes.
80. As a Workspace member, I want my personal authentication history hidden from other members, so that organizational accountability does not become surveillance.
81. As an account holder, I want consequential authentication and authority events recorded immutably, so that compromise and disputes can be investigated.
82. As a Workspace stakeholder, I want audits to identify both the human actor and acting Workspace, so that marketplace actions are attributable.
83. As a privacy-conscious user, I want audits to exclude secrets and raw magic-link tokens, so that evidence does not create new credentials.
84. As a person accepting terms or an attestation, I want SoundHub to preserve which version I accepted, so that the record remains truthful after wording changes.
85. As a returning user, I want editorial policy corrections not to interrupt me, so that reacceptance is proportionate.
86. As a person affected by a material policy update, I want only the relevant consequential action gated, so that unrelated read access remains available.
87. As an account holder, I want a structured export of my private account, memberships, and my own acceptance and security history, so that I can retain my information.
88. As a Workspace Owner, I want a structured export of Workspace identity, membership history, seller content, revisions, and visible activity, so that organizational data is portable.
89. As an Editor, I want exports limited to records I may already access, so that export does not elevate my authority.
90. As an account holder closing my account, I want all sessions revoked immediately, so that closure ends access.
91. As a member closing my account, I want shared organizational Workspaces preserved, so that my closure does not delete other people's work.
92. As the final Owner, I want closure blocked until safe ownership continuity exists, so that I cannot orphan a Workspace accidentally.
93. As a personal seller closing my account, I want my solely controlled public presence unpublished, so that closed accounts stop advertising services.
94. As a Workspace Owner, I want Workspace closure to be reversible during a cooling-off period, so that accidental closure can be corrected.
95. As a privacy-conscious user, I want eligible private data later deleted or anonymized, so that closure does not mean indefinite retention.
96. As a marketplace operator, I want retention classes rather than one universal lifetime, so that security, governance, publication, and enforcement evidence can follow appropriate policy.
97. As a user, I want only necessary transactional emails, so that authentication and authority messages are clear and marketing is not implied.
98. As an invited or revoked member, I want timely transactional notice, so that I understand changes to my authority.
99. As a suspended or restored seller, I want a generic notice and support path, so that enforcement is visible without exposing internal moderation notes.
100. As an authenticated user during provider downtime, I want valid short-lived access to continue only while SoundHub authorization succeeds, so that outages are bounded without bypassing security.
101. As a new or expired user during provider downtime, I want a clear retriable failure, so that an outage is not mistaken for rejection.
102. As an anonymous buyer, I want public search to remain available during authentication outages, so that discovery is not unnecessarily coupled to login.
103. As a user retrying a timed-out command, I want the same outcome without duplicate invitations, publications, or audits, so that network uncertainty is safe.
104. As an operator, I want each consequential command applied completely or not at all, so that authority and evidence cannot diverge.
105. As a new seller, I want the complete path from sign-in to anonymous discovery proven, so that SoundHub demonstrates usable onboarding rather than disconnected screens.

## Implementation Decisions

- Gate 0 is a prerequisite shared-foundation migration, not a user-facing slice. It lands before
  authentication or onboarding commands and is reviewed against the approved M1.1 migration and
  canonical seed.
- Active WorkspaceMembership is the only source of current Workspace authority. The M1.1 singular
  owner reference is migrated into membership authority and cannot authorize independently.
- Membership authority exposed by Milestone 2 is `Owner | Editor`. Owners inherit Editor abilities.
  Personal Workspaces have exactly one Owner and no invitations. Organizational Workspaces allow
  multiple Owners and Editors and must retain at least one Owner.
- Existing M1.1 UserAccount, Workspace, SellerProfile, and ServiceOffering identifiers are preserved.
  Existing searchable seller content is backfilled as the initial published revision.
- SellerProfile and ServiceOffering content have private working revisions and immutable published
  revisions. Publishing validates and promotes one complete revision atomically without changing
  the stable SellerProfile or ServiceOffering identity.
- Optimistic concurrency uses explicit revision values. Stale writes fail with a safe conflict
  response and return enough current-version information for the client to reload or reconcile.
- Seller-controlled publication, ServiceOffering lifecycle, Workspace eligibility, Seller
  capability, and platform enforcement are separate state dimensions. Search eligibility is their
  deterministic conjunction.
- M1.1 `ServiceOfferingStatus` values remain `Draft | Active | Paused | Archived`. Archived is
  terminal; duplication creates a new Draft with a new identifier.
- Ordinary account and Workspace removal uses closure states rather than direct cascading deletion.
  Approved retention processing is the only path to later deletion or anonymization.
- Authentication uses email magic links through a managed provider boundary. Hosted Supabase Auth
  is the initial candidate adapter, subject to verification of production SMTP, SSR integration,
  provider outage behavior, export, webhook reconciliation, and session controls before release.
- SoundHub owns stable UserAccount IDs. A separate unique provider-and-subject mapping represents
  external credentials. Provider identifiers, roles, and metadata never authorize Workspaces.
- Sign-up and sign-in use one consent-aware email flow. No UserAccount is created until the magic
  link proves inbox control. The acceptance record references the exact terms/privacy versions
  presented.
- Magic-link requests always use neutral responses, bounded rate limits across normalized email,
  network source, and abuse signals, short expiration, single use, and privacy-bounded suspicious
  activity auditing. Additional challenges may be introduced adaptively rather than imposed on all
  users.
- Access tokens target a ten-minute lifetime. Renewable sessions expire after thirty days of
  inactivity and have a ninety-day absolute lifetime.
- “Log out all devices” records account-level revocation state and immediately blocks SoundHub
  authenticated actions issued under earlier session state, even if a provider access token has not
  yet expired.
- Email changes require recent authentication and confirmation through both old and new addresses.
  Milestone 2 has no manual identity-based recovery when the old mailbox is unavailable. Suspected
  compromise may freeze access.
- Mandatory MFA is deferred for ordinary members. Platform operators require email authentication
  plus registered passkey authentication, shorter sessions, and recent reauthentication for
  enforcement actions.
- The first successful authentication transaction creates exactly one personal Workspace and its
  Owner membership. A remembered Workspace selection is UI convenience only.
- Every consequential API command names its acting Workspace explicitly. Application services
  verify current authentication, membership, permission, Workspace state, capability, record
  ownership, and relevant acceptance versions within the command boundary.
- Organizational Workspace creation is self-service and private by default. The creator provides a
  name and descriptive type, accepts an authority representation, becomes the first Owner, and may
  invite other humans through their own accounts.
- Invitations specify Owner or Editor, target one normalized email, expire, may be revoked, and
  require successful authentication as that email plus explicit acceptance. Membership removal,
  departure, and authority changes require recent authentication and immutable audit evidence.
- Buyer capability is granted automatically. Seller capability is explicitly self-activated by an
  Owner after accepting versioned seller terms and an authority attestation. Workspace type affects
  onboarding language but never grants capability.
- SellerProfile publication requires professional name, meaningful biography, at least one
  PostgreSQL-controlled Specialty, country plus optional region/city, at least one supported
  self-declared CaribbeanAffiliation, and current seller authority acceptance. Avatar and social
  links are optional; precise addresses, coordinates, and formal verification are excluded.
- CaribbeanAffiliation is required for seller publication, self-declared, and explicitly distinct
  from nationality, ethnicity, current location, and verified identity. The MVP does not collect
  proof or the nature of the connection.
- A published SellerProfile may have no Active offerings. It remains directly accessible as not
  accepting new work but is excluded from ordinary search.
- ServiceOffering activation requires title, meaningful description, one PostgreSQL-controlled
  primary ServiceCategory, service mode, coarse service area for InPerson or Hybrid work, and a
  pricing choice. IncludedServices, genres, and tags are optional.
- Advertised pricing is optional, structured as StartingAt, Fixed, or ContactForQuote, denominated
  only in USD, and non-binding until incorporated into approved terms. Token, network, wallet, and
  settlement choices remain outside Milestone 2.
- Editors may create and edit working revisions and may pause an Active offering as an emergency
  safety action. Only Owners may publish profiles, activate or reactivate offerings, archive
  offerings, change capabilities, or administer membership.
- Paused offerings are excluded from ordinary search but remain directly visible as unavailable.
  Draft and Archived offerings are private.
- Publishing, unpublishing, activation, pausing, capability loss, Workspace suspension, and seller
  suspension update eligibility atomically in canonical PostgreSQL. Derived indexes and caches may
  never override current canonical eligibility.
- Seller capability deactivation preserves content and underlying lifecycle state, removes search
  eligibility immediately, and requires current validation plus a fresh authority attestation
  before reactivation. Platform revocation cannot be cleared by the seller.
- Consequential commands are transactional and idempotent using a dedicated idempotency key.
  Request IDs remain correlation identifiers and are never treated as idempotency keys.
- Public reports accept a controlled reason and bounded free text, optionally collect contact
  information, accept anonymous callers, and use abuse controls. Reports create review evidence and
  never cause automatic enforcement.
- Platform operators have separate least-privilege permissions to review reports, apply or clear
  suspension, and place or clear contested-control freezes. They cannot impersonate users, edit
  seller-authored content, or become members through enforcement tooling.
- A contested-control freeze blocks Owner and membership changes, invitations, capability changes,
  publication changes, and offering activation/reactivation/archiving. Public content remains
  visible unless a separate safety suspension is justified.
- Immutable audit events cover authentication security changes, Workspace creation, membership and
  authority changes, capability changes, attestations, public revision publication, offering
  lifecycle, closure, suspension, restoration, and control freezes. Events identify human actor,
  acting Workspace where applicable, action, subject, timestamp, request ID, and a safe summary;
  credentials and raw magic-link tokens are excluded.
- Workspace Owners receive a privacy-bounded activity view. Other members' authentication details,
  IP addresses, session information, and internal moderation notes remain account-private or
  operator-only.
- Terms, notices, and attestations use append-only document versions and acceptance events.
  Updates are classified as editorial, notice-required, or reconsent-required. Only affected
  consequential actions are gated, and optional privacy consent is not bundled with contractual
  acceptance.
- Audit evidence is divided into retention classes. Exact durations require an approved
  privacy/legal policy before implementation acceptance; the data model must support later deletion
  and anonymization.
- Account closure revokes sessions, disables authentication, safely ends memberships, unpublishes a
  solely controlled personal seller presence, and preserves shared Workspaces. Workspace closure
  disables capabilities and public eligibility, becomes read-only, and provides a short restoration
  period before retention processing.
- Structured JSON exports are permission-aware. Account holders receive their private account,
  membership, and own acceptance/security history; Owners receive Workspace identity, membership
  history, seller content, revisions, and Owner-visible activity; Editors receive only content they
  may access. Secrets, other people's security data, and internal moderation notes are excluded.
- Milestone 2 sends only transactional authentication, invitation/revocation, email-change,
  security-change, suspension, and restoration messages through a replaceable email-delivery
  boundary.
- Authentication-provider outages fail closed for new sign-ins, expired sessions, email changes,
  and refresh. Already authenticated requests may continue only while short-lived access state is
  valid and SoundHub revocation and authorization checks succeed. Anonymous search remains
  independent.
- Shared Zod schemas remain executable HTTP contracts. Public and authenticated DTOs are allow-listed
  and never serialize Prisma models. Express owns parsing, request IDs, and safe error envelopes;
  onboarding introduces domain-specific error codes rather than reusing search codes.
- Onboarding application services depend on command/query repository interfaces. Prisma remains
  below adapters, controlled ServiceCategory/Specialty/PricingUnit keys resolve from PostgreSQL, and
  the composition root permits deterministic provider and repository substitution in tests.
- Delivery is organized as Gate 0 followed by five dependency-ordered vertical slices:
  authentication/personal Workspace; explicit Workspace context and organizational membership;
  Seller capability and SellerProfile publication; ServiceOffering lifecycle and search
  eligibility; reporting, enforcement, audit completeness, and full acceptance.

## Testing Decisions

- Tests assert externally observable behavior and stable contracts, not private helper structure,
  ORM call order, or exact internal table layout.
- There is exactly one golden automated browser journey. It crosses browser UI, deterministic
  authentication-provider adapter, same-origin Next.js boundary, Express validation and
  authorization, onboarding application services, repositories, real disposable PostgreSQL, and
  the existing TalentSearchService. It proves first authentication, personal Workspace creation,
  Seller activation, SellerProfile publication, ServiceOffering activation, sign-out, and anonymous
  discovery.
- Browser E2E does not call live email or hosted Supabase. The provider adapter emits a deterministic
  one-time verification action while preserving the same application boundary. Provider-specific
  behavior is covered by focused adapter contract tests and a bounded pre-release environment smoke
  test.
- Gate 0 migration tests start from the approved M1.1 schema and representative canonical data,
  apply the reviewed migration, preserve stable IDs and public search behavior, backfill initial
  published revisions, make membership authority canonical, and prove rollback/recovery assumptions
  appropriate to a disposable database.
- Authentication contract tests cover unified sign-up/sign-in, consent evidence, neutral responses,
  single-use expiry, rate limiting, provider failures, session refresh, inactivity and absolute
  expiry, recent authentication, immediate all-device revocation, email change, and the restricted
  recovery boundary.
- Authorization service and API tests cover explicit acting-Workspace context, current membership,
  Owner/Editor permissions, personal Workspace isolation, multiple organizational Owners,
  no-orphan enforcement, revoked membership, freeze state, capability checks, and operator
  least-privilege boundaries.
- Invitation integration tests cover creation, duplicate retries, expiry, revocation, acceptance by
  the intended authenticated email, departure, authority changes, transactional audit creation, and
  transactional email handoff.
- SellerProfile and ServiceOffering service tests cover incomplete drafts, publication validation,
  immutable published revisions, atomic promotion, stale revision rejection, Editor/Owner
  permissions, terminal archive, duplication, pause/reactivation, optional fields, coarse location,
  controlled keys, USD pricing, and non-binding presentation semantics.
- Real PostgreSQL repository tests cover every eligibility conjunction and its inverse: Workspace
  state, Seller capability, SellerProfile publication, platform suspension, Active offering state,
  and current published revision. They prove eligibility changes are visible to the next search
  transaction without a cache or background job.
- Focused integration tests—not additional E2E journeys—prove that pause, unpublish, Seller
  capability loss, Workspace suspension, and seller suspension remove ordinary search eligibility
  while preserving underlying content and lifecycle intent.
- Idempotency tests repeat the same consequential command before and after simulated response loss
  and prove one state transition, one durable result, and one audit event. A different idempotency
  key represents a new intentional command.
- Concurrency tests submit competing revisions and authority changes and prove stale writes fail,
  the final Owner cannot be removed, and transactions cannot leave capability, publication, audit,
  or membership state partially applied.
- Audit and privacy tests prove required actor/Workspace/action/version/request evidence exists and
  that provider subjects, private email where not allowed, raw tokens, other members' security
  events, internal moderation notes, and Prisma-only fields cannot cross public or Owner-visible
  contracts.
- Reporting and enforcement tests cover anonymous bounded reports, abuse controls, no automatic
  suspension, operator passkey/recent-auth requirements, reason requirements, suspension/restoration,
  independent control freezes, and prohibition on operator impersonation or seller-content edits.
- Closure and export tests cover immediate access revocation, no-orphan rejection, organizational
  continuity, personal seller unpublication, restoration window, permission-aware JSON exports,
  retention classification, and later deletion/anonymization without deleting another person's
  records.
- Reuse M1.1 prior art: shared Zod request/response parsing, safe error envelopes with request IDs,
  injected service/repository seams, in-memory unit fakes, guarded disposable PostgreSQL, idempotent
  canonical seed checks, real repository tests, and one browser-to-database tracer.
- The full acceptance gate includes type-check, lint, unit/contract tests, real PostgreSQL migration
  and repository tests, the one golden E2E journey, production builds, formatting, and a runtime
  smoke test. Automated checks must not require OpenAI, vector, Redis, storage, wallet, stablecoin,
  or blockchain credentials.

## Out of Scope

- Matchmaker or any other agent behavior
- ProjectRequest creation, seller-consent conversations, or buyer-seller messaging
- Negotiation, Deal creation, TermsVersion negotiation, or DealApprover execution
- Wallet verification, WorkspaceWalletAuthorization, stablecoin selection or transfer, escrow, or
  blockchain integration
- PortfolioItem, file upload, object storage, private delivery, licensing, or rights management
- Formal identity, professional, nationality, group-ownership, or CaribbeanAffiliation verification
- SellerProfile or ServiceOffering transfer between Workspaces
- Personal-to-organizational Workspace conversion or members in a personal Workspace
- Manual identity-based account recovery
- Mandatory MFA for ordinary Workspace members
- Full enterprise team administration, ownership-transfer adjudication, or SoundHub determination of
  contested real-world ownership
- Automated moderation, automated suspension, a full moderation dashboard, or a formal appeals
  portal
- Public evidence uploads for reports
- Marketing email, recommendations, general notification preferences, or campaign messaging
- Multi-currency advertised pricing, live exchange rates, token pricing, or conversion guarantees
- Public PortfolioItem publishing or precise public addresses/coordinates
- Redis, scheduled jobs, generalized queues, or new derived search indexes unless a later approved
  scope change requires them

## Further Notes

- Hosted Supabase Auth is the leading managed-provider candidate, not a source of marketplace
  authority. Its production SMTP, short-lived JWT behavior, global sign-out limitations, SSR adapter
  maturity, data export, outage behavior, and exit path must be verified before implementation
  acceptance.
- Email magic links are not described as equivalent to phishing-resistant passkeys. Passkeys remain
  the required operator factor and the preferred future stronger factor for ordinary accounts before
  financial authority ships.
- Exact retention durations, policy-update classification ownership, privacy notices, seller terms,
  authority representations, support procedures, and launch-jurisdiction requirements need
  qualified privacy/legal review before Milestone 2 acceptance. The product and schema must not
  silently choose permanent retention.
- The current M1.1 implementation remains the migration source of truth. Later M1 tickets may add
  fields and behavior; implementation planning must recheck merged `main` before freezing migration
  SQL, but may not reopen approved M2 product decisions without concrete contradictory evidence.
- This specification authorizes later ticket shaping, not implementation. Create no GitHub Milestone
  2 record or implementation tickets until the user separately approves the ticket breakdown.
