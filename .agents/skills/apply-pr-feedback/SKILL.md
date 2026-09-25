---
name: apply-pr-feedback
description: >
  Pull the current pull request's latest reviewer feedback and failed checks from GitHub,
  verify each finding against the current branch and ticket authority, apply only justified
  blocking fixes, run focused verification, and report deferred follow-up work.
---

# Apply PR Feedback

Apply review feedback to the current feature branch without turning review discovery into scope expansion.

This skill is for the implementation agent after a pull request has received review feedback.

## Core principle

Reviewer feedback is evidence, not authority.

The current ticket and its explicitly referenced specifications define scope.

A reviewer may discover a real bug that belongs to another ticket. That bug should be preserved as follow-up work, not automatically implemented in the current branch.

## Non-negotiable rules

- Work only on the current feature branch.
- Do not switch branches.
- Do not merge, rebase, reset, stash, or force-push.
- Do not broaden ticket scope because a reviewer found an unrelated problem.
- Do not apply findings blindly.
- Verify every finding against current HEAD before modifying code.
- Do not fix findings already resolved in current HEAD.
- Do not revive findings from superseded commits unless they still reproduce.
- Do not modify code owned exclusively by a later ticket unless required to satisfy the current ticket.
- Do not turn style preferences, refactors, or cleanup into blockers.
- Do not commit or push unless the user explicitly requests it.
- Do not update snapshots or baselines merely to make tests pass.
- Do not increase timeouts to hide failures.
- Do not suppress security tooling unless the alert has been verified as non-applicable and suppression is explicitly authorized.

## Authority order

Use this order when findings conflict:

1. Current ticket / issue
2. Specifications explicitly referenced by the ticket
3. Repository contracts and invariants needed to interpret the ticket
4. Current implementation and tests
5. Reviewer findings
6. Reviewer remediation suggestions

Reviewer remediation suggestions are not automatically the correct fix.

## Preflight

Before reading or applying feedback, establish the current state.

