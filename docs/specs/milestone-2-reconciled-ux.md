# Milestone 2: Reconciled UX and Visual Design Addendum

- **Status:** Approved UX contract for Milestone 2 specification and implementation
- **Functional authority:** `docs/specs/milestone-2-reconciled-personal-workspace-onboarding.md`
- **Domain language:** `CONTEXT.md`
- **Design evidence:** the canonical Stitch corpus under
  `~/Desktop/soundhub-m2-stitch-reconciliation/`
- **Purpose:** define the presentation, interaction, responsive, accessibility, and visual acceptance
  contract that complements the reconciled functional Milestone 2 specification

## Problem Statement

The reconciled Milestone 2 functional specification defines how a new human establishes a Personal
Workspace, provisions Buyer and Seller capabilities, publishes marketplace supply, discovers Talent,
creates a ProjectRequest, negotiates and approves a TermsVersion, and reaches an Active Deal through
labeled sandbox funding. It deliberately protects the distinctions between login, membership,
capability, approval permission, approval, and marketplace state.

The approved Stitch explorations establish a strong visual direction for that journey, but they are
not by themselves an implementation-ready UX contract. Their generated copy sometimes invents
unsupported product behavior; their design-system prose and token frontmatter use different base
values; their headers, statuses, card density, and viewport captures are inconsistent; and thirteen
canonical variants have invalid `screen.png` files whose complete contents are
`<FIFE Image failed to fetch>`. The generated HTML for those variants remains valid structural
evidence, but neither it nor any screenshot specifies production component architecture,
accessibility behavior, or pixel-level acceptance.

Without a reconciled UX contract, implementation could clone accidental Stitch details, weaken
Workspace context, blur lifecycle state with readiness, reintroduce unsupported marketplace claims,
or reproduce a visually attractive screen without its required keyboard, recovery, and responsive
behavior.

## Solution

SoundHub will implement M2 through one normalized Caribbean Studio design system. The experience is
warm, editorial, culturally confident, and grounded in creative work, while operational screens
remain legible, restrained, and explicit about Workspace context and consequential actions.

This addendum makes the approved Stitch corpus canonical evidence for visual character, information
hierarchy, major composition, relative action prominence, interaction patterns, responsive intent,
and the balance between editorial identity and operational clarity. It explicitly does not make
Stitch a pixel-perfect implementation contract.

Implementation preserves:

- Caribbean Studio visual character;
- information hierarchy;
- major page compositions;
- action order and relative prominence;
- approved interaction patterns;
- responsive intent; and
- editorial-versus-operational balance.

Implementation normalizes:

- semantic design tokens and accessible variants;
- spacing and responsive breakpoints;
- header and navigation anatomy;
- acting-Workspace selector presentation;
- component anatomy and card density;
- lifecycle, readiness, and operation-feedback presentation;
- accessibility and reduced-motion behavior; and
- unsupported, contradictory, or generated copy.

Generated Stitch HTML is design evidence only. It must not dictate React or Next.js component
boundaries, DOM structure, CSS strategy, data flow, or application architecture. Visual acceptance
evaluates fidelity to this addendum, not screenshot pixels or generated HTML parity.

## Authority and Precedence

The reconciled functional M2 specification remains authoritative for:

- domain behavior and terminology;
- authorization and acting-Workspace validation;
- persistence, privacy boundaries, and durable evidence;
- lifecycle transitions and marketplace eligibility;
- retry, convergence, and idempotency requirements;
- validation and controlled values;
- ProjectRequest, Deal, TermsVersion, approval, and funding semantics; and
- all other functional invariants and scope boundaries.

This UX addendum is authoritative for:

- information hierarchy and customer-facing terminology;
- navigation and acting-Workspace presentation;
- interaction and feedback patterns;
- visual semantics, typography, surfaces, and density;
- desktop and mobile adaptation;
- accessibility and motion behavior; and
- visual and UX acceptance.

Precedence is:

1. The reconciled functional M2 specification wins over this addendum on domain behavior,
   authorization, persistence, lifecycle, validation, eligibility, approvals, and funding.
2. This addendum wins over Stitch screenshots, `DESIGN.md`, and generated HTML on presentation,
   interaction, terminology, accessibility, responsive behavior, and acceptance.
3. Canonical Stitch compositions guide implementation where they do not conflict with either
   authoritative specification.
4. A generated visual or phrase must never be treated as evidence that unsupported behavior exists.

## User Stories

1. As a visitor, I want SoundHub to feel culturally specific and professionally credible without
   relying on Caribbean stereotypes, so that I can understand its identity and purpose immediately.
2. As a visitor, I want a clear path to Talent, service participation, and sign-in, so that I can
   choose my next action without decoding product terminology.
3. As a buyer, I want discovery language to remain consistent across navigation, search, and
   Matchmaker, so that I always know how to return to Talent or preserved results.
4. As an authenticated human, I want the acting Workspace visible on every Workspace-scoped screen,
   so that I know which marketplace party I represent.
5. As a member of multiple Workspaces, I want explicit current-to-target switching, so that a deep
   link never silently changes the Workspace I represent.
6. As a mobile user, I want Workspace context visible without opening the navigation menu, so that
   compact navigation does not hide consequential context.
7. As a buyer-and-seller Workspace, I want buyer and seller readiness presented independently without
   persona modes, so that I can use both capabilities from one Workspace.
8. As a new participant, I want intent choices to explain their practical consequences, so that I
   can make one explicit choice confidently.
9. As a seller, I want Professional Profile editing to feel private until publication, so that saving
   work is never confused with making it public.
10. As a seller, I want publication presented as a separate marketplace-progression action, so that I
    understand the difference between a saved draft and a public profile.
11. As a seller, I want the ServiceOffering editor divided into scannable sections with a clear
    readiness summary, so that a long form remains manageable on desktop and mobile.
12. As a seller, I want explicit Save draft feedback and recoverable retry behavior, so that I can
    trust what was preserved without assuming continuous autosave.
13. As a seller, I want audio samples to be central creative evidence rather than technical file
    administration, so that I can understand how buyers will evaluate my work.
