# Review Procedure

Use this reference for the normal branch-review procedure.

## 1. Establish ticket authority

Create a private checklist from the ticket's acceptance criteria and referenced specs.

For every criterion classify privately:

- Satisfied
- Partially satisfied
- Not satisfied
- Cannot verify
- Not applicable

Identify:

- ticket goals;
- ticket non-goals;
- persistence invariants;
- authorization boundaries;
- concurrency guarantees;
- required failure behavior;
- UI requirements; and
- later-ticket boundaries.

Do not report missing behavior that was not requested.

If the branch implements behavior beyond the ticket, determine whether it is:

1. required supporting infrastructure;
2. harmless incidental work; or
3. unauthorized scope expansion.

Only the third category is a scope finding.

## 2. Review implementation

Prioritize real behavioral defects.

Inspect for:

- incorrect business logic;
- unmet acceptance criteria;
- invalid state transitions;
- broken persistence invariants;
- authorization mistakes;
- cross-user or cross-Workspace exposure;
- stale state;
- race conditions;
- duplicate creation;
- non-idempotent retries when idempotency is required;
- partial writes when atomicity is required;
- invalid rollback behavior;
- unsafe trust boundaries;
- incorrect API or schema behavior;
- missing validation;
- error, loading, and empty-state failures;
- broken navigation or continuation behavior;
- inaccessible required flows;
- regressions introduced by the branch;
- security-relevant logging or error leakage; and
- misleading user-visible state.

Review architecture only when it creates a concrete correctness, security, maintenance, or testability problem relevant to the ticket.

Do not report architecture preferences as defects.

## 3. Persistence and concurrency

When persistence or transactions change, inspect:

- transaction boundaries;
- uniqueness constraints;
- foreign keys;
- retry behavior;
- idempotency;
- conflict detection;
- lost updates;
- race windows;
- rollback behavior;
- immutable or append-only records;
- actor attribution;
- versioning; and
- canonical identity selection.

Prefer tests proving externally visible outcomes over internal lock sequencing.

Do not require a specific locking implementation unless the specification does.

Do not pull an unchanged pre-existing flaky concurrency test into ticket scope.

## 4. Review tests

Check coverage for:

- important acceptance criteria;
- main success path;
- important failure paths;
- inverse authorization;
- boundary states;
- retry or concurrency behavior when required;
- rollback when required;
- user-visible error states; and
- likely regressions.

Prefer behavioral tests over source-pattern assertions.

Source-pattern tests can be follow-up debt when real behavior is otherwise proven.

Do not block approval solely because a test could be more elegant.

A test that cannot fail for the behavior it claims to prove is a valid finding when that behavior matters to the ticket.

## 5. Run relevant checks

Inspect repository scripts and `AGENTS.md` first.

Run narrow checks first.

Examples:

```bash
pnpm --filter <affected-package> test
pnpm --filter <affected-package> type-check
pnpm check:fast
pnpm build
```

Use repository-specific commands rather than inventing generic ones.

Run broad suites only when:

- the branch is broad;
- the ticket explicitly requires them;
- they are defined merge gates; or
- runtime is reasonable.

Never run mutation commands such as:

```bash
prettier --write
eslint --fix
jest -u
playwright test --update-snapshots
```

For each command record:

- command;
- result;
- relevant failure; and
- whether the failure appears branch-caused, pre-existing, flaky, environment-related, or cannot determine.

Never change code to make a check pass.

## 6. Repository cleanliness

After verification run:

```bash
git status --short
```

Compare with the initial state.

If a tracked file changed:

- stop;
- report the file;
- report which command caused or likely caused it; and
- do not restore or modify it.

Ignored build artifacts do not need reporting unless they interfere with review.

## 7. Re-review mode

When explicitly asked to re-review:

1. Verify current HEAD first.
2. Read only unresolved findings relevant to current HEAD.
3. Classify each as:
   - Resolved
   - Still blocking
   - Follow-up
   - No longer applicable
4. Do not resurrect resolved findings.
5. Do not expand ticket scope based on review history.

Current code and current ticket remain authoritative.
