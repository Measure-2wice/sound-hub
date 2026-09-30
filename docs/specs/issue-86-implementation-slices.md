# GitHub Issue #86 — Implementation Slices

> **Purpose:** Define the approved implementation sequence for GitHub issue #86 so implementation and review can proceed in bounded slices without treating intentionally deferred work as missing.
>
> **Authoritative source:** GitHub issue #86 and the reconciled Milestone 2 specifications remain authoritative for product behavior. This document defines implementation sequencing and review boundaries only. It does not replace or weaken the issue.

---

## Current review target

**CURRENT REVIEW TARGET: `86A`**

Update this line only after the current slice has:

1. been implemented,
2. passed its required verification,
3. been independently reviewed,
4. had all blocking findings resolved, and
5. been committed as the accepted foundation for the next slice.

The slices are implemented **sequentially**, not in parallel.

---

## Review rule

For any review of issue #86:

1. Read GitHub issue #86 as the authoritative overall contract.
2. Read this implementation-slice plan.
3. Identify the `CURRENT REVIEW TARGET`.
4. Review:
   - the current slice's acceptance criteria,
   - every previously completed slice,
   - cross-slice invariants from the full issue that the current slice must preserve.
5. Do **not** report requirements assigned to a later slice as missing/blocking merely because they are intentionally deferred.
6. A future-slice concern **is blocking** when the current slice:
   - contradicts the overall issue,
   - makes the future slice impossible or unsafe,
   - locks in an incompatible schema/API/persistence contract,
   - implements behavior assigned to a later slice prematurely,
   - weakens an existing #85 invariant,
   - or violates a cross-slice authorization, privacy, atomicity, idempotency, or lifecycle invariant.
7. When useful, list intentionally deferred requirements under **Not applicable / Deferred by slice plan**.

---

# Cross-slice invariants

These apply to every slice.

## Lifecycle

- `Draft`, `Active`, `Paused`, and `Archived` remain distinct durable states.
- Customer-facing `Available` is an alias for durable `Active`; it is not a new persisted state.
- `Archived` self-service behavior is outside #86.
- Pause must never require current activation completeness.
- Reactivation must re-run the full current activation contract.
- Repairing data or uploading audio must never auto-reactivate a Paused offering.
- Active updates must not create a persistent post-activation Draft.
- Failed Active update must preserve the prior public Active state.
- Failed Reactivate must preserve the prior Paused state.

## Authorization

Consequential ServiceOffering commands remain limited to the current authorized Personal Workspace Seller actor and the offering's owning Workspace.

Pause intentionally does **not** require:

- a Published SellerProfile, or
- current activation completeness.

Reactivate and Active update do require the current activation contract, including the applicable SellerProfile publication precondition.

## Idempotency

For Pause, Reactivate, and Active Update:

1. acquire the required lock/transaction boundary;
2. look up durable evidence by `(offeringId, idempotencyKey)`;
3. if evidence exists, return the previously committed success;
4. otherwise evaluate the lifecycle precondition;
5. if the lifecycle precondition fails, return the correct conflict;
6. otherwise execute the command.

Therefore:

- same-key retry after committed success → converged success;
- different key against incompatible current lifecycle → conflict;
- transport failure before commit → same key may safely retry;
- validation failure with corrected payload → new key.

## Evidence

### ServiceOfferingPause

Pause evidence records only facts established by Pause.

It must not fabricate an activation confirmation.

Required evidence fields:

- `id`
- `offeringId`
- `workspaceId`
- `sellerProfileId`
- `pausedByUserId`
- `pausedAt`
- `reason`
- `idempotencyKey`
- `requestId`

Pause reason:

- `user_initiated`
- `final_sample_removal`

### ServiceOfferingUpdate

Durable update evidence is required for same-key retry convergence of Active updates.

Required evidence fields:

- `id`
- `offeringId`
- `workspaceId`
- `sellerProfileId`
- `updatedByUserId`
- `confirmationVersion`
- `updatedAt`
- `idempotencyKey`
- `requestId`

An Active update:

- does not create a new activation row;
- does not rewrite historical activation evidence;
- preserves the original activation timestamp in the owner-facing lifecycle view.