14. As a seller with a grandfathered Active ServiceOffering, I want availability and current
    readiness shown separately, so that I can remediate without believing my listing was silently
    paused.
15. As a buyer, I want Matchmaker to begin with natural language while keeping structured filters
    available, so that I can express creative intent and still control strict constraints.
16. As a buyer, I want a recommendation to lead with seller identity, the selected ServiceOffering,
    playable audio, and evidence-grounded reasons, so that I can evaluate fit before acting.
17. As a buyer, I want `Send project request` available directly from a sufficiently detailed result,
    so that viewing another page is optional rather than a forced conversion step.
18. As a buyer, I want a sent ProjectRequest to state that no Deal, approved terms, or funded work
    exists yet, so that I understand its current consequence.
19. As a seller, I want ProjectRequest Accept and Decline actions to repeat the acting Workspace and
    explain their distinct consequences, so that I can decide deliberately.
20. As a Deal participant, I want the current TermsVersion presented as an immutable document with
    separate approval rows, so that I can distinguish proposal content from each Workspace's action.
21. As a participant without permission to approve, I want just-in-time permission setup to explain
    that setup does not approve the TermsVersion, so that the two actions cannot be confused.
22. As a participant returning from permission setup, I want to return to the same Deal and perform a
    separate approval action, so that authority setup never masquerades as consent.
23. As a buyer, I want sandbox funding clearly labeled and shown only within the Deal experience, so
    that simulated funding is not mistaken for public product positioning or real escrow.
24. As a keyboard user, I want every action, menu, dialog, form, and audio control operable with clear
    focus, so that I can complete the M2 journey without a pointer.
25. As a screen-reader user, I want names, states, errors, Workspace context, and media controls
    announced meaningfully, so that visual styling is not required to understand the interface.
26. As a user with low vision, I want zoom, reflow, readable mobile text, and composited contrast, so
    that no content or functionality disappears at larger scales.
27. As a motion-sensitive user, I want reduced-motion alternatives that preserve state and
    comprehension, so that feedback does not depend on decorative movement.
28. As a user experiencing a recoverable error, I want my entered values retained with specific
    feedback and retry, so that a network or service failure does not force unnecessary re-entry.
29. As a user whose Workspace setup is ambiguous, I want SoundHub to stop safely and explain the
    recovery context without guessing authority, so that presentation does not weaken the functional
    invariant.
30. As an implementation reviewer, I want visual acceptance tied to semantic rules and observable
    behavior rather than screenshot pixels, so that normalized, accessible implementations can be
    evaluated consistently.

## Implementation Decisions

### Canonical screen manifest and design evidence

All paths below are relative to `~/Desktop/soundhub-m2-stitch-reconciliation/`. Each directory's
`code.html` is structural and content evidence. Its `screen.png` is visual evidence only where the
file is a valid rendered image.

| Canonical screen                        | Variant | Canonical Stitch export directory                                                              | Rendered evidence                                     |
| --------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Public landing                          | Desktop | `01-product-onboarding/soundhub_landing_page_desktop/`                                         | Available                                             |
| Public landing                          | Mobile  | `01-product-onboarding/soundhub_landing_page_mobile/`                                          | Available; capture width is not a breakpoint contract |
| Initial intent selection                | Desktop | `01-product-onboarding/soundhub_initial_intent_selection_desktop/`                             | Available                                             |
| Initial intent selection                | Mobile  | `01-product-onboarding/soundhub_initial_intent_selection_mobile/`                              | Available                                             |
| Personal Workspace dashboard            | Desktop | `01-product-onboarding/soundhub_personal_workspace_dashboard_desktop/`                         | Available                                             |
| Personal Workspace dashboard            | Mobile  | `01-product-onboarding/soundhub_personal_workspace_dashboard_mobile/`                          | Available; capture width is not a breakpoint contract |
| Professional Profile editor             | Desktop | `02-transaction-authority-a/soundhub_professional_profile_editor_desktop/`                     | Unavailable; failed `screen.png`                      |
| Professional Profile editor             | Mobile  | `02-transaction-authority-a/soundhub_professional_profile_editor_mobile/`                      | Unavailable; failed `screen.png`                      |
| Professional Profile publication review | Desktop | `02-transaction-authority-a/soundhub_publication_review_desktop/`                              | Unavailable; failed `screen.png`                      |
| Professional Profile publication review | Mobile  | `02-transaction-authority-a/soundhub_publication_review_mobile/`                               | Unavailable; failed `screen.png`                      |
| Service editor with audio               | Desktop | `01-product-onboarding/soundhub_edit_your_service_desktop/`                                    | Available; capture width is not a breakpoint contract |
| Service editor with audio               | Mobile  | `01-product-onboarding/soundhub_edit_your_service_mobile/`                                     | Available; capture width is not a breakpoint contract |
| Legacy Active service remediation       | Desktop | `03-transaction-authority-b/soundhub_service_remediation_desktop/`                             | Available                                             |
| Legacy Active service remediation       | Mobile  | `03-transaction-authority-b/soundhub_service_remediation_mobile/`                              | Available; capture width is not a breakpoint contract |
| Matchmaker brief entry                  | Desktop | `01-product-onboarding/soundhub_matchmaker_brief_entry_desktop/`                               | Available                                             |
| Matchmaker brief entry                  | Mobile  | `01-product-onboarding/soundhub_matchmaker_brief_entry_mobile/`                                | Available                                             |
| Matchmaker recommendations              | Desktop | `01-product-onboarding/soundhub_matchmaker_recommendations_desktop/`                           | Available                                             |
| Matchmaker recommendations              | Mobile  | `01-product-onboarding/soundhub_matchmaker_recommendations_mobile/`                            | Available                                             |
| Buyer ProjectRequest detail             | Desktop | `02-transaction-authority-a/soundhub_buyer_request_detail_desktop/`                            | Unavailable; failed `screen.png`                      |
| Buyer ProjectRequest detail             | Mobile  | `02-transaction-authority-a/soundhub_buyer_request_detail_mobile/`                             | Unavailable; failed `screen.png`                      |
| Seller ProjectRequest detail            | Desktop | `02-transaction-authority-a/soundhub_seller_request_detail_desktop/`                           | Unavailable; failed `screen.png`                      |
| Seller ProjectRequest detail            | Mobile  | `02-transaction-authority-a/soundhub_seller_request_detail_mobile/`                            | Unavailable; failed `screen.png`                      |
| Negotiating Deal / TermsVersion         | Desktop | `02-transaction-authority-a/soundhub_negotiating_deal_desktop/`                                | Unavailable; failed `screen.png`                      |
| Negotiating Deal / TermsVersion         | Mobile  | `02-transaction-authority-a/soundhub_negotiating_deal_mobile/`                                 | Unavailable; failed `screen.png`                      |
| JIT permission-to-approve setup         | Desktop | `03-transaction-authority-b/soundhub_set_up_permission_to_approve_terms_desktop/`              | Available                                             |
| JIT permission-to-approve setup         | Mobile  | `03-transaction-authority-b/soundhub_set_up_permission_to_approve_terms_mobile/`               | Unavailable; failed `screen.png`                      |
| Permission-success return               | Desktop | `03-transaction-authority-b/soundhub_negotiating_deal_permission_set_up_return_state_desktop/` | Unavailable; failed `screen.png`                      |
| Permission-success return               | Mobile  | `03-transaction-authority-b/soundhub_negotiating_deal_permission_set_up_return_state_mobile/`  | Unavailable; failed `screen.png`                      |
| Workspace switch interstitial           | Desktop | `03-transaction-authority-b/soundhub_workspace_switch_interstitial_desktop/`                   | Available                                             |
| Workspace switch interstitial           | Mobile  | `03-transaction-authority-b/soundhub_workspace_switch_interstitial_mobile/`                    | Available                                             |
| Workspace setup recovery                | Desktop | `03-transaction-authority-b/soundhub_workspace_setup_recovery_desktop/`                        | Available                                             |
| Workspace setup recovery                | Mobile  | `03-transaction-authority-b/soundhub_workspace_setup_recovery_mobile/`                         | Available                                             |

