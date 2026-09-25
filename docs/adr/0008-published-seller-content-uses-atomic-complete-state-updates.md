---
status: accepted
---

# Published seller content uses atomic complete-state updates

For Milestone 2 self-service editing, a published SellerProfile update validates the complete
resulting publishable state and atomically replaces the current public field set. An Active
ServiceOffering update validates the complete resulting Active state and atomically replaces its
current public listing fields. Failed updates preserve the prior public state unchanged. M2
introduces no persistent post-publication working draft and no generalized browsable revision
history for SellerProfile or ServiceOffering content.

This decision intentionally supersedes
`docs/adr/0005-published-seller-content-uses-immutable-revisions.md` for the scope of M2
self-service editing of published SellerProfile and ServiceOffering content. ADR 0005's Gate 0
immutable-revision architecture is not introduced in M2; pre-publication incomplete drafts remain
private and resumable, and post-publication edits are explicit complete-state replacements
validated against the full resulting state.

Existing ProjectBriefs, ProjectRequests, Deals, TermsVersions, approvals, and funding records
retain their established references and snapshots and are not retroactively rewritten by later
profile or offering edits. Retry and concurrency safety remain required at the M2 command
boundary even though generalized immutable content revisions are not introduced.

## Consequences

- Post-publication SellerProfile edits are one explicit complete-state command that validates the
  full resulting publishable state and atomically replaces the current public fields.
- Post-activation ServiceOffering edits follow the same model: full validation, atomic replacement
  of the current public listing fields, and failure preserves the prior Active listing.
- Failed updates preserve the prior public or Active state unchanged; partial public state is
  never observed.
- M2 introduces no persistent post-publication working draft, post-activation working draft, draft
  history, or generalized browsable revision history.
- Existing ProjectBriefs, ProjectRequests, Deals, TermsVersions, approvals, and funding records
  retain their established commercial meaning and are not retroactively rewritten by later
  profile or offering edits.
- Retry and concurrency safety are required at the M2 command boundary even without generalized
  immutable content revisions.
- Archive transition semantics for ServiceOffering remain governed by existing authoritative
  repository behavior and existing accepted ADRs; this ADR introduces no new Archive transition
  semantics.
