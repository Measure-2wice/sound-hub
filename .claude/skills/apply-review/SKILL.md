---
name: apply-review
description: Apply structured Codex review feedback from .reviews/feedback.md on the active feature branch, validate the fixes, commit them locally, and reset the feedback file. Invoke manually after Codex completes a review.
disable-model-invocation: true
---

# Apply Codex Review Feedback

Apply the current review in `.reviews/feedback.md` to the active feature branch.

## Safety and scope

- Work only on the current feature branch. Never apply review fixes on `main` or `master`.
- Treat committed project instructions and ticket artifacts as authoritative: `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, accepted ADRs, contracts, specs, plans, and the current ticket.
- Do not broaden scope merely to satisfy a reviewer preference.
- Do not push, create a PR, merge, or rewrite history.
- Preserve unrelated tracked/untracked work.
- Never run destructive database, infrastructure, or filesystem commands unless the repository explicitly provides an approved fail-closed workflow for that operation.
- Do not clear the feedback file until every finding is resolved and the fix commit succeeds.

## 1. Preflight

1. Resolve the repository root with `git rev-parse --show-toplevel` and work from that directory.
2. Read the current branch with `git branch --show-current`.
3. Stop if the branch is `main`, `master`, empty/detached, or otherwise not the intended feature branch.
4. Require `.reviews/feedback.md` to exist and contain non-whitespace content. If it is missing or empty, report `NO REVIEW FEEDBACK` and stop.
5. Read `.reviews/feedback.md` completely.
6. Read the repository instructions and the ticket/spec artifacts referenced by the review.
7. Read the review metadata:
   - `Base`
   - `Reviewed head`
   - `Ticket`
   - `Verdict`
8. Compare `Reviewed head` with `git rev-parse HEAD`.
   - If they differ, stop with `STALE REVIEW` and do not edit code. A new Codex review is required for the current HEAD.
9. Record `git status --short` before editing so unrelated pre-existing changes can be preserved.

## 2. Parse and triage findings

Parse findings only from these sections:

- `## P0 Critical`
- `## P1 High`
- `## P2 Minor`

Each finding should have an ID such as `P0-001`, `P1-002`, or `P2-003`.

Process in severity order: P0, then P1, then P2.

For each finding, classify it before editing:

- `APPLY` — supported by the ticket or authoritative project documents.
- `DISPUTE WITH EVIDENCE` — conflicts with an authoritative requirement or is factually incorrect.
- `BLOCKED` — cannot be resolved safely without a product/architecture decision or missing prerequisite.

Rules:

- Never silently reinterpret architecture to satisfy feedback.
- Never discard a finding without recording why.
- P0 and P1 findings must be resolved, disputed with concrete evidence, or reported blocked.
- Apply P2 findings when they are in scope and low risk. If a P2 item is scope-expanding or purely preference-based, dispute/defer it with evidence rather than creating unrelated work.
- If any finding is `BLOCKED`, stop before committing and preserve `.reviews/feedback.md`.

## 3. Implement fixes

For each `APPLY` finding:

1. Inspect the referenced code and surrounding behavior.
2. Add or strengthen a regression test first when practical.
3. Make the smallest change that resolves the finding.
4. Run the narrowest relevant test/check immediately.
5. Re-read the finding and confirm the remediation is actually satisfied.
6. Do not modify unrelated files or perform opportunistic refactors.

Keep a working resolution table:

| Finding | Status | Evidence |
|---|---|---|
| P0-001 | FIXED / DISPUTED / BLOCKED | file, test, or authoritative source |

## 4. Validate the branch

Determine the project's validation commands from repository instructions and existing package/build configuration. Do not invent a new toolchain.

Run, as applicable:

1. Focused tests for changed behavior.
2. Unit tests.
3. Integration tests.
4. Type checking/static analysis.
5. Linting.
6. Build checks.
7. Formatting checks for branch-introduced changes.
8. End-to-end/runtime checks required by the ticket.

Examples such as `npm test`, `pnpm test`, `pytest`, `cargo test`, or `go test` are examples only; use this repository's actual commands.

If a repository-wide check fails only because of verified pre-existing baseline drift, report that separately. Do not modify unrelated baseline files just to make the global check green.

Before committing:

- Run `git diff --check`.
- Run `git status --short`.
- Inspect `git diff --stat` and `git diff`.
- Confirm no secrets, generated artifacts, test output, or unrelated files are included.

If any branch-introduced required validation fails, do not commit and do not clear feedback.

## 5. Commit review fixes

Only when:

- every P0/P1 finding is FIXED or DISPUTED WITH EVIDENCE,
- every applicable P2 finding is handled,
- there are no BLOCKED findings,
- required validation passes,
- the diff contains only intended review fixes.

Create a local commit:

`fix: address codex review feedback`

Do not amend or squash previous commits unless the user explicitly requests it.
Do not push or create a PR.

After committing, capture:

- commit SHA
- `git status --short`
- validation results
- finding-resolution table

## 6. Reset the handoff file

Only after the fix commit succeeds and no findings remain unresolved:

1. Empty `.reviews/feedback.md`.
2. Do not commit `.reviews/feedback.md`.
3. Confirm the file exists and is empty.
4. Report `READY FOR CODEX RE-REVIEW`.

If findings remain disputed or blocked, do **not** clear the file. Update the report in the conversation with the unresolved finding IDs and evidence instead.

## Final response

Return:

- feature branch
- fix commit SHA
- P0/P1/P2 resolution table
- tests/checks run and results
- unresolved items, if any
- `.reviews/feedback.md` status
- one final state:
  - `READY FOR CODEX RE-REVIEW`
  - `BLOCKED`
  - `STALE REVIEW`