The thirteen unavailable screenshots do not represent missing product states. Their canonical
directories and byte-identical generated HTML establish screen identity and structural evidence,
but they cannot establish pixel-level acceptance. The standalone Stitch logo and generated landing
photograph are supporting explorations, not automatically production assets. `.DS_Store` files and
`<FIFE Image failed to fetch>` placeholders are not design references.

The three files at
`01-product-onboarding/soundhub_design_system/DESIGN.md`,
`02-transaction-authority-a/soundhub_design_system/DESIGN.md`, and
`03-transaction-authority-b/soundhub_design_system/DESIGN.md` are byte-identical repeated exports.
They express one design direction, not three competing systems. Where their prose and frontmatter
differ, the semantic rules below are authoritative.

### Visual character

The locked direction is Caribbean Studio:

- warm parchment and pressed-paper foundations;
- deep ink typography rather than harsh digital black;
- aubergine structural and application language;
- coral marketplace progression;
- sea-glass supporting, selection, readiness, availability, and audio treatment;
- restrained gold warning and attention treatment;
- shallow paper-like surfaces with warm borders;
- restrained elevation reserved for overlays and genuinely raised surfaces;
- sparse track-line and waveform motifs that support hierarchy without implying analysis; and
- culturally confident Caribbean identity expressed through people, work, language, and craft rather
  than stereotypes.

The design must not use:

- flags as brand identity;
- beaches, palm trees, or tropical shorthand;
- carnival shorthand;
- neon nightclub styling;
- crypto or Web3 styling;
- AI-purple gradients;
- excessive glassmorphism or decorative blur;
- excessive pills or hyper-rounded structural controls;
- generic enterprise SaaS styling; or
- nested-card-heavy composition.

### Color foundations and semantic families

The values below are visual anchors, not immutable values for every state:

- canvas around `#FAF7F2`;
- resting surface around `#F4EFEA`;
- elevated and input surface in white;
- primary ink around `#19151D`;
- muted text around `#4D444B`; and
- warm border around `#E8DFD5`.

Each functional family requires appropriate foreground, subtle-background, border, hover, pressed,
disabled, and focus variants where relevant. Contrast is evaluated using the actual composited state.
Accessibility takes precedence over exact Stitch hex parity while preserving recognizable brand
identity.

#### Aubergine: structural, application, authority, and management

The base visual reference is around `#3B1E3E`. Aubergine covers navigation, Save and Save draft,
review, TermsVersion approval, permission setup, Workspace switching, recovery, and management
actions. It remains the primary treatment for high-consequence application actions even when those
actions are the most prominent control in their decision region.

#### Coral: marketplace progression only

The base visual reference is around `#E05A47`. Coral covers `Find talent`,
`Send project request`, `Publish profile`, and `Activate service`. Coral means progression into or
through marketplace participation. It must not be applied merely because a button is important or
visually dominant.

#### Sea-glass: supporting state

The base visual reference is around `#5C9E94`. Sea-glass may support selected controls, readiness and
completion, marketplace availability, and audio/progress treatment. Those meanings remain distinct
through labels, icons, component anatomy, and surrounding copy. Sea-glass is not one universal
`success` state.

#### Gold and danger

Gold is limited to warning and attention. It must never imply verification, awards, credentials,
premium status, or trust. Danger red is limited to destructive actions and failure. Destructive
controls should remain restrained until the user enters the bounded decision region.

Color never communicates lifecycle, readiness, approval, validation, funding, or progress alone.

### Typography

Typography is semantic:

- **Editorial serif means orientation, identity, and document character.** It is appropriate for
  page-level titles, true major orientation or narrative headings, SellerProfile professional names,
  ServiceOffering names when used as identity, landing-page editorial statements, the current
  TermsVersion or document title, and short user-authored ProjectBrief quotations.
- **Application sans means operating SoundHub.** It is required for global and local navigation,
  links, buttons, dense editor-section labels, form labels and inputs, helper and error text,
  Workspace context, authority explanations, lifecycle and readiness states, approval and permission
  states, prices, dates, IDs, counts, metadata, tables, activity rows, audio controls, lifecycle
  controls, and long operational, legal, confirmation, or attestation text.

