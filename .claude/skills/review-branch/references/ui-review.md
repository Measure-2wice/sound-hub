# Targeted UI Review

Read this reference only when the ticket materially changes user-visible UI.

UI review is intentionally bounded.

## Scope

Inspect only:

- changed routes;
- changed components;
- ticket-required states;
- relevant responsive breakpoints; and
- relevant loading, error, empty, and success states.

Do not perform broad visual exploration.

## Preferred evidence order

1. Existing visual-test output.
2. Existing screenshot tests.
3. Targeted affected-route browser inspection.
4. Existing baseline comparison.

## Check for

- clipping;
- overflow;
- broken responsive layout;
- missing required elements;
- unreachable controls;
- misleading copy;
- invisible errors;
- broken keyboard focus;
- obvious accessibility defects; and
- regressions that affect the required user flow.

## Do not

- crawl unrelated routes;
- redesign pages;
- update snapshots;
- create new baselines;
- treat harmless anti-aliasing differences as defects; or
- spend review context polishing aesthetics.

Visual polish that does not impair required behavior should normally be classified:

`NON-BLOCKING / FOLLOW-UP`

If deeper visual exploration would be valuable, report:

`Recommend separate visual-review session.`

Do not perform that broader review inside this skill.
