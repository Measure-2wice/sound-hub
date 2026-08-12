---
status: accepted
---

# Published seller content uses immutable revisions

Published SellerProfile and ServiceOffering content is an immutable revision, distinct from its
private working revision and lifecycle state. Editors and Owners may prepare changes without
altering the public version; an authorized Owner publishes a complete validated revision atomically.
This avoids partial public edits and preserves what buyers and operators could observe at a point in
time.

## Consequences

- Incomplete working drafts are allowed; publish and activation commands validate completeness.
- Publishing creates a new public revision rather than overwriting prior published evidence.
- Optimistic concurrency rejects stale edits using an explicit revision value.
- Seller publication intent, offering lifecycle, and platform enforcement remain separate state.
- Existing M1.1 SellerProfile and ServiceOffering content becomes the initial published revision
  during migration without changing its public identifier.