Serif is not the default merely because text is a heading. In dense editors, headings such as
Overview, Delivery, Pricing, Work samples, and Optional details use the application sans unless they
form a genuine page-orientation boundary. Serif italics are reserved for short user-authored
quotations.

Mobile titles preserve readable sizes, wrap naturally, and step down responsively. They must not be
compressed to preserve desktop line breaks. Body and form-input text remains at least 16px on mobile.

### Surfaces, spacing, and density

- Top-level pages use a warm canvas and a consistent bounded content width on desktop.
- Resting sections use shallow tonal separation and warm borders rather than heavy elevation.
- White is primarily reserved for inputs, overlays, and clearly elevated content.
- Major cards use disciplined 12–16px radii; controls may use smaller radii. Full pills are reserved
  for compact semantic statuses or selectors where their shape aids recognition.
- One exterior surface should normally contain rows and dividers rather than multiple nested cards.
- Spacing follows a normalized 4/8px rhythm with larger section intervals chosen by hierarchy.
- Whitespace must group related content and separate decisions; it must not create large unexplained
  gaps like failed Stitch asset regions.
- Each bounded decision region has only one visually dominant action.

Exact Stitch dimensions, spacing measurements, and exported viewport widths are not acceptance
criteria.

### Navigation and terminology

The public discovery route is `/talent`.

- Global navigation noun: **Talent**.
- Public and dashboard call to action: **Find talent**.
- Discovery-page primary heading or task phrase: **Find talent**.
- Matchmaker primary action: **Find talent**.
- Return to a preserved Matchmaker or search result set: **Back to results**.
- Return directly to the general `/talent` surface: **Back to talent**.

`Talent` is a discovery and navigation term, not a UserAccount role, WorkspaceCapability,
SellerProfile type, or seller identity mode.

The interface must not use `/find`, `Talent directory`, `Browse creators`, `Creator marketplace`, or
competing discovery terminology.

#### Public navigation

Public navigation contains the SoundHub identity, Talent, Offer services, and Sign in. Mobile public
navigation uses a menu rather than bottom navigation. The primary public page action is clear without
requiring the menu.

#### Authenticated navigation

Authenticated navigation supports Home, Talent, Requests, Deals, and Your services when those
destinations are applicable to the acting Workspace. Buyer and Seller areas coexist for a
dual-capability Workspace; navigation must not become a Buyer/Seller persona switch.

Desktop keeps primary destinations, acting Workspace, and account controls in predictable chrome.
Mobile uses menu-only destination navigation. M2 does not introduce bottom navigation.

### Acting Workspace as persistent product context

Acting Workspace is product context, not merely navigation state.

On every normal authenticated, Workspace-scoped mobile route, a compact acting-Workspace control is
visible outside the menu and visually subordinate to the current page or task. Public, signed-out,
and genuinely non-Workspace-scoped surfaces omit it. A recovery surface where no acting Workspace
can be resolved safely shows signed-in and recovery context rather than fabricating a selector.

Long Workspace names may truncate visually in compact chrome only when:

- the full name remains available to assistive technology;
- opening the selector reveals the full name; and
- consequential local confirmation shows the full name where practical.

Consequential regions repeat the full acting Workspace immediately beside or above the action,
including:

- ProjectRequest Accept and Decline;
- TermsVersion approval;
- permission-to-approve setup;
- sandbox funding;
- Pause and other destructive ServiceOffering actions; and
- similarly consequential Workspace-scoped commands whose effect is difficult to undo or
  misunderstand.

Workspace switching never occurs silently. A deep link requiring another Workspace presents an
interstitial with the explicit current and target Workspaces, revalidates access, and offers a safe
exit. Incomplete Workspace-scoped input remains associated with its originating Workspace and never
silently carries across. The selector represents the acting Workspace only; it never becomes a
Buyer/Seller mode or a source of authority.

### State, alias, readiness, and feedback presentation

M2 has two authoritative state sources but three UI presentation categories.

#### 1. Durable lifecycle and domain state

Examples include:

- SellerProfile: `Draft`, `Published`;
- ServiceOffering: `Draft`, `Active`, `Paused`, `Archived`;
- ProjectRequest: `Pending`, `Accepted`, `Declined`;
- Deal: `Negotiating`, `Active`; and
- persisted approval and funding states only where those states actually exist in the domain.

Presentation never replaces these authoritative states with readiness language.

#### 2. Customer-facing aliases mapped to durable state

Aliases are presentation labels, not new domain states:

- SellerProfile `Draft` maps to **Private draft**;
- ServiceOffering `Active` maps to **Available**; and
- ProjectRequest `Pending` maps to **Awaiting response**.

Other canonical states retain their customer-readable names where already clear. Every alias must
map unambiguously to exactly one durable state.

#### 3. Derived readiness and transient operation feedback

Derived labels include **Ready**, **Needs attention**, **Update needed**, **Permission needed**,
**Permission set up**, **Pending approval**, **Waiting for approvals**, **Ready to fund**,
**Saving**, **Saved**, and **Couldn't save**. They are computed from durable records or current UI
activity and must not become invented persistent entities or lifecycle states.

Guardrails:

- `Ready` never replaces a durable lifecycle state.
- An Active legacy ServiceOffering may show **Available** and separately **Update needed**.
- An existing **Archived** ServiceOffering, when surfaced, is presented as **Archived** rather
  than as a default, unknown, or indistinguishable state, and its transition semantics remain
  governed by existing authoritative repository behavior.
- A Draft ServiceOffering is **Private draft**. “Not visible” may explain a consequence but is not a
  lifecycle state.
- **Approved** requires real persisted approval evidence.
- **Pending approval** may be derived from the absence of approval for the current TermsVersion and
  must not imply a persisted `PendingApproval` entity.
- Funding presentation maps to real application/provider state and never invents a guarantee.
- Invented labels such as Tier 1, Phase 1 of 3, Ledger stage, Received proposal, Reviewing stems, and
  Deal Formation Gate are prohibited.

