# Slice Resolution Reference

Use this reference only when a tracked implementation-slice plan exists.

The goal is to determine the next slice from repository evidence rather than requiring the user to manually edit a prompt for each slice.

## Resolution principle

Resolve from:

```text
slice plan
+ dependency graph
+ committed implementation
+ tests
+ current diff
```

Never resolve from model memory alone.

## Slice state classification

### COMPLETE

A slice is COMPLETE when:

- its required behavior/contracts exist in committed HEAD;
- its required tests exist and are wired into expected gates;
- no required acceptance criterion is obviously absent;
- its dependencies are complete;
- there is no uncommitted work needed to finish it.

A clean worktree alone does not prove COMPLETE.
A commit message mentioning the slice alone does not prove COMPLETE.

### IN_PROGRESS

A slice is IN_PROGRESS when:

- uncommitted/staged changes materially implement its scope; or
- committed HEAD contains only part of its acceptance criteria and current uncommitted work continues it.

Do not advance beyond an IN_PROGRESS slice.

### NOT_STARTED

A slice is NOT_STARTED when its acceptance criteria are materially absent and no current diff is implementing it.

### BLOCKED

A slice is BLOCKED when:

- a dependency is incomplete;
- issue/spec conflicts prevent safe implementation;
- the slice plan conflicts with repository architecture;
- required prior schema/API work is missing;
- unrelated working-tree changes make implementation unsafe.

## Selection algorithm

1. Parse all slices and dependencies.
2. Classify each slice.
3. If exactly one slice is IN_PROGRESS, select it.
4. If more than one slice is IN_PROGRESS, STOP for scope leakage.
5. If none is IN_PROGRESS, find the first NOT_STARTED slice whose dependencies are COMPLETE.
6. If tracked `CURRENT REVIEW TARGET` is COMPLETE and committed, the next eligible slice may be selected.
7. If tracked target is NOT_STARTED, select it when dependencies are COMPLETE.
8. If tracked target is partial/ambiguous, STOP; do not silently advance.
9. If all slices are COMPLETE, final issue review is next.

## Updating CURRENT REVIEW TARGET

Automatically update `CURRENT REVIEW TARGET` only when all are true:

- worktree is clean before starting new implementation;
- current target is COMPLETE in committed HEAD;
- the next eligible slice is unambiguous;
- all next-slice dependencies are COMPLETE.

The target update should be the smallest possible documentation change.
Format the document after editing.

Do not update the target to the following slice at the end of the implementation run. Independent review happens while the plan still identifies the implemented slice as the review target.

## Diff-to-slice mapping

Map changes by behavior first, filenames second.

Examples:

- Prisma evidence tables / request schemas / interface contracts → persistence/contracts slice.
- Pause + Reactivate repository/service/routes → lifecycle-command slice.
- Active→Active complete replacement → update slice.
- Active final-audio removal / PendingCleanup / pause consequence → audio lifecycle slice.
- readiness derivation / legacy inventory → grandfathering slice.
- editor state machines / dialogs / responsive/E2E → UI/integration slice.

Expected-file lists in the plan are guidance, not permission to ignore behavior.

If a file legitimately belongs to multiple slices, classify by behavior introduced in the diff.

## Cross-slice compatibility check

Before selecting/implementing the next slice, confirm the prior foundation does not make later work impossible.

Examples:

- Pause evidence must support later final-sample auto-pause without fabricating activation attestation.
- Reactivate contracts must carry a complete repaired state.
- Active update must have durable retry convergence if the issue requires it.
- Audio cleanup must preserve established lock ordering.
- Grandfather derivation must reuse current activation/readiness rules rather than invent a second definition.
- UI must consume real backend semantics rather than simulate future behavior.

If an earlier slice creates a contradiction, STOP rather than building around it.

## Handling slice-plan drift

If current code shows that a planned slice was already implemented incidentally by an earlier approved slice:

- verify behavior and tests;
- classify it COMPLETE in reasoning;
- do not reimplement it;
- select the next unmet slice.

If the plan assigns behavior to a later slice but current uncommitted code implements it prematurely:

- treat it as scope drift;
- STOP unless that behavior is strictly required by the current slice.

Do not normalize accidental scope expansion merely because code already exists.

## Review handoff

After implementation:

- do not commit;
- do not push;
- keep `CURRENT REVIEW TARGET` on the implemented slice;
- report deferred slices explicitly;
- leave the worktree ready for independent reviewer inspection.

The independent review skill should use the same tracked slice plan and current review target.
