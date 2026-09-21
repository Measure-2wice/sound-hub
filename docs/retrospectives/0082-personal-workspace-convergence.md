# #82 — Personal Workspace Convergence Retrospective

## Outcome

Merged successfully after implementation, code review, visual QA,
Tenki review, CodeQL, and CI.

## What worked

- grill → spec → tickets gave implementation a strong contract
- Codex caught architecture and behavioral-test issues
- Tenki found real security/availability problems
- visual QA caught customer-facing language and accessibility issues
- runtime investigation prevented us from shipping fake req.ip security
- executable behavioral tests were more valuable than source-pattern tests

## What cost too much

- rate-limit remediation expanded beyond #82's actual responsibility
- too many planning/replanning loops
- reviewers sometimes proposed technically valid fixes outside ticket scope
- large Claude contexts caused unnecessary token usage
- we nearly redesigned the public auth/network boundary to satisfy one finding

## Rules for #83+

1. Define the ticket's review boundary before implementation.
2. Classify reviewer findings:
   - FIX HERE
   - FOLLOW-UP TICKET
   - FALSE / NOT APPLICABLE
3. Don't redesign adjacent architecture merely to silence a scanner.
4. Prefer behavioral tests for user-visible/runtime behavior.
5. Use runtime evidence when deployment assumptions matter.
6. Once acceptance criteria + reviewers + CI are green, stop.
7. Keep implementation and review sessions focused/fresh.

## Follow-up ideas

- Dedicated public-boundary authentication abuse-protection ticket
- Improve agent context/token discipline
- Revisit general review workflow after #83–#85