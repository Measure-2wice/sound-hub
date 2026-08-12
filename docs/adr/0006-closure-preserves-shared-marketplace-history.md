---
status: accepted
---

# Closure preserves shared marketplace history

Account and Workspace removal is a closure process, not an immediate cascading deletion. Closure
revokes authority and removes ineligible public content while preserving shared Workspace continuity
and the minimum evidence required by approved retention classes. This prevents one human from
destroying another member's marketplace activity and avoids losing security or future binding
history.

## Consequences

- Ordinary closure commands transition state and never directly hard-delete the marketplace graph.
- A UserAccount cannot close in a way that orphans a Workspace or deletes other members' work.
- Closing one member does not close an organizational Workspace.
- Eligible private data is later deleted or anonymized according to an approved retention policy;
  retention is not automatically permanent.
- Database cascades may support explicitly approved final cleanup, but they are not the account or
  Workspace closure behavior.
