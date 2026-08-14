---
name: review-handoff
description: Serialize the completed SoundHub code review into .reviews/feedback.md for the Claude Code implementation engineer. Use together with the code-review skill after reviewing a feature branch.
---

# Review Handoff

This skill does NOT perform the engineering review.

Use the installed `code-review` skill as the authoritative review
procedure.

This skill's only responsibility is to convert the completed review
result into the file-based handoff consumed by Claude Code's
`/apply-review` skill.

## Preconditions

Before writing feedback:

1. A code review must have been completed for the current feature branch.
2. The review must evaluate the complete branch diff against the
   appropriate base branch.
3. The ticket requirements, project instructions, specs, contracts,
   plans, and accepted ADRs must have been considered by the review.
4. Resolve:
   - repository root
   - current branch
   - ticket number and title
   - base ref and SHA
   - current HEAD SHA

Do not invent additional findings during serialization.

## Severity Mapping

Convert the final code-review findings into:

- P0 Critical
- P1 High
- P2 Minor

Use:

### P0 Critical

For findings involving:

- destructive data/database/infrastructure risk
- security or privacy exposure
- corrupted money/state/identity
- total failure of a required acceptance criterion
- implementation that is unsafe to merge

### P1 High

For:

- correctness defects
- violated domain/API contracts
- silently ignored required behavior
- broken integration/error/concurrency behavior
- missing evidence for required acceptance criteria
- material architecture violations

### P2 Minor

For:

- scoped maintainability issues
- branch-introduced hygiene problems
- low-risk missing edge cases
- minor issues clearly worth fixing before merge

Do not convert general suggestions, stylistic preferences, or
out-of-scope improvements into blocking findings.

## Output

Create `.reviews/` if necessary.

Overwrite:

`.reviews/feedback.md`

Use exactly this structure:

# Codex Review Feedback

- Ticket: #<number> — <title>
- Branch: <branch>
- Base: <base-ref> @ <base-sha>
- Reviewed head: <head-sha>
- Verdict: CHANGES_REQUESTED | APPROVED

## P0 Critical

### P0-001 — <title>

- File: `path/to/file:<line>`
- Requirement: <requirement violated>
- Problem: <concrete issue>
- Evidence: <review evidence>
- Remediation: <specific direction>
- Verification: <how to prove the fix>

If none:

None.

## P1 High

Use the same finding structure.

If none:

None.

## P2 Minor

Use the same finding structure.

If none:

None.

## Acceptance Criteria

| Criterion   | Result                   | Evidence   |
| ----------- | ------------------------ | ---------- |
| <criterion> | PASS / FAIL / NOT PROVEN | <evidence> |

## Validation

- `<command>` — PASS / FAIL / NOT RUN — <result>

## Reviewer Summary

- P0: <count>
- P1: <count>
- P2: <count>
- Final verdict: APPROVED | CHANGES_REQUESTED

## Rules

- Preserve the substance of the code-review findings.
- Do not weaken severity merely to produce an approval.
- Do not add new findings that were not part of the completed review.
- Do not modify application code.
- Do not commit.
- Do not push.
- Do not modify any workspace file except `.reviews/feedback.md`.

If the review is APPROVED:

- Write `Verdict: APPROVED`.
- Write `None.` under P0, P1, and P2.
- Preserve the acceptance-criteria and validation evidence.

Finally report:

`Saved review for <HEAD SHA> to .reviews/feedback.md`