Run:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -1 --oneline
```

The working tree should normally be clean before starting.

If unrelated local modifications exist, do not overwrite them. Report them and continue only when the requested review work can be safely isolated.

## Step 1: Identify the current PR

Use the current branch to find its pull request.

Prefer GitHub CLI when available:

```bash
gh pr view --json number,title,url,headRefName,baseRefName,headRefOid,body
```

If no PR exists, stop and report:

`NO_PULL_REQUEST`

Do not invent a PR number.

Record:

- PR number
- ticket identifier
- base branch
- current HEAD SHA
- PR head SHA

If the local HEAD and PR head differ, state that clearly before applying feedback.

## Step 2: Identify ticket authority

Determine the owning ticket from:

1. PR body/title
2. Branch name
3. Explicit user instruction
4. Commit messages

Read the ticket and the specifications it explicitly references.

Create a private scope summary:

- goals
- acceptance criteria
- non-goals
- persistence invariants
- authorization boundaries
- concurrency requirements
- user-visible requirements
- later-ticket boundaries

Do not expand this scope from reviewer comments.

## Step 3: Pull current GitHub feedback

Pull the latest review state from GitHub.

At minimum inspect:

```bash
gh pr view --comments
gh api repos/{owner}/{repo}/pulls/{pr}/reviews --paginate
gh api repos/{owner}/{repo}/pulls/{pr}/comments --paginate
gh pr checks
```

When useful, inspect failing workflow details with GitHub CLI.

Prefer the latest review/comments associated with the current PR head.

Do not spend time reconstructing the full historical review conversation unless needed to understand an unresolved current finding.

### Reviewer priority

Treat findings from all reviewers as inputs.

When Tenki is present:

- collect the latest Tenki summary;
- collect Tenki inline review comments;
- deduplicate repeated findings;
- ignore findings already fixed in current HEAD.

Also collect current required-check failures because a failing build, test, lint, type-check, or CodeQL check may require action even when it is not described in reviewer prose.

## Step 4: Classify every finding

Every current finding must receive one classification:

- `BLOCKING <ticket>`
- `NON-BLOCKING / FOLLOW-UP`
- `NOT APPLICABLE`
- `ALREADY RESOLVED`
- `PRE-EXISTING / OUT OF SCOPE`

Also assign severity when useful:

- Critical
- High
- Medium
- Low

### BLOCKING <ticket>

Use only when the finding is substantiated and affects one or more of:

- explicit acceptance criteria
- in-scope functional correctness
- authorization
- security introduced or worsened by the branch
- data integrity
- persistence invariants
- required atomicity/concurrency behavior
- required build
- required demo/user happy path
- branch-introduced regression

### NON-BLOCKING / FOLLOW-UP

Use for real issues that do not block the current ticket, including:

- refactors
- duplication
- test architecture improvements
- cosmetic polish
- unrelated hardening
- future-ticket behavior
- non-critical robustness improvements outside the required path

### NOT APPLICABLE

Use when the reviewer is asking for behavior explicitly outside the ticket's authority or contrary to the current specification.

### ALREADY RESOLVED

Use when the finding does not reproduce on current HEAD.

### PRE-EXISTING / OUT OF SCOPE

Use when:

- the same defect exists on the base branch; and
- the feature branch does not worsen it; and
- the current ticket does not own remediation.

Do not modify the current branch merely to make such a failure disappear.

## Step 5: Verify findings before changing code

For each potential blocker:

1. Inspect the cited code on current HEAD.
2. Reproduce or reason through the concrete trigger.
3. Check relevant tests.
4. Check the ticket/spec requirement.
5. Decide whether the reviewer diagnosis is correct.
6. Decide whether the suggested remediation is appropriate.

A reviewer can identify the right bug and still suggest the wrong fix.

Do not change code until this verification is complete.

## Step 6: Apply only justified blocking fixes

Fix only findings classified `BLOCKING <ticket>`.

Prefer:

- the smallest correct change;
- existing repository patterns;
- existing abstractions;
- behavioral fixes over test weakening;
- root-cause fixes over timeout/retry padding;
- existing transaction/retry/routing helpers over new frameworks.

Do not:

- introduce unrelated abstractions;
- refactor nearby code "while here";
- absorb later-ticket behavior;
- upgrade dependencies unless required for the blocker;
- rewrite tests solely to silence reviewers;
- weaken assertions to make failures disappear.

If a blocker cannot be fixed without an owner/product decision, stop and classify it:

`OWNER_DECISION_REQUIRED`

Explain the conflicting authorities or options.

## Step 7: Focused verification

After changes, run the narrowest relevant tests first.

Examples:

- changed unit/component tests
- affected service tests
- affected repository tests
- concurrency/transaction tests when the fix changes those guarantees
- targeted Playwright when the fix changes a user-visible/demo flow

Then run the repository gates defined in `AGENTS.md`.

For SoundHub, these commonly include:

```bash
pnpm check:fast
pnpm build
```

Run `pnpm test:repository` only when persistence, repositories, transactions, or concurrency are affected, or when the ticket explicitly requires it.

Run only relevant Playwright specs unless broad browser coverage is justified.

Do not increase test timeouts to make failures pass.

## Step 8: Classify verification failures

When a check fails, determine whether it is:

- `BRANCH-CAUSED`
- `PRE-EXISTING`
- `FLAKY`
- `ENVIRONMENT`
- `CANNOT DETERMINE`

Do not automatically fix every failing check.

If a required check fails because of an unchanged, pre-existing, out-of-scope test or defect, report it clearly and do not broaden the ticket unless the user explicitly authorizes that work.

## Step 9: Preserve follow-up work

Do not silently discard legitimate non-blocking findings.

Report meaningful deferred items with:

- finding title
- classification
- owning area/ticket when known
- one-sentence reason for deferral

Do not implement them in the current branch.

## Step 10: Final repository check

Run:

```bash
git status --short
git diff --check
```

Report all modified files.

Do not commit or push unless explicitly instructed.

## Release / demo mode

When the user explicitly states that the project is under a release, launch, demo, or deadline constraint, apply a stricter stop rule.

Fix now only:

- unmet ticket acceptance criteria
- in-scope correctness bugs
- credible branch-introduced security/auth defects
- data-integrity/persistence violations
- required build failures
- broken required demo happy path

Normally defer:

- refactoring
- duplication
- cosmetic polish
- test-implementation cleanup
- documentation polish
- unrelated hardening
- pre-existing bugs
- future-ticket work

Once required behavior and gates are green, stop.

Do not continue creating implementation loops for follow-up findings.

## Final response

Use this structure.

### Review intake

- PR
- Ticket
- Branch
- Base
- Reviewed HEAD
- Reviewers/checks consulted

### Blocking findings applied

For each:

- Finding
- Classification / severity
- Verification
- Root cause
- Files changed
- Fix
- Tests run

If none:

`No justified blocking findings required code changes.`

### Deferred findings

List only meaningful:

- `NON-BLOCKING / FOLLOW-UP`
- `NOT APPLICABLE`
- `PRE-EXISTING / OUT OF SCOPE`

### Verification

```text
<focused command> — PASS/FAIL
pnpm check:fast — PASS/FAIL/NOT RUN
pnpm build — PASS/FAIL/NOT RUN
<relevant repository/Playwright command> — PASS/FAIL/NOT RUN
git diff --check — PASS/FAIL
```

### Repository state

- files modified
- working tree state
- commit/push state

### Final state

Use exactly one:

- `READY FOR REVIEW`
- `BLOCKED — OWNER DECISION REQUIRED`
- `BLOCKED — REQUIRED CHECK FAILURE`
- `NO ACTIONABLE CURRENT FEEDBACK`

## Core principle

Pull the current review.

Verify it against current HEAD.

Respect ticket authority.

Fix real blockers.

Preserve follow-ups.

Stop when the branch is ready for independent review.
