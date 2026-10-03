---
name: implement-next-slice
description: Implement the next bounded slice of a GitHub ticket from a tracked implementation-slice plan. Dynamically discovers the issue, slice plan, repository state, completed slices, current diff, and next eligible slice; implements only that slice; verifies it; and leaves the work uncommitted for independent review.
---

# Implement Next Slice

Implement the next eligible bounded slice for the current GitHub ticket.

This skill is for tickets intentionally delivered through a tracked slice plan such as:

`docs/specs/issue-<NUMBER>-implementation-slices.md`

The GitHub issue and authoritative product/domain specs remain the source of truth. The slice document controls sequencing and review boundaries only.

Do not require the user to manually paste or edit a per-slice implementation prompt.

## Core behavior

When invoked:

1. discover the current issue;
2. discover and read the tracked slice plan;
3. inspect the branch, HEAD, worktree, staged changes, and diff;
4. classify slices as complete, in progress, not started, or blocked;
5. resolve the next eligible slice from the plan and dependency graph;
6. update `CURRENT REVIEW TARGET` only when advancing is unambiguous;
7. implement only that slice;
8. run the slice's required verification;
9. leave all implementation changes uncommitted and unpushed;
10. produce a bounded handoff for independent review.

Before resolving a slice, read `references/slice-resolution.md`.

## Authority order

Use this precedence:

```text
GitHub issue + authoritative specs / ADRs
    ↓
tracked implementation-slice plan
    ↓
current repository implementation and tests
    ↓
current working-tree diff
```

The slice plan may control _when_ work is implemented. It may not weaken or contradict the issue/specs.

If the slice plan conflicts with the issue or authoritative specs, STOP before changing code.

## 1. Establish repository state