Status treatment combines readable text, suitable iconography where helpful, and component anatomy.
Color alone is insufficient.

### Action hierarchy and semantic distinctions

- Coral identifies marketplace progression; aubergine identifies structural, application,
  authority, and management actions.
- A neutral outlined treatment is secondary.
- A text action is tertiary.
- Danger remains visually restrained and isolated from the primary path until required.
- One bounded decision region has one visually dominant action.

Presentation must preserve these distinctions:

- Save draft is not Publish profile or Activate service.
- Set up permission is not Approve TermsVersion.
- Accept ProjectRequest is not approval of terms.
- Selecting or remembering a Workspace is not authority.
- SellerProfile publication is not ServiceOffering availability.
- ProjectRequest creation is not Deal creation.
- A Deal becoming Negotiating is not a Deal becoming Active.

### Forms, explicit saving, and recovery

- Forms use persistent visible labels; placeholders never serve as the sole label.
- Complex choices receive concise, contextual helper text without exposing engineering terminology.
- Validation appears beside the relevant field and is programmatically associated with it.
- Substantial or consequential forms with multiple possible errors include a focusable, linked error
  summary that navigates to each invalid field.
- Validation should occur at an understandable boundary and must not produce disruptive errors while
  the user is still typing.
- Save and Save draft are explicit. M2 does not use continuous autosave or continuous sync.
- During submission, the initiating control exposes loading state and prevents duplicate submission.
- Success feedback identifies what was saved without implying publication, activation, approval, or
  another later transition.
- A recoverable failure retains entered values, provides specific error guidance, and exposes an
  operable retry.
- Navigation away from unsaved input uses a bounded warning when loss would otherwise be surprising.
- Sticky action regions reserve layout space and never obscure content, focus, helper text, or
  validation.

Save persists the applicable private draft according to the functional specification. Publish and
Activate are separate coral marketplace-progression actions with their own readiness review,
confirmation, loading, success, failure, and retry presentation. The UX must never claim that an
ordinary save performed a later transition.

When durable Workspace or resource state is ambiguous, presentation stops safely, avoids automatic
authority claiming or record selection, explains what could not be confirmed, and offers only
recovery actions supported by the functional specification.

### Audio-player pattern

Audio is central evidence on ServiceOffering and Matchmaker surfaces rather than generic file
administration.

The reusable player provides:

- the sample title and relevant seller or ServiceOffering context;
- play and pause;
- current position and duration or equivalent progress information;
- keyboard-operable controls with screen-reader names;
- non-disruptive playback-state semantics;
- a static or decorative waveform/track-line treatment that is not required to operate playback;
- clear private/public context where relevant;
- no autoplay; and
- a reduced-motion fallback with stable progress presentation.

The interface must not imply unsupported signal analysis, BPM detection, technical certification,
bit-depth validation, mastering quality, or waveform generation. Removal and replacement controls
in a seller editor are visually and semantically separate from playback to prevent accidental loss.
Playback updates must not create excessive live-region chatter.

### Screen-specific UX requirements

These requirements summarize presentation and interaction. The functional specification remains the
source for authorization, validation, persistence, lifecycle, and transition semantics.

#### Public landing

- Position SoundHub through the sequence **discover → hear → request → agree on terms**.
- Lead with Caribbean creative Talent and ServiceOfferings, not technology or simulated funding.
- Keep the audience broad enough for ongoing customer discovery; do not narrow positioning around
  event planners, beats, studios, producers, venues, or another unvalidated ideal customer profile.
- Use generated or mock imagery as design evidence without making production photography a
  prerequisite for M2 UX acceptance.
- Do not use fake traction, testimonials, customer logos, verification, or trust claims.
- Do not market sandbox funding publicly.

#### Initial intent selection

- Present Hire talent, Offer services, and Both as mutually exclusive choices within the acting
  Personal Workspace.
- Keep the acting Workspace visible and explain that the other capability may be added later.
- Do not collect a generic Seller participation/terms acceptance at capability-provisioning time;
  no legal text, no acceptance checkbox, and no terms version/hash appear on the intent
  surface. Context-specific confirmations remain owned by their later boundaries (SellerProfile
  publication, media use, ServiceOffering activation, Deal approval authority / approval).
- Explain that capability does not grant permission to approve terms without exposing internal
  implementation vocabulary.
- Use one explicit submit action with retry-safe feedback; do not imply that selecting a card has
  already persisted the choice.

#### Personal Workspace dashboard

- Treat the dashboard as a Workspace-scoped readiness and activity home, not an exhaustive onboarding
  checklist or persona chooser.
- Lead with the most relevant derived next action, followed by independent buyer and seller surfaces.
- Show dual-capability Workspaces without switching modes.
- Use compact Requests and Deals activity grounded in real records; do not invent a generalized
  activity feed.
- Keep optional permission-to-approve setup discoverable but low prominence until a Negotiating Deal
  makes it contextually relevant.
- Empty and readiness states must not globally block unrelated capability use.

#### Professional Profile editor

- Lead with **Private draft**, explicit Save draft, and the fact that ordinary save does not publish.
- Group professional identity, marketplace location, and self-declared Caribbean connection into
  clear sections.
- Describe based-in country as current marketplace location, not nationality or identity.
- State that Caribbean connection is self-declared and unverified.
- Use readiness to guide publication without presenting completeness as verification.
- Desktop may use a section index when the form length warrants it; mobile uses one document flow and
  a compact section-jump control if useful.

#### Professional Profile publication review

- Provide a read-only public preview and a distinct publication confirmation.
- State that the saved draft remains private until publication.
- Explain that a Published SellerProfile alone does not make ServiceOfferings Available.
- Use coral only for **Publish profile**; Back to edit remains secondary.
- Show a stable success state before any offered next step. Do not imply silent activation or an
  unavoidable redirect.

#### ServiceOffering editor with audio

- Present one private Draft ServiceOffering through scannable overview, delivery, pricing, work
  sample, optional-detail, and readiness sections where those fields exist in the functional
  contract.
- Keep Save draft structurally separate from the coral activation path.
- Show explicit pricing choice and audio readiness without inventing controlled values or technical
  standards.