## Audio

Audio upload/remove is an independent consequential command surface; it is not part of the local Active listing-edit transaction.

- Active owner playback remains private and authorized.
- Active audio upload is allowed by #86.
- Removing a non-final qualifying sample from Active does not change lifecycle state.
- Removing the final qualifying sample from Active requires explicit eligibility-loss confirmation.
- Final qualifying sample removal must atomically transition `Active → Paused` and mark the sample pending cleanup before external storage deletion is attempted.
- Storage cleanup failure must not restore marketplace eligibility.
- A replacement sample uploaded while Paused never auto-reactivates the offering.

## Grandfathering

A grandfathered nonconforming offering is derived, not persisted with a synthetic legacy flag.

The predicate is:

```text
offering.status === Active
AND (
  title missing
  OR description missing
  OR primary category missing
  OR required service area missing
  OR pricing choice missing
  OR confirmed qualifying audio count < 1
  OR activation confirmation is stale
  OR SellerProfile is not Published
)
```

No missing pricing, audio, confirmation, attestation, ownership, or seller claim may be fabricated.

---

# Slice dependency graph

```text
86A — Lifecycle persistence + command contracts
 ├── 86B — Pause + Reactivate
 │    └── 86D — Active audio lifecycle
 ├── 86C — Atomic Active update
 ├── 86E — Grandfathering + inventory
 └── 86F — UI + integrated QA

86F depends on 86A–86E.
```

Implementation is sequential for this ticket even where code-level dependency might theoretically allow parallel work. This avoids competing assumptions and merge conflicts in the same ServiceOffering repository/service/editor surfaces.

---

# 86A — Lifecycle persistence + command contracts

## Scope

Establish the durable persistence and compile-time/domain contracts that later slices require.

86A includes:

- `ServiceOfferingPauseReason`
- `ServiceOfferingPause`
- `ServiceOfferingUpdate`
- additive migration
- closed API error codes and status mappings
- Pause request schema
- strict Reactivate/Update request typing by reuse of the existing activation contract
- `confirmEligibilityLoss?: boolean` on audio removal request typing
- repository/domain interface types required by later slices

## Explicit non-goals

86A does **not** implement:

- Pause business logic
- Reactivate business logic
- Active update business logic
- final-sample atomic lifecycle behavior
- grandfather readiness
- inventory script
- UI
- web clients for commands that do not work yet
- fake runtime endpoints
- fake `501 Not Implemented` routes
- repository/service stubs whose only behavior is `not_implemented_yet`

## Persistence contract

### ServiceOfferingPause

No activation `confirmationVersion`.

Required fields and constraints:

```text
id
offeringId
workspaceId
sellerProfileId
pausedByUserId
pausedAt
reason
idempotencyKey
requestId

UNIQUE (offeringId, idempotencyKey)
INDEX (offeringId, pausedAt DESC)
INDEX (workspaceId)
```

### ServiceOfferingUpdate

Required fields and constraints:

```text
id
offeringId
workspaceId
sellerProfileId
updatedByUserId
confirmationVersion
updatedAt
idempotencyKey
requestId

UNIQUE (offeringId, idempotencyKey)
INDEX (offeringId, updatedAt DESC)
INDEX (workspaceId)
```

Migration is additive only:

- no backfill;
- no rewrite of existing ServiceOffering rows;
- no legacy/grandfather flag;
- no fabricated pricing/audio/confirmation data.

## Error contracts

Add:

- `SERVICE_OFFERING_ALREADY_PAUSED` → 409
- `SERVICE_OFFERING_NOT_PAUSED` → 409
- `SERVICE_OFFERING_NOT_ACTIVE` → 409
- `SERVICE_OFFERING_INVALID_UPDATE` → 422
- `AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED` → 400

## Acceptance criteria

- migration applies cleanly to disposable PostgreSQL;
- Pause evidence contains no activation confirmation field;
- Update evidence supports durable `(offeringId, idempotencyKey)` convergence;
- existing rows remain unchanged;
- closed error schema includes all new codes;
- status mappings are correct;
- Pause request accepts a UUID idempotency key and rejects invalid input;
- Reactivate/Update contract typing reuses the existing strict activation rules rather than reimplementing them;
- `confirmEligibilityLoss` is optional request-only data and is not persisted;
- no runtime command implementation or fake route is introduced.

