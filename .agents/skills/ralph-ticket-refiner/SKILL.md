---
name: ralph-ticket-refiner
description: Evaluate a GitHub implementation ticket for autonomous Ralph readiness. Use when refining, sizing, reshaping, or checking whether a ticket is bounded, already satisfied, or requires supervision before Ralph execution.
---

# Ralph Ticket Refiner

Evaluate a shaped implementation ticket before autonomous Ralph execution.

Do not implement code or mutate GitHub unless explicitly asked to apply an approved refinement.

## Goal

Determine whether one fresh agent can understand, implement, validate, and defend the ticket within the Ralph execution budget.

Read `.ralph/refinement/policy.json` completely. If it is missing or unreadable, stop and report that evaluation is blocked.

## Authority

Fetch the current GitHub issue at evaluation time. If it cannot be fetched, stop.

Do not substitute cached text, prior refinement output, or conversation history.

The current issue defines the implementation boundary. Parent specifications and accepted ADRs constrain that boundary but do not expand it.

If the issue conflicts with accepted architecture, identify the conflict and return `SUPERVISED_REQUIRED`.

## Acceptance Criteria

Report every current acceptance criterion as:

- `IMPLEMENT` — meaningful work remains.
- `PROVEN` — durable repository evidence already satisfies it.
- `VALIDATION` — rerun existing evidence to guard the new delta.
- `BLOCKED` — a missing decision, prerequisite, or authority prevents implementation.

Cite evidence for `PROVEN`, `VALIDATION`, and `BLOCKED`.

Do not restore superseded criteria or invent new ones.

## Evaluation

Evaluate:

- **Responsibility:** Is there one coherent implementation responsibility?
- **Decisions:** Are required product and architecture decisions resolved?
- **Validation:** Can focused tests prove the responsibility?
- **Review:** Can an adversarial reviewer assess it as one unit?
- **Recoverability:** Can a fresh agent reconstruct it from durable state?
- **Integration:** Would proposed child tickets each have independent value?

Multiple fixtures, edge cases, or validation levels for the same invariant do not create multiple responsibilities.

Retry or recovery proof for a migration or state transition belongs to that same responsibility.

“Existing tests remain green” is validation, not a separate implementation slice.

## Scope Discipline

Evaluate the approved ticket; do not redesign or harden it.

Do not invent constraints, triggers, APIs, services, forward enforcement, or additional test products unless the current ticket or accepted architecture requires them.

Do not revive a deliberately demoted legacy field as an authority source.

Do not recommend rewriting an integrated migration unless repository policy permits it.

## Verdicts

- `RALPH_READY` — meaningful work remains as one bounded responsibility; decisions and validation are complete.
- `RESHAPE_REQUIRED` — meaningful work spans multiple independently valuable and safely integrable responsibilities.
- `ALREADY_SATISFIED` — no criterion is `IMPLEMENT` or `BLOCKED`, and no meaningful implementation delta remains.
- `SUPERVISED_REQUIRED` — a material criterion is `BLOCKED`, authorities conflict, or autonomous execution remains unsafe after considering decomposition.

Prefer `RALPH_READY` for one coherent delta. Otherwise prefer meaningful reshaping over supervision.

Never split solely by file, weaken requirements, or invent work to keep an issue alive.

## Output

Report:

1. authoritative inputs,
2. acceptance-criteria disposition,
3. responsibility and implementation boundary,
4. validation strategy,
5. risks,
6. decomposition only when required.

End with exactly one line and nothing after it:

`VERDICT: RALPH_READY`

or

`VERDICT: RESHAPE_REQUIRED`

or

`VERDICT: ALREADY_SATISFIED`

or

`VERDICT: SUPERVISED_REQUIRED`