- Support zero to three Draft samples visually and explain the activation requirement without
  exposing storage internals.
- Private playback is clearly labeled; removal is separated from playback and receives appropriate
  confirmation when consequential.
- Activation review is an explicit boundary rather than an automatic consequence of completing a
  field.

#### Legacy Active ServiceOffering remediation

- Present **Available** and **Update needed** separately and simultaneously.
- Explain the one-way convergence rule and continuity of existing engagement records in plain
  language grounded in the functional specification.
- Organize missing requirements as actionable readiness rows without fabricating migration evidence,
  compliance standards, historical versions, inquiries, or prior decisions.
- Keep Pause visually separate and restrained, with full acting-Workspace context and consequence
  confirmation.

#### Matchmaker brief entry and recommendations

- Begin with the natural-language ProjectBrief and keep M1 structured filters available through
  progressive disclosure.
- Required filters are presented as strict and are never described as automatically relaxed.
- Preserve entered brief and filter state according to the functional recovery contract; do not
  claim continuous autosave.
- Brief Entry and Recommendations are distinct stages, not duplicate screens.
- Results lead with seller identity, the selected ServiceOffering, price presentation where present,
  playable audio, and evidence-grounded **Why this matches**.
- Do not show match-confidence scores, verification, vetting, or inferred identity.
- A sufficiently detailed and eligible result offers coral **Send project request** directly;
  **View service details** is secondary.
- Additional ServiceOfferings from the same SellerProfile may be disclosed without obscuring the
  selected match.
- Use **Back to results** for preserved results and **Back to talent** for the general discovery
  surface.

#### Buyer and seller ProjectRequest detail

- The buyer view leads with **Awaiting response**, the selected seller and ServiceOffering, submitted
  ProjectBrief, constraints, and what happens next.
- The seller view leads with the incoming request, buyer Workspace, selected ServiceOffering,
  ProjectBrief, constraints, and the explicit Accept/Decline decision.
- Both views state that no Deal, approved terms, funded work, or started work exists at this stage.
- Seller acceptance explains that it opens a Negotiating Deal and does not approve terms.
- Decline explains that it creates no Deal.
- The seller decision region repeats the full acting Workspace. Accept and Decline remain distinct;
  decline uses restrained danger treatment and bounded confirmation.
- Do not describe seller acceptance as mutual acceptance, booking, assignment, or a messaging flow.

#### Negotiating Deal and TermsVersion

- Present the Deal identity and **Negotiating** state before the current TermsVersion.
- Present the current TermsVersion as an immutable document with clear version identity and
  structured sections derived from real terms.
- Explain that AI may draft but never approve.
- Show buyer and seller Workspace approval rows independently for the same current TermsVersion.
- Show the activation sequence without inventing persisted workflow entities.
- Repeat the acting Workspace beside its approval action.
- Make approval aubergine, not coral.
- Make clear that replacement terms invalidate earlier approvals and funding waits for required
  approvals.
- Do not inject default licenses, copyright outcomes, technical deliverables, or legal guarantees
  merely because they appeared in Stitch example copy.

#### Permission-to-approve setup and success return

- Enter just in time from the pending approval action, or from the contextually appropriate dashboard
  readiness entry.
- Explain in plain language which human is setting up permission for which Workspace.
- Make the confirmation explicit and keep long attestation text in application sans.
- State that setup does not approve the current TermsVersion.
- After success, return to the same Deal and show **Permission set up** beside the still-separate
  **Approve Version N** action.
- Do not surface `DealApprover`, ledger protocol, governance internals, provider identity, or invented
  legal guarantees as customer terminology.

#### Sandbox funding

- Keep sandbox funding inside the Deal/funding experience and label it explicitly as simulated.
- Present it only when real application state permits the corresponding action.
- Repeat the acting buyer Workspace beside the action.
- Distinguish waiting for approvals, ready to fund, in-progress operation feedback, confirmed funding,
  and Active Deal presentation without inventing persistent states.
- Do not use escrow-protection, wallet, dispute, security, or settlement guarantees.

#### Workspace switching

- Show the current and required target Workspaces explicitly.
- Explain that access will be revalidated and scoped input will not move between Workspaces.
- Offer **Switch and continue** as the aubergine primary action and a safe return as secondary.
- Do not imply that the remembered selector grants authority or that a deep link switched context.

#### Workspace setup recovery

- Use a calm interruption surface with signed-in context, a concise explanation, a reference identifier
  where supported, and safe recovery/exit actions.
- State that SoundHub did not guess, merge, choose, or automatically grant control.
- Do not fabricate an acting-Workspace selector when none can be resolved safely.
- Do not promise a support workflow, security guarantee, or automatic recovery process not provided by
  the functional specification.

### Canonical reusable UX patterns

The following patterns are sufficiently demonstrated to guide consistent reuse:

| Pattern                    | Canonical behavior                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Public header              | SoundHub identity, Talent, Offer services, Sign in; menu-only mobile adaptation                     |
| Authenticated header       | Primary destinations, account access, and persistent acting-Workspace context without persona modes |
| Acting-Workspace selector  | Compact product context; accessible full name; explicit current-to-target switching                 |
| Editorial page heading     | Serif orientation boundary followed by concise sans operational context                             |
| Status treatment           | Durable state or direct alias shown separately from derived readiness; text is mandatory            |
| Readiness row and summary  | Requirement, state, consequence, and contextual action without pretending to be lifecycle state     |
| Prioritized-action surface | One derived next action leading the dashboard without an exhaustive checklist                       |
| Explicit-save feedback     | Saving, Saved, or Couldn't save with preserved-input and retry behavior                             |
| Audio sample player        | Context, accessible playback, progress, nonessential waveform, no autoplay                          |
| Form section               | Visible heading, fields, helper/validation text, and clear section boundaries                       |
| Desktop section index      | Optional navigation for genuinely long editors; not required for short forms                        |
| Mobile document flow       | One-column reading/action sequence with optional compact section jump                               |
| Activity row               | Real record identity, relationship, stage, time, and next action; no generalized feed               |
| Request/Deal row           | Counterparty, scope, Workspace relationship, durable/derived stage, and contextual action           |
| TermsVersion section       | Immutable current-version identity and structured real terms                                        |
| Approval-state row         | Party Workspace, human attribution where appropriate, current-version state, and local action       |
| Sandbox status surface     | Explicit simulated label, real gating state, amount where supported, and action/status              |
| Confirmation dialog        | Consequence, full Workspace context, one dominant action, safe cancellation, focus management       |
| Workspace switch dialog    | Explicit current and target Workspaces, access warning, safe exit, confirmed switch                 |
| Recovery surface           | Calm fail-safe explanation and supported recovery/exit without fabricated authority                 |