Inspect at least:

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short
git log --oneline -8
git diff --stat
git diff --cached --stat
```

Determine:

- repository root;
- current branch;
- whether the worktree is clean;
- whether there are staged changes;
- recent slice/checkpoint commits;
- whether uncommitted work already exists.

Never discard, reset, stash, clean, or overwrite existing work automatically.

If unrelated uncommitted changes cannot be safely separated from the ticket, STOP.

## 2. Resolve the GitHub issue

Resolve the issue number in this order:

1. explicit issue number supplied by the invocation/user;
2. issue number encoded unambiguously in the current branch name;
3. issue number referenced by the matching tracked slice-plan filename;
4. current PR metadata, if available.

Do not guess between multiple candidates. If ambiguous, STOP and ask for the issue number.

Read the GitHub issue in full before implementation.

## 3. Discover the slice plan

Prefer:

`docs/specs/issue-<ISSUE_NUMBER>-implementation-slices.md`

If absent, search tracked repository docs for an issue-specific implementation-slice plan.

Do not infer a plan from model memory, chat history, or branch names.

If no tracked slice plan exists, do not invent slices; fall back to the repository's normal ticket implementation workflow and report that slice-aware implementation is not applicable.

Read the entire plan and extract:

- slice order;
- dependency graph;
- `CURRENT REVIEW TARGET`;
- cross-slice invariants;
- scope;
- explicit non-goals;
- expected files;
- acceptance criteria;
- required tests;
- verification commands;
- review gate for every slice.

## 4. Resolve the actual current/next slice

Follow `references/slice-resolution.md`.

Do not blindly trust `CURRENT REVIEW TARGET` if repository evidence shows it is already fully implemented and committed.

Do not blindly advance because the worktree is clean.

Use:

- slice acceptance criteria;
- current implementation;
- tests;
- recent commits;
- dependency completion;
- current diff.

Classify each slice as:

- `COMPLETE`
- `IN_PROGRESS`
- `NOT_STARTED`
- `BLOCKED`

### If uncommitted changes exist

Map them to the slice plan.

If they clearly belong to one slice, that slice is `IN_PROGRESS`; continue only that slice.

If they span multiple slices, STOP and report scope leakage.

If they belong to a future slice while an earlier dependency is incomplete, STOP.

### If the worktree is clean

Evaluate slices in dependency order.

The next slice is the first slice whose dependencies are complete and whose acceptance criteria are not already satisfied by committed HEAD.

If `CURRENT REVIEW TARGET` is already fully implemented in committed HEAD and the next eligible slice is unambiguous:

1. update only the `CURRENT REVIEW TARGET` marker;
2. format the slice-plan document;
3. proceed with the next slice.

Do not advance if the prior slice appears partial, ambiguous, or uncommitted.

If all slices are complete, STOP with:

`READY FOR FINAL ISSUE REVIEW`

## 5. Pre-implementation audit

Before coding, determine:

- resolved issue;
- resolved slice;
- why it is the correct next slice;
- satisfied dependencies;
- expected files;
- acceptance criteria;
- explicit non-goals;
- completed slices that must not regress.

Inspect the current implementation and relevant tests.

If repository reality materially conflicts with the slice plan, STOP rather than improvising architecture.

## 6. Implement only the resolved slice

Do not opportunistically implement future slices.

Do not add temporary public/runtime surfaces for later slices.

Prohibited premature behavior includes:

- fake routes returning `501 Not Implemented`;
- repository/service methods whose only behavior is `not_implemented_yet`;
- UI controls for commands whose backend contract is not implemented;
- persistence fields intended only for a later slice.

Preserve all previously approved behavior and cross-slice invariants, including authorization, privacy, lifecycle, idempotency, lock ordering, atomicity, DTO allow-listing, and regression coverage.

## Test naming

Long-lived tests describe durable domain behavior.

Do not use project-management labels in new test filenames, `describe` blocks, or test titles, including:

- milestone numbers;
- GitHub issue numbers;
- slice identifiers;
- phase numbers.

Bad:

```text
m2-86-slice-86b.test.ts
#86 pause tests
slice 86C update contract
```

Good:

```text
service-offering-pause.test.ts
service-offering-reactivation.test.ts
active-service-offering-update.test.ts
final-sample-removal.test.ts
```

The slice-plan document is the correct place for issue/slice sequencing terminology.

## 7. Verification

Run every command required by the resolved slice plan.

Also run normal repository gates appropriate to the changed surfaces.

Unless the slice requires stricter verification, run at minimum:

```bash
pnpm format:check
pnpm lint
pnpm type-check
pnpm check:fast
pnpm build
git diff --check
```

Run `pnpm test:repository` whenever repository/database behavior changes.

Run focused tests for the current slice directly so their output is visible.

Do not weaken or remove tests to make gates pass.

If an apparently unrelated test fails:

1. rerun the exact failure in isolation;
2. reproduce before classifying it as pre-existing/flaky;
3. do not modify unrelated behavior without evidence.

## 8. Review boundary

Do not commit.
Do not push.

Leave the completed slice as an uncommitted diff for independent review.

Do not advance `CURRENT REVIEW TARGET` to the _following_ slice at the end of implementation.

The target remains the slice just implemented until it has been reviewed, accepted, and committed.

On the next invocation, if that slice is fully present in committed HEAD and the worktree is clean, this skill may resolve and advance to the next eligible slice.

## Final report

Report:

1. GitHub issue
2. slice plan path
3. resolved implementation slice
4. why it was selected
5. previously completed slices preserved
6. files changed
7. behavior implemented
8. explicit future work deferred
9. tests added/updated
10. focused test results
11. required gate results
12. `git diff --check`
13. `git status --short`
14. any concern affecting a later slice

End with:

`READY FOR CODEX REVIEW — <SLICE_ID>`

If all slices are complete, end with:

`READY FOR FINAL ISSUE REVIEW`

If the skill cannot safely resolve a slice, end with:

`STOPPED — SLICE RESOLUTION REQUIRED`