## Verification

At minimum:

```text
Prisma generate
focused migration/schema tests
focused type/schema tests
pnpm format:check
pnpm lint
pnpm type-check
pnpm check:fast
pnpm build
git diff --check
```

## Review gate

Codex reviews only the 86A delta plus overarching #86 invariants.

Future slices 86B–86F are deferred and must not be reported as missing unless 86A makes them impossible, unsafe, or contract-incompatible.

---

# 86B — Pause + Reactivate

## Scope

Implement Pause and Reactivate end-to-end in:

- Prisma repository
- in-memory repository
- service layer
- HTTP routes
- web client functions required by the later UI
- focused tests

## Pause

`Active → Paused`

Pause:

- requires current authorized Personal Workspace Seller authority and ownership;
- does not require current activation completeness;
- does not require Published SellerProfile;
- writes `ServiceOfferingPause(reason=user_initiated)`;
- removes ordinary search/new-ProjectRequest eligibility through the existing lifecycle predicate;
- does not rewrite existing engagements.

## Reactivate

`Paused → Active`

Reactivate accepts the **complete replacement listing state** and, in one transaction:

1. performs same-key evidence lookup;
2. verifies current state is Paused;
3. re-runs the current strict activation contract;
4. re-checks qualifying confirmed audio;
5. re-checks Published SellerProfile;
6. atomically persists the complete replacement public fields;
7. transitions Paused → Active;
8. writes a new `ServiceOfferingActivation` row.

On failure:

- offering remains Paused;
- prior persisted Paused fields remain unchanged;
- no activation evidence is written.

## Acceptance criteria

Must cover:

- Pause success
- Pause same-key convergence
- Pause different-key already-Paused conflict
- Reactivate success
- Reactivate same-key convergence
- Reactivate different-key Active conflict
- missing audio → remains Paused
- unpublished profile → remains Paused
- complete repaired payload is persisted atomically with Reactivate
- repaired payload failure persists nothing
- upload while Paused does not auto-reactivate
- inverse authorization

## Review gate

Codex review before 86C.

---

# 86C — Atomic Active update

## Scope

Implement explicit post-activation update without a persistent working Draft.

State model:

```text
VIEW_ACTIVE
  → Update service
EDIT_ACTIVE_LOCAL_ONLY
  → Cancel/reload: discard local edits
  → Submit complete state: PUT /update
      → success: VIEW_ACTIVE with updated public state
      → failure: stay local edit mode; prior public state unchanged
```

The server command:

- requires current Active state;
- performs same-key update-evidence lookup before lifecycle rejection;
- re-runs the current strict activation completeness contract;
- atomically replaces the complete public field set;
- writes `ServiceOfferingUpdate`;
- keeps status Active;
- does not create or alter `ServiceOfferingActivation`.

## Correct idempotency behavior

- same committed update key → converged success;
- Active + a **new** idempotency key → execute a new update;
- Paused/Draft/Archived + new update key → lifecycle conflict.

Do **not** treat “different key while Active” as a conflict; Active is the valid source state for a new update.

## Owner-facing lifecycle history

OwnerView remains unchanged:

- original activation timestamp remains activation history;
- update evidence remains private;
- customer success feedback may say `Service updated.`;
- no `updatedAt` field is added solely for UI decoration.

## Review gate

Codex review before 86D.

---

# 86D — Active audio lifecycle

## Scope

Extend audio management for post-activation behavior.

### Active upload

Allowed. No lifecycle transition.

### Active non-final qualifying sample removal

Allowed without eligibility-loss flag.

- remove sample;
- Active remains Active;
- no Pause evidence.

### Active final qualifying sample removal

Requires:

```text
confirmEligibilityLoss: true
```

Without the flag:

```text
AUDIO_SAMPLE_FINAL_REMOVAL_CONFIRMATION_REQUIRED
```

With the flag, one DB transaction must:

1. acquire locks in established order;
2. verify this is the final qualifying live sample;
3. transition Active → Paused;
4. write `ServiceOfferingPause(reason=final_sample_removal)`;
5. mark sample `PendingCleanup`.

