---
name: review-branch
description: >
  Read-only review of the current branch against its ticket and authoritative
  specifications. Reviews scope, correctness, security, persistence, tests,
  regressions, and targeted UI behavior without modifying repository files.
---

# Review Branch

Review the current branch against its ticket and report only actionable findings.

This is a read-only review.

The goal is not to improve everything in the repository. The goal is to determine whether the current branch correctly satisfies the authority granted by its ticket.

## Slice-aware issue reviews

Before performing the issue-completeness review, check whether the repository contains:

`docs/specs/issue-<ISSUE_NUMBER>-implementation-slices.md`

If no slice-plan document exists, continue with the normal full-issue review.

If a slice-plan document exists:

1. Read the GitHub issue first. It remains the authoritative overall contract.
2. Read the implementation-slice document fully.
3. Identify its `CURRENT REVIEW TARGET`.
4. Read `references/slice-aware-review.md`.
5. Apply those slice-aware review rules before evaluating issue completeness.

Do not report a future-slice requirement as missing merely because it is intentionally deferred.

A current-slice implementation is still blocking if it contradicts the overall issue, violates a cross-slice invariant, prematurely exposes incomplete future behavior, or makes a later slice impossible or unsafe.

The final full-branch review must evaluate the entire GitHub issue after all slices are complete.

## Non-negotiable rules

- Do not modify, create, delete, rename, format, or rewrite tracked files.
- Do not fix findings.
- Do not update snapshots, fixtures, baselines, lockfiles, schemas, or migrations.
- Do not switch branches.
- Do not reset, stash, commit, amend, cherry-pick, rebase, merge, or push.
- Do not install or upgrade dependencies.
- Do not use mutation flags such as `--write`, `--fix`, `--update`, snapshot-update flags, or migration-generation flags.
- Do not intentionally alter tracked repository state.
- Do not explore unrelated repository areas.
- Do not expand ticket scope because a reviewer, nearby file, or discovered defect suggests more work.
- Do not treat pre-existing base-branch defects as blockers unless this branch worsens them.
- Capture `git status --short` before and after verification.
- If a verification command changes tracked files, stop and report it.

Generated ignored build/test artifacts are allowed when produced by normal project commands.

## Authority

Authority order:

1. Current ticket or issue.
2. Specifications explicitly referenced by that ticket.
3. Repository contracts needed to interpret those specifications.
4. Current implementation and tests.

Reviewer comments, prior findings, nearby bugs, future-ticket requirements, and architectural preferences do not expand ticket authority.

A reviewer finding cannot override an explicit ticket non-goal.

## Finding classification

Every finding must have both a classification and a severity.

### Classification

- `BLOCKING <ticket>`
- `NON-BLOCKING / FOLLOW-UP`
- `NOT APPLICABLE`

### Severity

- Critical
- High
- Medium
- Low

Severity does not determine scope.

Examples:

- `BLOCKING #84 — Medium`
- `NON-BLOCKING / FOLLOW-UP — High`
- `NOT APPLICABLE — Medium`

## Reviewability preflight

Before reviewing ticket compliance, confirm there is a valid review target.

Return:

`NOT_REVIEWABLE`

and stop the review when any of the following is true:

- `HEAD` equals the requested base and the review diff is empty;
- the user requested a specific ticket but the current branch clearly contains no implementation for it;
- the requested comparison range cannot be established;
- the ticket cannot be identified when ticket compliance was explicitly requested.

A missing or incorrect review target is not a ticket defect.

Do not classify "no implementation present" as a `BLOCKING <ticket>` finding.

Report:

- requested ticket
- current branch
- base
- head
- why the target is not reviewable
- the minimal action needed to establish a valid review target

Do not continue into implementation, test, or visual review once the target is
classified `NOT_REVIEWABLE`.

## Approval rule

Return:

`APPROVED`

when a valid review target exists and there are no `BLOCKING <ticket>` findings.

Return:

`CHANGES_REQUESTED`

when a valid review target exists and at least one blocking finding exists.

Return:

`NOT_REVIEWABLE`

when a valid ticket/diff review target cannot be established.

Follow-up findings do not prevent approval.

## Context discipline

Review the branch as it exists now.

Use this order:

1. Current ticket.
2. Authoritative specs.
3. Current diff.
4. Current tests.
5. Relevant dependencies.

Do not read historical review conversations by default.

Read previous review feedback only when:

- explicitly asked to re-review it;
- unresolved findings must be verified; or
- current code cannot be understood without it.

Do not re-litigate findings absent from current HEAD.

## Review workflow

First establish repository state with read-only commands:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -1 --oneline
```

Prefer reviewing against the remote-tracking default branch when available:

```bash
git diff origin/<default-branch>...HEAD --stat
git diff origin/<default-branch>...HEAD --name-status
git diff origin/<default-branch>...HEAD
```

Do not fetch automatically unless explicitly permitted.

Then:

1. Identify the ticket.
2. Read its acceptance criteria and referenced authoritative specs.
3. Establish goals, non-goals, invariants, and later-ticket boundaries.
4. Review only the branch diff and relevant dependencies.
5. Review changed tests alongside production code.
6. Run the narrowest relevant checks.
7. Perform targeted UI review only when the ticket materially changes UI.
8. Compare final `git status --short` with the initial state.
9. Return a scoped verdict.

For the detailed review procedure, read:

`references/review-procedure.md`

Only when the ticket materially changes UI, also read:

`references/ui-review.md`

Only when the user explicitly states there is a release, demo, launch, or deadline constraint, also read:

`references/release-mode.md`

## Finding standard

Report only actionable findings supported by current HEAD.

Each finding must include:

- Classification.
- Severity.
- Title.
- File and line, test, route, or UI state.
- Concrete triggering path.
- What is wrong.
- Why it matters.
- Minimal remediation direction.
- Verification that would prove the fix, when appropriate.

Do not report:

- subjective style preferences;
- speculative issues without a plausible trigger;
- unrelated defects;
- already-fixed findings;
- duplicate findings;
- theoretical architecture concerns with no ticket impact;
- behavior owned exclusively by later tickets; or
- base-branch defects the feature did not worsen.

## Final response

Use this structure.

### Verdict

`APPROVED`

or

`CHANGES_REQUESTED`

Include one sentence explaining why.

### Scope reviewed

- Ticket
- Branch
- Base
- Head
- Main areas reviewed

### Blocking findings

List only `BLOCKING <ticket>` findings.

If none:

`No blocking findings.`

### Non-blocking / follow-up

List only meaningful follow-ups.

If none:

`No material follow-up findings.`

### Not applicable

Include only when useful for explaining scope boundaries.

### Verification

Format each command as:

```text
<command> — PASS
<command> — FAIL: <brief cause>
<command> — NOT RUN: <reason>
```

Distinguish failures as:

- branch-caused;
- pre-existing;
- flaky;
- environment-related; or
- cannot determine.

### Coverage gaps

Mention only meaningful limitations.

## Core principle

Review the branch that exists.

Review it against the authority it was given.

Find real defects.

Prove findings with evidence.

Do not turn discovery into scope expansion.

Approve when the ticket is correctly complete.