A generalized empty-state visual is not sufficiently demonstrated to be canonical. Implementations
still require truthful contextual empty states under the functional specification, but this addendum
does not invent one universal composition merely to complete the pattern catalog.

### Customer-language governance

Implementation must remove Stitch-generated claims or terminology that implies:

- verified Talent, verified matches, professional vetting, or cultural/identity verification;
- studio or acoustic standards, EBU compliance, bit-depth compliance, stem compliance, or mastering
  guarantees;
- escrow protection, dispute protection, copyright guarantees, or ownership guarantees;
- booking, chat, messaging, counteroffers, or broader negotiation tooling;
- a public-directory product architecture or standalone public-profile expansion;
- continuous sync or autosave;
- Studio, Creative Studio, Studio Console, Workspace Hub, Workspace Portal, or similar competing
  product shells;
- AI confidence scores or identity inference;
- invented security, governance, compliance, recovery, or creator-protection systems; or
- `DealApprover`, provider subjects, storage identifiers, or other internal terminology.

Fictional names, Workspaces, projects, prices, dates, genres, sample titles, and user-authored creative
descriptions are acceptable when they do not imply platform behavior, validation, certification,
authority, or guarantees.

### Responsive behavior

Responsive implementation expresses normalized intent rather than copied viewport dimensions:

- Mobile uses menu-only destination navigation and no bottom navigation.
- Workspace-scoped mobile screens keep a compact acting-Workspace control outside the menu.
- Mobile screens use one-column document flows and content-first ordering.
- Desktop tables and multi-column activity regions become structured rows or cards on mobile.
- Desktop section indexes appear only where content length warrants them.
- Primary and secondary action order remains stable across breakpoints.
- Sticky actions reserve space and never obscure content, focus, or errors.
- Long labels and Workspace names wrap or truncate safely without losing accessible content.
- Long text reflows without horizontal page scrolling.
- Serif headings wrap naturally rather than preserving desktop line breaks.
- Generated widths such as 172px, 197px, 247px, 274px, 453px, or 624px are export artifacts, not
  breakpoints or acceptance viewports.

### Accessibility and functional motion

The following are mandatory M2 UX acceptance criteria:

- WCAG 2.2 AA contrast is measured using actual composited foreground and background states.
- Browser zoom and responsive reflow preserve content and functionality.
- DOM and keyboard order follow the meaningful reading and action sequence.
- Every interactive control has a visible focus indicator.
- Sticky headers, footers, and action regions never obscure the focused element, validation message,
  or relevant content.
- Mobile interactions provide practical target areas of approximately 44×44px or larger with
  adequate separation. A smaller visible icon may use a larger interactive hit area.
- Mobile body and form-input text remain at least 16px.
- Form labels are visible, and field errors are programmatically associated with their controls.
- Substantial or consequential multi-error forms provide a focusable, linked error summary.
- Recoverable submission failures preserve entered values and expose an operable retry.
- Icon-only controls have accessible names.
- Selected, expanded or collapsed, disabled, current, invalid, and loading states are exposed
  semantically where applicable.
- Lifecycle, readiness, validation, approval, funding, and progress never depend on color alone.

Dialogs and interstitials move focus appropriately into the active surface, contain keyboard focus
while modal, and restore focus to the invoking control or appropriate destination when dismissed.
Before consequential submission they provide Cancel, Back, or Escape dismissal where safe. Escape is
not an unconditional rule after an operation is irreversible or actively committing.

Audio never autoplays. Playback controls are keyboard-operable and screen-reader named. Playback
state, current position, duration, and actions are exposed without excessive live-region chatter.
Decorative waveform treatment is never required to understand or control playback.

Motion communicates cause, state, spatial continuity, or feedback. M2 avoids decorative parallax,
scroll scrubbing, continuous waveform animation, and elaborate reveal sequences. The interface honors
`prefers-reduced-motion`, replacing nonessential movement with stable or near-instant alternatives
while preserving state and comprehension. Correctness and interaction completion never depend on an
animation finishing.

Screenshots cannot prove accessibility acceptance.

## Testing Decisions

### Test philosophy

UX tests assert observable behavior, semantics, and presentation contracts rather than React
component structure, CSS class names, pixel coordinates, generated Stitch DOM, or screenshot-perfect
parity. Use the highest existing browser seam for the integrated M2 journey, supplemented by focused
component or route-level tests only where they provide clearer failure localization.

### Required automated coverage

- Navigation tests verify `/talent`, canonical Talent/Find talent wording, menu-only mobile
  navigation, and contextual back labels.
- Workspace-context tests verify visible scoped context, accessible full names, consequential local
  repetition, explicit current-to-target switching, safe deep-link behavior, and absence of
  Buyer/Seller modes.
- Form tests verify visible labels, explicit Save draft, loading and duplicate-submit prevention,
  success feedback, field errors, linked error summaries, preserved values, and retry.
- State-presentation tests verify the mapping between durable state, customer alias, readiness, and
  transient feedback without asserting invented persistence.
- Profile and ServiceOffering tests verify that Save, Publish, and Activate are distinct actions with
  distinct feedback and prominence.
- Legacy-remediation tests verify simultaneous **Available** and **Update needed** presentation.
- Matchmaker tests verify natural-language-first hierarchy, structured filters, strict-filter copy,
  evidence-grounded reasons, audio prominence, direct `Send project request`, and secondary service
  details.
