# review-branch — Slice-Aware Review Amendment

> **Purpose:** Add bounded implementation-slice awareness to the existing `review-branch` skill without weakening its correctness standards.
>
> Paste/integrate this section into the existing `review-branch/SKILL.md`. The rest of the existing review skill remains authoritative.

---

## Implementation-slice awareness

Some GitHub issues are intentionally implemented through a tracked sequence of bounded slices rather than one all-at-once branch change.

When reviewing a branch for an issue that has a tracked implementation-slice plan, the review MUST distinguish:

1. the **overall issue contract**,
2. the **current implementation slice**,
3. **previously completed slices**, and
4. **future slices intentionally deferred by the plan**.

The slice plan does not replace the GitHub issue or authoritative specs. It only defines implementation sequencing and the current review boundary.

### Discovering a slice plan

Before performing the issue-completeness pass:

1. Read the GitHub issue.
2. Look for a tracked issue-specific implementation-slice document, preferably:
   - `docs/specs/issue-<NUMBER>-implementation-slices.md`
3. If one exists:
   - read it fully;
   - locate `CURRENT REVIEW TARGET`;
   - record the current slice identifier in the review report.
4. If no slice plan exists, use the existing full-issue review behavior.

Do not infer a slice plan from branch names, comments, or model memory. Use the tracked repository document.

---

## Review precedence

When a slice plan exists, use this precedence:

```text
GitHub issue + authoritative product/domain specs
    ↓
tracked implementation-slice plan
    ↓
current branch diff
```

The GitHub issue and authoritative specs remain the product truth.

The slice plan may narrow **when** a requirement is implemented, but it may not:

- contradict the issue;
- weaken an acceptance criterion;
- remove an invariant;
- reclassify required work as optional;
- or authorize behavior the issue forbids.

If the slice plan conflicts with the issue/spec, report that conflict as blocking.

---

## Current-slice review rule

For the current review:

Review the branch against:

1. every acceptance criterion of the `CURRENT REVIEW TARGET`;
2. every previously completed slice that the current change could regress;
3. every overarching issue invariant that the current slice must preserve;
4. compatibility with the explicitly deferred future slices.

Do **not** report a future-slice requirement as missing/blocking solely because it has not been implemented yet.

Example:

If `CURRENT REVIEW TARGET: 86A` and the slice plan assigns Pause behavior to 86B, do not block 86A because the Pause endpoint is absent.

Instead, place it under:

`Not applicable / deferred by approved slice plan`

when mentioning it adds useful context.

---

## When future-slice work IS blocking

A requirement assigned to a future slice becomes relevant to the current review when the current implementation:

- contradicts the overall issue;
- makes the future requirement impossible;
- locks in an incompatible persistence model;
- locks in an incompatible API or DTO contract;
- creates an incorrect lifecycle transition;
- introduces an authorization or privacy hole;
- weakens atomicity/idempotency needed by the later slice;
- implements future-slice behavior prematurely and incorrectly;
- violates an existing completed-slice invariant;
- or creates a migration/schema choice that would require destructive correction later.

Examples:

- 86A does not need to implement Pause, but a Pause evidence schema that fabricates an activation confirmation is blocking.
- 86A does not need to implement Reactivate, but repository/input types that cannot carry the complete repaired state required by Reactivate are blocking.
- 86A does not need to implement Active Update, but an evidence model that cannot support durable same-key Update retry convergence is blocking.
- 86B does not need to implement final-sample removal, but a Pause repository design that cannot be reused atomically by 86D may be blocking.
- 86C does not need to implement UI, but changing OwnerView in a way that exposes private update evidence may be blocking.

---

## Scope-drift rule

The slice plan also defines what the current slice must **not** implement.

Report as blocking when the current slice introduces meaningful behavior explicitly assigned to a later slice and that premature behavior:

- is incomplete,
- cannot yet satisfy the full contract,
- creates a public/nonfunctional surface,
- or increases review ambiguity.

Example:

If 86A is persistence/contracts only, adding public Pause/Reactivate/Update routes that intentionally return `501 Not Implemented` is a blocker even though those routes belong to the overall issue. They belong to later slices and should be introduced atomically with working behavior.

---

## Review report format when a slice plan exists

Include this near the top:

```text
Review target: #<issue> / <slice-id>
Slice plan: <repo path>
Future slices: <slice ids> — intentionally deferred
```

### Scope reviewed

State:

- issue number;
- current slice;
- base;
- head;
- current diff;
- previously completed slices relevant to regression review.

### Blocking findings

Only include:

- defects in the current slice;
- regressions to completed slices;
- cross-slice contract problems;
- future-slice incompatibilities created by the current slice;
- issue/spec contradictions.

Do not include intentionally deferred work merely because it is absent.

### Non-blocking / follow-up

Use for useful concerns that:

- are not required for the current slice,
- do not endanger future implementation,
- and do not violate the overall issue.

### Not applicable / deferred by slice plan

Explicitly list significant issue requirements that were considered but are intentionally assigned to later slices.

This section is especially useful when the GitHub issue is much larger than the current slice.

Example:

```text
Not applicable / deferred by slice plan:
- Pause execution → 86B
- Reactivate execution → 86B
- Active atomic update → 86C
- final-sample lifecycle transition → 86D
- grandfather remediation/inventory → 86E
- lifecycle UI/E2E → 86F
```

### Verification

Run the verification required by:

1. the current slice plan;
2. the existing review skill;
3. any additional focused checks needed by the diff.

Do not require future-slice E2E behavior before its slice is implemented.

---

## Approval rule

A partial implementation slice may receive `APPROVED` when:

- every current-slice acceptance criterion is satisfied;
- required verification passes;
- completed slices remain regression-safe;
- the slice preserves the full issue's cross-cutting invariants;
- it leaves future slices implementable without destructive redesign;
- no future-slice behavior has been prematurely exposed in a broken state.

Approval of a slice means:

> The current implementation boundary is sound and safe to build upon.

It does **not** mean:

> The entire GitHub issue is complete.

The final slice/full-branch review still evaluates the entire GitHub issue before merge.

---

## Final full-issue review

When the slice plan indicates all implementation slices are complete, or the user explicitly requests final issue review:

1. ignore the slice deferral exemption;
2. review the complete branch against the entire GitHub issue;
3. require all issue acceptance criteria;
4. require final integration/E2E/manual-QA evidence specified by the plan;
5. report any previously deferred requirement that remains incomplete as blocking.

The final approval is the only approval that means the complete issue is ready for merge.