Only after commit:

6. attempt provider deletion.

Provider failure:

- offering remains Paused;
- sample remains PendingCleanup;
- cleanup retry evidence remains bounded;
- no public/buyer eligibility is restored.

## Review gate

Codex review before 86E.

---

# 86E — Grandfathering + inventory

## Scope

Implement:

- one single-source readiness derivation for current activation requirements;
- Available + Update needed derivation;
- actionable reason categories;
- pre-rollout read-only inventory script.

No legacy flag is persisted.

## Reason categories

Derived from the current activation requirements plus lifecycle evidence/profile state:

- `title-required`
- `description-required`
- `category-required`
- `service-area-required`
- `pricing-required`
- `audio-sample-required`
- `activation-confirmation-stale`
- `seller-profile-not-published`

## Inventory

Use a checked-in, read-only operator script rather than a permanent API endpoint.

The script:

- accepts a DB URL;
- performs reads only;
- emits structured JSON;
- reports currently Active nonconforming offerings and reason categories;
- never authorizes or performs data rewrites.

## Dependency boundary

Do not make `packages/db` import upward from an application service package if forbidden by repository dependency rules.

Before implementation, choose a legal shared location for the pure readiness predicate that:

- can be reused by runtime ServiceOffering composition;
- can be reused by the inventory implementation;
- passes `test:forbidden-deps`.

## Review gate

Codex review before 86F.

---

# 86F — UI + integrated QA

## Scope

Integrate the finished lifecycle behavior into the existing #85 ServiceOffering experience.

Required UI states:

### Draft

Preserve #85 behavior:

- Private draft
- Save draft
- activation readiness
- Activate service

### Active, conforming

- Available
- read-only by default
- Update service
- Pause service
- owner audio management
- original activation history remains visible

### Active, nonconforming / grandfathered

Show simultaneously:

- Available
- Update needed

The offering remains available until the seller explicitly Pauses or successfully replaces the public state.

Render actionable remediation reasons without fabricated claims.

### Active local edit mode

- listing controls enabled locally only;
- Cancel discards;
- Update submits complete replacement;
- failure preserves public state and entered local values;
- success returns to read-only Active view with transient `Service updated.` feedback.

### Paused

- Paused status
- not buyer-search/request eligible
- sample upload permitted
- no auto-reactivation
- Reactivate service enters local repair mode
- Reactivate submits the complete replacement state.

### Final sample removal

Active final qualifying sample removal shows explicit consequence confirmation before calling the server with `confirmEligibilityLoss: true`.

## Stitch

Stitch remains presentation evidence only.

Do not import prohibited or invented Stitch concepts such as:

- Acoustic Service Compliance
- Service fingerprint
- Legacy v1.4
- studio nomenclature standards
- mastering/bit-depth guarantees
- invented verification/security/compliance claims

## QA

Required coverage includes:

- lifecycle round-trip
- Pause
- Reactivate failure + correction + success
- Active Update failure/success
- grandfathered Available + Update needed
- non-final Active audio removal
- final-sample Active → Paused
- storage cleanup failure
- Paused sample replacement without auto-reactivation
- desktop
- ~393px mobile
- keyboard/focus/dialog accessibility
- status conveyed beyond color
- reduced motion where applicable

Final full-branch Codex review occurs after 86F and manual visual QA.

---

# Completion workflow

For each slice:

```text
Implement current slice
→ focused verification
→ Codex delta review
→ fix blocking findings
→ rerun verification/review
→ commit accepted slice
→ update CURRENT REVIEW TARGET
→ begin next slice
```

After 86F:

```text
full manual visual QA
→ broad PR review / Tenki
→ apply review feedback
→ final Codex full-branch review
→ CI
→ resolve review conversations
→ merge #86
```

---

# Explicit #86 non-goals

Do not add as part of #86:

- self-service Archive
- restore
- duplication
- generalized revision/version history
- capability deactivation
- Organization governance
- editing existing ProjectRequests/Deals/TermsVersions/approvals/funding
- generalized audit/event-sourcing framework
- unrelated media/transcoding support
