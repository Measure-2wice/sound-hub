# SoundHub Marketplace

SoundHub is a marketplace where people and organizations discover Caribbean talent, commission
creative services, agree to project terms, exchange private deliverables, and settle payment.

## Identity and authority

**UserAccount**:
A private login belonging to one human. A UserAccount acts in the marketplace only through a
Workspace membership.
_Avoid_: User, account, seller account

**Workspace**:
The personal or organizational marketplace participant that buys or sells services. A Workspace
is the stable party to requests, deals, approvals, and payment authorizations.
_Avoid_: Account, team account, organization account

**WorkspaceMembership**:
A revocable relationship granting a UserAccount authority to act for a Workspace. Membership is
not proof of legal ownership, copyright ownership, or entitlement to revenue.
_Avoid_: Team user, shared login

**MarketplaceCapability**:
An independently granted `Buyer` or `Seller` ability held by a Workspace. Workspace type,
specialty, and occupation do not grant authority.
_Avoid_: Role

**DealApprover**:
A Workspace member explicitly authorized to approve an immutable TermsVersion for that Workspace.
One DealApprover may bind a Workspace within the MVP's declared platform permissions.
_Avoid_: Signer, all members

## Discovery

**SellerProfile**:
The public professional identity through which a Seller-capable Workspace is discovered. It owns
professional presentation, specialties, location, and Caribbean affiliations.
_Avoid_: ProducerProfile, ArtistProfile, TalentProfile

**Talent**:
Buyer-facing collective language for searchable sellers. Talent is not a persisted identity type.
_Avoid_: Artist when referring to all sellers

**Specialty**:
A seller's professional discipline, such as Artist, Producer, Musician, Songwriter, or Sound
Engineer. A Specialty supports discovery but never grants authorization.
_Avoid_: Role, service

**ServiceCategory**:
A controlled marketplace classification for purchasable work, identified by a stable key. Sellers
describe offerings freely within these stable classifications.
_Avoid_: Specialty, genre

**ServiceOffering**:
A published description of work a SellerProfile is willing to provide. It is non-binding until
its details are incorporated into an approved TermsVersion.
_Avoid_: Service, gig, product

**IncludedService**:
A service supplied only as part of a ServiceOffering bundle. It is not independently purchasable
unless the seller publishes a separate ServiceOffering for it.
_Avoid_: IncludedCategory, add-on

**CaribbeanAffiliation**:
A seller's self-declared connection to one or more Caribbean countries or territories. It is
distinct from current location, service area, nationality, and verified identity.
_Avoid_: Nationality, country

**PortfolioItem**:
A future public, permissioned example of completed work. It is distinct from a private
DealDeliverable and from a licensable catalog asset.
_Avoid_: MusicTrack, deliverable

## Engagement and deals

**MatchmakerConversation**:
A private, buyer-Workspace-owned exchange that develops a project brief before a ProjectRequest.
Its human participants act through current WorkspaceMembership authority.
_Avoid_: User conversation, cross-Workspace chat

**ProjectBrief**:
A buyer Workspace's structured description of desired work, separating searchable required
constraints, searchable preferences, and project requirements that a seller must review. A
confirmed brief informs a ProjectRequest but is not approved deal terms.
_Avoid_: Prompt, ProjectRequest, TermsVersion

**WorkspaceBlock**:
A private boundary through which one Workspace prevents another Workspace from initiating new
marketplace contact. It is distinct from a platform report or enforcement action.
_Avoid_: User block, suspension, report

**MarketplaceReport**:
A participant's request for authorized human review of marketplace content or conduct. A report
preserves review evidence but is not itself a block, finding, or enforcement action.
_Avoid_: Complaint verdict, automatic suspension

**ProjectRequest**:
A buyer Workspace's invitation to a seller Workspace to discuss a project. Seller acceptance
opens negotiation but does not approve terms or activate paid work.
_Avoid_: Booking, Deal

**Deal**:
An accepted commercial engagement between buyer and seller Workspaces. It becomes Active only
after both parties approve the same TermsVersion and escrow funding succeeds.
_Avoid_: ProjectRequest, transaction

**TermsVersion**:
An immutable proposal covering scope, deliverables, schedule, price, revisions, and other deal
terms. A material edit creates a new version and invalidates prior approvals.
_Avoid_: Current terms, editable agreement

**DeliverableRequirement**:
An approved description of work the seller must submit under a Deal.
_Avoid_: File, milestone

**DeliverableSubmission**:
An immutable, versioned submission of one or more private files against a
DeliverableRequirement.
_Avoid_: PortfolioItem, MusicTrack

## Payments and agents

**WalletVerification**:
A time-bound record that a valid blockchain signature proved control of an address. It does not
establish permanent or legal ownership.
_Avoid_: Wallet ownership

**WorkspaceWalletAuthorization**:
An audited authorization allowing a verified wallet to fund or receive payout for a Workspace.
_Avoid_: Workspace wallet ownership

**AgentRun**:
A privacy-bounded audit of an agent invocation, including versions, redacted structured input,
tool activity, validated output, and operational outcome. It excludes hidden reasoning and secrets.
_Avoid_: Chain of thought, raw prompt log
