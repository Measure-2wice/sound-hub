---
name: ralph-milestone-refiner
description: Refine every open implementation ticket in a Ralph milestone, apply Ralph execution-routing labels, and report whether the milestone is ready for autonomous execution.
---

# Ralph Milestone Refiner

Prepare a shaped Ralph milestone for unattended `ralph --milestone`
execution by evaluating every open implementation ticket against the
project's refinement policy, applying deterministic routing labels,
and producing a single milestone-level readiness report.

This skill is NOT an implementation coding agent.

Do not implement code, run Ralph, mutate ticket requirements, close
issues, or create child tickets.

## Delegation

The installed `ralph-ticket-refiner` skill is the authoritative
single-ticket evaluator. This skill is a thin batch coordinator
around it.

Do not duplicate refinement policy. Do not invent a second readiness
policy. Every per-ticket verdict, acceptance-criterion disposition,
implementation boundary, validation strategy, risk, and proposed
decomposition must come from `ralph-ticket-refiner`.

## Goal

Determine whether the WHOLE milestone is ready to be handed to
`ralph --milestone` for unattended execution.

Read `.ralph/refinement/policy.json` completely. If it is missing or
unreadable, stop and report that evaluation is blocked.

## Required Authorities

Before evaluating any ticket, resolve:

1. The full refinement policy at `.ralph/refinement/policy.json`.
2. The Ralph configuration for the requested milestone from
   `.ralph/config/<milestone>.json` or whichever file the project's
   Ralph configuration convention uses.
3. From that configuration:
   - GitHub repository
   - GitHub milestone
   - integration branch and baseline
   - parent or specification issue
   - required Ralph label
   - skip labels
4. The CURRENT set of milestone issues from GitHub.
5. The configured integration branch as the implementation baseline.

Do not default to `main` when the Ralph integration branch contains
integrated predecessor work not yet on `main`.

If multiple Ralph configurations match ambiguously, stop and ask the
human.

If no refinement policy is available, stop.

## Ticket Set

Evaluate every OPEN implementation ticket belonging to the requested
milestone.

Exclude:

- closed issues
- the configured parent or specification issue
- pull requests
- non-implementation tracking issues that are clearly identifiable as
  such

Do not skip a ticket merely because its execution dependency is still
open. Example:

`#19 Blocked by #18`

is still refinable. The question is whether `#19` will be
autonomously executable AFTER `#18` completes, not whether `#18` is
already merged.

## Single-Ticket Primitive

For each ticket in the ticket set, invoke `ralph-ticket-refiner` as
the authoritative evaluator.

Capture from its output:

- exactly one verdict:

      RALPH_READY
      RESHAPE_REQUIRED
      ALREADY_SATISFIED
      SUPERVISED_REQUIRED

- the acceptance-criterion dispositions
- the implementation boundary
- the validation strategy
- the risks
- the proposed decomposition when required

Continue evaluating all remaining milestone tickets regardless of a
non-ready verdict. A single `RESHAPE_REQUIRED` or
`SUPERVISED_REQUIRED` verdict must not stop the batch.

## Label Routing

Unless the user explicitly requests read-only mode, apply routing
labels after each conclusive verdict using these deterministic rules.

| Verdict             | Add                | Remove                          | Issue body |
| ------------------- | ------------------ | ------------------------------- | ---------- |
| `RALPH_READY`       | `ready-for-ralph`  | `needs-reshaping`, `supervised-agent` | unchanged |
| `RESHAPE_REQUIRED`  | `needs-reshaping`  | `ready-for-ralph`, `supervised-agent` | unchanged |
| `SUPERVISED_REQUIRED` | `supervised-agent` | `ready-for-ralph`, `needs-reshaping` | unchanged |
| `ALREADY_SATISFIED` | —                  | `ready-for-ralph`, `needs-reshaping`, `supervised-agent` | unchanged |

For `ALREADY_SATISFIED`, do NOT close the issue. Report it under
`HUMAN CONFIRMATION REQUIRED` because closing an issue is a stronger
project-management action than routing it for Ralph.

Use only these labels. Never invent additional labels.

If a configured label does not exist on the repository, report the
failure and continue evaluating other tickets where safe. Do not
auto-create routing labels.

If a GitHub label mutation fails, report the failure and continue
evaluating other tickets where safe.

## Read-Only Mode

If the user explicitly says:

- `read-only`
- `evaluate only`
- `don't modify GitHub`

then:

