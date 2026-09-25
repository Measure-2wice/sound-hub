# Release Mode

Read this reference only when the user explicitly states that the branch is under a release, demo, launch, or deadline constraint.

Release mode uses risk-based review.

## Block approval for

- unmet ticket acceptance criteria;
- in-scope functional regressions;
- credible security defects;
- authorization defects;
- data-integrity violations;
- persistence invariant violations;
- broken required build;
- broken required demo happy path; or
- user-visible failures preventing the ticket's primary flow.

## Normally classify as NON-BLOCKING / FOLLOW-UP

- refactoring opportunities;
- duplication;
- cosmetic polish;
- test-architecture cleanup;
- source-regex test replacement;
- documentation polish;
- naming improvements;
- pre-existing defects;
- unrelated security hardening;
- future-ticket work; and
- architecture cleanup with no current behavioral impact.

Release mode does not permit ignoring a real security, authorization, or data-integrity defect introduced by the branch.

## Stop rule

Once all of the following are true:

- ticket acceptance criteria are satisfied;
- relevant focused tests pass;
- required build and merge gates pass;
- required happy path works; and
- no blocking security, authorization, or data-integrity findings remain;

approve the branch.

Do not continue generating implementation loops for follow-up findings.