- ProjectRequest tests verify buyer/seller hierarchy, acting-Workspace repetition, acceptance and
  decline consequences, and the absence of terms-approval implications.
- Deal tests verify current TermsVersion identity, independent approval rows, permission-versus-
  approval separation, sandbox labeling, funding gating presentation, and activation hierarchy.
- Dialog tests verify initial focus, containment, safe dismissal, focus restoration, and prevention of
  duplicate consequential submission.
- Audio tests verify no autoplay, keyboard operation, accessible names and state, progress semantics,
  private/public labels, and reduced-motion behavior.
- Responsive tests cover representative small mobile, larger mobile, tablet/intermediate, and desktop
  widths chosen by implementation behavior rather than Stitch capture widths. They verify reflow,
  action order, Workspace visibility, menu behavior, lack of horizontal page scrolling, and sticky
  region clearance.
- Accessibility automation checks detectable WCAG violations, but manual keyboard, screen-reader,
  zoom/reflow, composited contrast, reduced-motion, and focus-obscuration review remain required where
  automation cannot prove behavior.

### Visual review

Implementation review evaluates:

- fidelity to Caribbean Studio character;
- major screen composition and information hierarchy;
- action order and relative prominence;
- semantic color-family usage;
- the editorial-serif versus application-sans boundary;
- canonical navigation terminology;
- persistent Workspace context;
- separation of lifecycle, aliases, readiness, and transient feedback;
- normalized responsive intent;
- accessibility and functional motion;
- customer-language correctness; and
- consistent reuse of canonical patterns.

Visual review explicitly rejects:

- pixel-perfect screenshot comparison;
- generated Stitch HTML or DOM parity;
- exact reproduction of unreliable exported viewport dimensions;
- failures caused solely by normalized accessible token values or spacing; and
- implementation of unsupported generated copy for visual fidelity.

### Traceability matrix

`UXG` identifies the settled UX-grill decision that governs the rule.

| UX rule                                            | Functional invariant protected                                                | Canonical Stitch evidence                                      | UX-grill decision |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------- |
| Systematic normalization, not pixel parity         | Functional specification remains authoritative                                | Entire corpus; thirteen failed rendered variants               | UXG-1             |
| Semantic color families                            | Actions retain distinct functional consequences                               | Landing, dashboard, editors, Matchmaker, Deal, switch/recovery | UXG-2             |
| Talent noun and Find talent action                 | Talent remains discovery language, not authority                              | Landing, dashboard, Matchmaker                                 | UXG-3             |
| Serif for orientation/identity; sans for operation | Dense and consequential content remains legible                               | Landing, editors, dashboard, Deal                              | UXG-4             |
| Durable state, alias, and readiness separation     | UI does not invent or obscure persisted lifecycle state                       | Dashboard, publication, service remediation, Deal              | UXG-5             |
| Persistent acting-Workspace context                | Selection is convenience only; actions name and validate the acting Workspace | All scoped screens; switch and recovery                        | UXG-6             |
| Consequential local Workspace repetition           | Party-scoped actions remain unambiguous                                       | Seller request, Deal approval, permission, funding, Pause      | UXG-6             |
| Explicit Save and recoverable failure              | Retry/persistence semantics remain truthful                                   | Profile editor, service editor, Matchmaker                     | UXG-1, UXG-7      |
| Permission setup separate from approval            | Approval authority does not itself approve a TermsVersion                     | JIT permission and permission-success return                   | UXG-1, UXG-6      |
| Accessible audio evidence                          | Audio remains usable without autoplay or visual-only controls                 | Landing, service editor, Matchmaker, requests                  | UXG-7             |
| WCAG 2.2 AA and functional motion                  | Presentation does not exclude users or depend on animation                    | All canonical screens                                          | UXG-7             |
| Unsupported-copy prohibition                       | Stitch does not expand M2 product behavior                                    | Entire corpus                                                  | UXG-1             |

## Out of Scope

- Changing, replacing, or restating the functional M2 domain contract.
- Pixel-perfect reproduction of Stitch screenshots or generated HTML.
- Treating invalid Stitch screenshots as missing product requirements.
- Selecting frontend libraries, component architecture, CSS tooling, or implementation modules.
- A generalized design system beyond what the canonical M2 screens require.
- A generalized canonical empty-state composition not demonstrated by the corpus.
- Dark mode unless separately approved; the supplied M2 direction is a light parchment system.
- Bottom navigation for M2.
- Continuous autosave or sync.
- Production photography or commissioned illustration as an M2 prerequisite.
- Organization Workspace creation, invitations, membership administration, ownership transfer, or
  multi-member authority management.
- Buyer/Seller persona modes or exclusive-role product shells.
- Messaging, chat, counteroffers, clarification threads, or broad negotiation tooling.
- Delivery, revisions, acceptance, release, disputes, reporting, moderation, ratings, or reviews.
- Real wallets, escrow, payment protection, release, refund, or settlement UI.
- Portfolios, catalogs, public SellerProfile expansion, or public-directory architecture.
- Verified identity, Talent vetting, cultural verification, technical audio certification, or trust
  badge systems.
- Generalized audit trails, customer activity feeds, notification programs, or security/compliance
  systems.
- Any other deferred M3–M7 behavior identified by the reconciled functional specification.
- Tickets, implementation plans, migrations, source changes, configuration changes, commits, pushes,
  or deployment.

## Further Notes

- Exact legal and attestation text still requires the product/legal review required by the functional
  M2 specification. This addendum governs presentation of that text, not its legal substance.
- Controlled values, price formats, sample constraints, validation rules, and transition eligibility
  come from the functional specification and existing contracts, not from Stitch examples.
- The UX must use `SellerProfile`, `ServiceOffering`, `ProjectRequest`, `Deal`, and `TermsVersion`
  precisely where canonical domain clarity is necessary while translating internal-only terminology
  into plain customer language.
- Before UX acceptance, reviewers must verify every settled UX-grill decision, confirm that no
  generated claim became product behavior, confirm compatibility with the functional specification,
  and test accessibility directly.
- This document is intentionally specific enough to support a later `to-tickets` workflow without
  being an implementation plan. No tickets are created by this specification.