- perform all evaluations
- apply NO labels
- make NO GitHub mutations
- still produce the complete readiness report

Default milestone preparation mode MAY apply the routing labels
above.

## Idempotency

Label routing must be idempotent.

Running this skill repeatedly must not:

- duplicate labels
- rewrite ticket bodies
- create duplicate issues
- change already-correct routing labels unnecessarily

The current GitHub issue is authoritative on every run. Do not rely
on the previous refinement report.

## Dependencies

For every ticket:

- read its current `Blocked by` references
- verify referenced issues exist
- distinguish dependency correctness from readiness

Do not mark a ticket `SUPERVISED_REQUIRED` merely because its
predecessor has not yet executed.

However, surface prominently in the milestone report:

- malformed dependency references
- dependency cycles
- missing referenced tickets
- architecture contradictions between a ticket and its predecessor

A dependency problem that prevents Ralph from obtaining a safe
execution frontier must be surfaced prominently. Do not automatically
rewrite dependencies.

## Baseline and Durable State

Every ticket must be evaluated against CURRENT durable state:

- the current GitHub issue
- the current Ralph integration branch
- accepted specifications
- accepted ADRs
- the current repository implementation
- already-integrated predecessor work

Do not evaluate all tickets as though they execute against the
baseline that exists today when known predecessor changes are
relevant.

Use the existing issue, spec, and ADR contracts to reason about the
expected post-predecessor boundary. Do not invent implementation
details for unfinished predecessors.

## Reshaping

When a ticket receives `RESHAPE_REQUIRED`, report the MINIMUM
decomposition proposed by `ralph-ticket-refiner`. For every proposed
child include:

- responsibility
- acceptance boundary
- validation strategy
- dependency order

Do not create the child tickets. Do not rewrite the original issue.
The milestone remains NOT READY until a human approves and applies
the reshaping.

## Milestone Readiness

After ALL open implementation tickets are evaluated, compute a
milestone readiness result.

`MILESTONE EXECUTION READY: YES` only when every open implementation
ticket is:

- `RALPH_READY`, and
- its required routing label is successfully present

Otherwise:

`MILESTONE EXECUTION READY: NO`

Reasons include:

- `RESHAPE_REQUIRED`
- `SUPERVISED_REQUIRED`
- `ALREADY_SATISFIED` awaiting human confirmation
- label mutation failure
- malformed or cyclic dependency graph
- evaluation failure
- missing authority or policy

Do not claim execution readiness merely because the current execution
frontier contains one ready ticket. The goal is to prepare the WHOLE
milestone for unattended execution.

## Final Report

Produce a compact milestone matrix in this exact form:

```
# Ralph Milestone Refinement — <Milestone name>

| Issue | Title | Verdict | Routing |
|------:|-------|---------|---------|
| #<n>  | <title> | <VERDICT> | <applied-or-none> |
```

Then report counts:

```
Ready: <n>
Reshape: <n>
Supervised: <n>
Already satisfied: <n>
Evaluation failures: <n>
```

Then report, in this order:

### Reshaping requiring human review

For each `RESHAPE_REQUIRED` ticket: the minimum decomposition
proposed by `ralph-ticket-refiner`.

### Supervised work

For each `SUPERVISED_REQUIRED` ticket: the reason, including any
unresolved decision, authority conflict, or unsafe autonomous path.

### Already satisfied — human confirmation required

List every `ALREADY_SATISFIED` issue, or `None`.

### Dependency problems

List every dependency problem, or `None`.

End with exactly one line and nothing after it:

```
MILESTONE EXECUTION READY: YES
```

or

```
MILESTONE EXECUTION READY: NO
```

Do not dump the complete verbose per-ticket report unless the user
explicitly asks for it. Preserve enough evidence to explain every
non-ready verdict.

## Safe Mutation Boundary

Permitted automatic mutations:

- add or remove the four routing labels only

Forbidden automatic mutations:

- issue body edits
- issue title edits
- closing or reopening issues
- creating child tickets
- dependency edits
- milestone edits
- code changes
- branches
- commits
- pull requests

Those require a later explicit human-approved operation.

## Relationship to Ralph

The intended pipeline is:

```
grill-with-docs
    ->
to-specs
    ->
to-tickets
    ->
ralph-milestone-refiner
    ->
human resolves refinement exceptions
    ->
ralph --milestone
```

This skill does not invoke `ralph --milestone`. A ready milestone is
handed to a human who runs `ralph --milestone`.
