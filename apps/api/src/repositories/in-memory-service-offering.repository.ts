// In-memory implementation of ServiceOfferingRepository.
//
// Used by the API unit tests (apps/api/src/routes/service-offering.test.ts,
// apps/api/src/services/service-offering.service.test.ts).
//
// Mirrors the Prisma adapter's atomic-write contract with a
// per-offering async mutex chain (Map<offeringId, Promise<void>>)
// instead of FOR UPDATE locks. The mutex serializes all writes per
// offering so concurrent attempts observe the same sequencing the
// Prisma transaction-scoped locks would enforce.
//
// The (workspaceId, idempotencyKey) retry convergence for create
// and the (offeringId, idempotencyKey) retry convergence for
// activation are implemented at the application layer (mirroring
// the Prisma DB unique constraints): the createDraft / activate
// methods look up the existing evidence BEFORE writing; if found,
// they return the existing outcome without creating a new row.
//
// The in-memory adapter only knows about the offering row itself,
// not the rest of the marketplace graph (WorkspaceMembership,
// WorkspaceCapability, etc.). It is the SERVICE-LAYER test's job
// to assert that the application policy composes the authorization
// gate; the in-memory adapter ONLY enforces the offering-shape
// invariants (status transitions, idempotency, ownership).
//
// M2 (#85) PR-review feedback: activation completeness is now
// re-checked INSIDE the per-offering lock so a concurrent remove
// after the service-layer pre-check cannot produce a newly Active
// offering with zero qualifying samples. The in-memory adapter
// counts CONFIRMED Live samples (matching the Prisma adapter's
// filter) and throws ServiceOfferingIncompleteError when the
// count is out of range.

import type {
  ServiceOfferingActivationConfirmationVersionV1,
  ServiceOfferingAudioMediaConfirmationVersionV1,
  ServiceOfferingOwnerSampleSummaryV1,
} from "@soundhub/types";
import type {
  ServiceOfferingActivateInput,
  ServiceOfferingActivationEvidenceView,
  ServiceOfferingActivationResult,
  ServiceOfferingCreateDraftInput,
  ServiceOfferingDraftInput,
  ServiceOfferingOwnerViewRecord,
  ServiceOfferingPauseInput,
  ServiceOfferingPauseReasonValue,
  ServiceOfferingPauseResult,
  ServiceOfferingReactivateInput,
  ServiceOfferingRepository,
  ServiceOfferingUpdateActiveInput,
  ServiceOfferingUpdateActiveResult,
  ServiceOfferingUpdateEvidenceView,
} from "./service-offering.repository.js";
import {
  buildActivationCompletenessFieldErrors,
  ServiceOfferingAlreadyPausedError,
  ServiceOfferingIncompleteError,
  ServiceOfferingInvalidUpdateError,
  ServiceOfferingNotActiveError,
  ServiceOfferingNotDraftError,
  ServiceOfferingNotFoundError,
  ServiceOfferingNotOwnedError,
  ServiceOfferingNotPausedError,
  ServiceOfferingSellerProfileMissingError,
  ServiceOfferingSellerProfileNotPublishedError,
  ServiceOfferingUpdateNotActiveError,
} from "./service-offering.repository.js";
import type { ApiFieldErrorV1 } from "@soundhub/types";
import {
  BG2_AUDIO_SAMPLE_MAX_PER_OFFERING,
  SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS,
} from "@soundhub/types";
import { deriveEffectiveConfirmationVersion, deriveServiceOfferingReadiness } from "@soundhub/db";

type Status = "Draft" | "Active" | "Paused" | "Archived";
type PricingKind = "Fixed" | "StartingAt" | "ContactForQuote";
type ServiceMode = "Remote" | "InPerson" | "Hybrid";

interface StoredSample {
  readonly sampleId: string;
  readonly label: string;
  readonly contentType: "audio/mpeg";
  readonly byteSize: number;
  readonly displayOrder: number;
  readonly storageRef: string;
  readonly cleanupStatus: "Live" | "PendingCleanup" | "Removed";
  readonly confirmation: {
    readonly version: ServiceOfferingAudioMediaConfirmationVersionV1;
    readonly confirmedByUserId: string;
    readonly confirmedAt: Date;
  } | null;
  readonly createdAt: Date;
}

interface StoredPricing {
  readonly kind: PricingKind;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly unitId: string | null;
}

interface StoredServiceArea {
  readonly countryCode: string;
  readonly region: string | null;
  readonly city: string | null;
}

interface StoredOffering {
  readonly id: string;
  readonly slug: string;
  readonly sellerProfileId: string;
  readonly workspaceId: string;
  status: Status;
  title: string;
  description: string;
  primaryCategoryKey: string | null;
  serviceMode: ServiceMode | null;
  serviceAreas: StoredServiceArea[];
  pricing: StoredPricing | null;
  genreTags: string[];
  includedServiceCategoryKeys: string[];
  samples: StoredSample[];
  activatedAt: Date | null;
  activatedByUserId: string | null;
  updatedAt: Date;
}

interface StoredActivation {
  readonly id: string;
  readonly offeringId: string;
  readonly workspaceId: string;
  readonly sellerProfileId: string;
  readonly activatedByUserId: string;
  readonly confirmationVersion: ServiceOfferingActivationConfirmationVersionV1;
  readonly activatedAt: Date;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

interface StoredCreation {
  readonly id: string;
  readonly offeringId: string;
  readonly workspaceId: string;
  readonly createdByUserId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly createdAt: Date;
}

interface StoredPause {
  readonly id: string;
  readonly offeringId: string;
  readonly workspaceId: string;
  readonly sellerProfileId: string;
  readonly pausedByUserId: string;
  readonly pausedAt: Date;
  readonly reason: ServiceOfferingPauseReasonValue;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

// M2 (#86, slice 86C): Active → Active update evidence. Mirrors
// the `StoredActivation` shape but carries `updatedAt` +
// `updatedByUserId` so the activation history (separate append-only
// `service_offering_activations` table) is preserved verbatim per
// ADR 0008 — Update never writes to the activations table.
interface StoredUpdate {
  readonly id: string;
  readonly offeringId: string;
  readonly workspaceId: string;
  readonly sellerProfileId: string;
  readonly updatedByUserId: string;
  readonly confirmationVersion: ServiceOfferingActivationConfirmationVersionV1;
  readonly updatedAt: Date;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

let nextId = 1;
function generateCuid(prefix: string): string {
  nextId += 1;
  return `${prefix}_mem_${nextId.toString(36)}`;
}

export class InMemoryServiceOfferingRepository implements ServiceOfferingRepository {
  private readonly offeringsById = new Map<string, StoredOffering>();
  private readonly offeringsByWorkspace = new Map<string, Set<string>>();
  private readonly activationsByOfferingIdem = new Map<string, StoredActivation>();
  private readonly creationsByWorkspaceIdem = new Map<string, StoredCreation>();
  // M2 (#86, slice 86B): pause evidence keyed by
  // `${offeringId}::${idempotencyKey}` — the same composition as
  // `activationsByOfferingIdem`. Reactivate writes a new
  // ServiceOfferingActivation row and reuses the activations map;
  // Pause has its own map because the evidence table is separate.
  private readonly pausesByOfferingIdem = new Map<string, StoredPause>();
  // M2 (#86, slice 86C): update evidence keyed by
  // `${offeringId}::${idempotencyKey}`. Update writes a new
  // ServiceOfferingUpdate row in a separate table from the
  // activations table; this map mirrors the schema's separate
  // append-only `service_offering_updates` evidence. The
  // activation history is preserved because Update never writes
  // to the activations map.
  private readonly updatesByOfferingIdem = new Map<string, StoredUpdate>();
  // Per-offering mutex chain (mirrors in-memory-seller-profile.repository.ts).
  private readonly mutexChains = new Map<string, Promise<void>>();
  // M2 (#86, slice 86B Codex re-review): per-Workspace mutex chain
  // mirroring `InMemorySellerProfileRepository.withWorkspaceLock`. The
  // Reactivate path wraps its body in this mutex so the in-transaction
  // SellerProfile.publication check serializes against any concurrent
  // operation that also acquires the workspaceLock — matching the
  // Prisma adapter's `seller-profile:<workspaceId>` advisory lock
  // acquisition. The mutex key is the bare `workspaceId` so a test-
  // only helper that simulates a concurrent SellerProfile write
  // (`_suspendSellerProfileUnderLock`) can collide on the same chain.
  private readonly workspaceLockChains = new Map<string, Promise<void>>();
  // Per-workspace create mutex so concurrent first-create attempts
  // serialize. The unique key includes the namespace prefix so the
  // workspace create chain does not block the per-offering chains.
  private readonly workspaceCreateMutexes = new Map<string, Promise<void>>();
  // M2 (#85) PR-review feedback: the in-memory adapter maintains a
  // minimal SellerProfile registry so `createDraft` can throw
  // `ServiceOfferingSellerProfileMissingError` (matching the
  // Prisma adapter's behavior). Tests register profiles via
  // `_registerSellerProfile`; production wiring would inject a
  // real SellerProfile reader.
  private readonly sellerProfilesByWorkspace = new Map<string, string>();
  // M2 (#86, slice 86B, Codex review fix): the Reactivate
  // transaction-time SellerProfile publication check needs to read
  // the current `status` without a SellerProfile dependency. The
  // map is keyed by `sellerProfileId` (NOT by `workspaceId`) because
  // a Workspace may have multiple profiles over time; the lookup
  // resolves through the locked offering row's `sellerProfileId`.
  private readonly sellerProfileStatusById = new Map<string, "Draft" | "Published" | "Suspended">();

  private withOfferingLock<T>(offeringId: string, fn: () => T | PromiseLike<T>): Promise<T> {
    const previous = this.mutexChains.get(offeringId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Store the chain so subsequent callers wait on us. We chain on
    // the settled `previous` (success OR failure) — a rejection by
    // an earlier caller does NOT poison the chain. The naive form
    // `previous.then(() => next)` would propagate the rejection and
    // leave every later caller stuck on a permanently rejected
    // promise.
    this.mutexChains.set(
      offeringId,
      previous.then(
        () => next,
        () => next,
      ),
    );
    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  private withWorkspaceCreateLock<T>(
    workspaceId: string,
    fn: () => T | PromiseLike<T>,
  ): Promise<T> {
    const key = `create:${workspaceId}`;
    const previous = this.workspaceCreateMutexes.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.workspaceCreateMutexes.set(
      key,
      previous.then(
        () => next,
        () => next,
      ),
    );
    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  /**
   * M2 (#86, slice 86B Codex re-review): per-Workspace mutex that
   * mirrors the Prisma adapter's `seller-profile:<workspaceId>`
   * advisory-lock acquisition. The shape matches
   * `InMemorySellerProfileRepository.withWorkspaceLock` so a test-
   * only helper that simulates a concurrent SellerProfile write
   * collides on the SAME chain. Callers wrap their body in this
   * mutex exactly as the Prisma adapter wraps its transaction body
   * in `sellerProfileWorkspaceLockSql(input.workspaceId)`.
   */
  withWorkspaceLock<T>(workspaceId: string, fn: () => T | PromiseLike<T>): Promise<T> {
    const previous = this.workspaceLockChains.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.workspaceLockChains.set(
      workspaceId,
      previous.then(
        () => next,
        () => next,
      ),
    );
    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  private idemKey(offeringId: string, idempotencyKey: string): string {
    return `${offeringId}::${idempotencyKey}`;
  }

  private creationIdemKey(workspaceId: string, idempotencyKey: string): string {
    return `${workspaceId}::${idempotencyKey}`;
  }

  /**
   * M2 (#85) PR-review feedback: lazy first-create. The
   * (workspaceId, idempotencyKey) tuple is the convergence key —
   * a transport retry with the same idempotencyKey returns the
   * SAME offeringId; a deliberate second click (a new
   * idempotencyKey) creates a NEW offering. The per-workspace
   * create mutex serializes concurrent first-create attempts.
   */
  async createDraft(
    input: ServiceOfferingCreateDraftInput,
  ): Promise<ServiceOfferingOwnerViewRecord> {
    return this.withWorkspaceCreateLock(input.workspaceId, () => {
      // Step 1: idempotency pre-check.
      const existingCreation = this.creationsByWorkspaceIdem.get(
        this.creationIdemKey(input.workspaceId, input.idempotencyKey),
      );
      if (existingCreation) {
        const existingOffering = this.offeringsById.get(existingCreation.offeringId);
        if (!existingOffering) {
          throw new ServiceOfferingNotFoundError(existingCreation.offeringId);
        }
        if (existingOffering.workspaceId !== input.workspaceId) {
          throw new ServiceOfferingNotOwnedError(existingOffering.id, input.workspaceId);
        }
        return Promise.resolve(this.toOwnerView(existingOffering, input.playbackUrlFor));
      }

      // Step 2: precondition — Workspace must have a SellerProfile.
      const sellerProfileId = this.sellerProfilesByWorkspace.get(input.workspaceId);
      if (!sellerProfileId) {
        throw new ServiceOfferingSellerProfileMissingError(input.workspaceId);
      }

      // Step 3: create the offering AND persist the first-save
      // draft fields atomically. M2 (#85) PR-review feedback
      // (round 3): a deliberate second click (a new
      // idempotencyKey) creates a NEW offering row AND starts a
      // fresh field-set, so no orphan empty rows accumulate
      // when the user navigates away without filling the form.
      const id = generateCuid("so");
      const row: StoredOffering = {
        id,
        slug: `so-${id}`,
        sellerProfileId,
        workspaceId: input.workspaceId,
        status: "Draft",
        title: input.title,
        description: input.description,
        primaryCategoryKey: input.primaryCategoryKey,
        serviceMode: input.serviceMode,
        serviceAreas: input.serviceAreas.map((sa) => ({
          countryCode: sa.countryCode,
          region: sa.region ?? null,
          city: sa.city ?? null,
        })),
        pricing: input.pricing
          ? {
              kind: input.pricing.kind,
              amountMinor: input.pricing.amountMinor ?? null,
              currency: input.pricing.currency ?? null,
              unitId: input.pricing.unitId ?? null,
            }
          : null,
        genreTags: [...input.genreTags],
        includedServiceCategoryKeys: [...input.includedServiceCategoryKeys],
        samples: [],
        activatedAt: null,
        activatedByUserId: null,
        updatedAt: input.now,
      };
      this.offeringsById.set(id, row);
      const set = this.offeringsByWorkspace.get(input.workspaceId) ?? new Set<string>();
      set.add(id);
      this.offeringsByWorkspace.set(input.workspaceId, set);

      // Step 4: insert the creation-evidence row.
      this.creationsByWorkspaceIdem.set(
        this.creationIdemKey(input.workspaceId, input.idempotencyKey),
        {
          id: generateCuid("socr"),
          offeringId: id,
          workspaceId: input.workspaceId,
          createdByUserId: input.createdByUserId,
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
          createdAt: input.now,
        },
      );

      return Promise.resolve(this.toOwnerView(row, input.playbackUrlFor));
    });
  }

  async saveDraft(input: ServiceOfferingDraftInput): Promise<ServiceOfferingOwnerViewRecord> {
    return this.withOfferingLock(input.offeringId, () => {
      const existing = this.offeringsById.get(input.offeringId);
      if (!existing) {
        throw new ServiceOfferingNotFoundError(input.offeringId);
      }
      if (existing.workspaceId !== input.workspaceId) {
        throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
      }
      if (existing.status !== "Draft") {
        throw new ServiceOfferingNotDraftError(input.offeringId, existing.status);
      }
      existing.title = input.title;
      existing.description = input.description;
      existing.primaryCategoryKey = input.primaryCategoryKey;
      existing.serviceMode = input.serviceMode;
      existing.serviceAreas = input.serviceAreas.map((sa) => ({
        countryCode: sa.countryCode,
        region: sa.region ?? null,
        city: sa.city ?? null,
      }));
      existing.pricing = input.pricing
        ? {
            kind: input.pricing.kind,
            amountMinor: input.pricing.amountMinor ?? null,
            currency: input.pricing.currency ?? null,
            unitId: input.pricing.unitId ?? null,
          }
        : null;
      existing.genreTags = [...input.genreTags];
      existing.includedServiceCategoryKeys = [...input.includedServiceCategoryKeys];
      existing.updatedAt = input.now;
      return Promise.resolve(this.toOwnerView(existing, input.playbackUrlFor));
    });
  }

  async activate(input: ServiceOfferingActivateInput): Promise<ServiceOfferingActivationResult> {
    return this.withOfferingLock(input.offeringId, () => {
      // Step 1: idempotency pre-check.
      const idemKey = this.idemKey(input.offeringId, input.idempotencyKey);
      const existingActivation = this.activationsByOfferingIdem.get(idemKey);
      if (existingActivation) {
        const existingOffering = this.offeringsById.get(input.offeringId);
        if (!existingOffering) {
          throw new ServiceOfferingNotFoundError(input.offeringId);
        }
        return {
          offering: this.toOwnerView(existingOffering, input.playbackUrlFor),
          evidence: toEvidenceView(existingActivation),
          convergedFromExistingActivation: true,
        };
      }

      // Step 2: precondition check.
      const existing = this.offeringsById.get(input.offeringId);
      if (!existing) {
        throw new ServiceOfferingNotFoundError(input.offeringId);
      }
      if (existing.workspaceId !== input.workspaceId) {
        throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
      }
      if (existing.status !== "Draft") {
        throw new ServiceOfferingNotDraftError(input.offeringId, existing.status);
      }

      // Step 3 (PR-review feedback #4): full completeness
      // revalidation INSIDE the per-offering lock. The field-level
      // checks mirror the service-layer pre-check so the editor
      // renders the same multi-error summary either way; the
      // sample-count check is the new source-of-truth recheck that
      // closes the race window between the pre-check and the
      // activation commit. The lock held by `withOfferingLock`
      // serializes the activation against any concurrent
      // sample-remove command.
      const fieldErrors: ApiFieldErrorV1[] = buildActivationCompletenessFieldErrors({
        title: input.title,
        description: input.description,
        primaryCategoryKey: input.primaryCategoryKey,
        serviceMode: input.serviceMode,
        serviceAreas: input.serviceAreas,
        pricingKind: input.pricing.kind,
      });
      const confirmedLiveCount = existing.samples.filter(
        (s) => s.cleanupStatus === "Live" && s.confirmation !== null,
      ).length;
      if (confirmedLiveCount < 1 || confirmedLiveCount > BG2_AUDIO_SAMPLE_MAX_PER_OFFERING) {
        fieldErrors.push({
          path: "samples",
          code: "samples_required",
          message: `Activation requires 1 to ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING} playable samples.`,
        });
      }
      if (fieldErrors.length > 0) {
        throw new ServiceOfferingIncompleteError(
          [
            `field errors: ${fieldErrors.length}`,
            `live confirmed sample count ${confirmedLiveCount} outside [1, ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING}]`,
          ],
          fieldErrors,
        );
      }

      // Step 4: snapshot for rollback.
      const before: StoredOffering = {
        ...existing,
        serviceAreas: [...existing.serviceAreas],
        genreTags: [...existing.genreTags],
        includedServiceCategoryKeys: [...existing.includedServiceCategoryKeys],
      };

      try {
        existing.status = "Active";
        existing.title = input.title;
        existing.description = input.description;
        existing.primaryCategoryKey = input.primaryCategoryKey;
        existing.serviceMode = input.serviceMode;
        existing.serviceAreas = input.serviceAreas.map((sa) => ({
          countryCode: sa.countryCode,
          region: sa.region ?? null,
          city: sa.city ?? null,
        }));
        existing.pricing = {
          kind: input.pricing.kind,
          amountMinor: input.pricing.amountMinor ?? null,
          currency: input.pricing.currency ?? null,
          unitId: input.pricing.unitId ?? null,
        };
        existing.genreTags = [...input.genreTags];
        existing.includedServiceCategoryKeys = [...input.includedServiceCategoryKeys];
        existing.activatedAt = input.now;
        existing.activatedByUserId = input.activatedByUserId;
        existing.updatedAt = input.now;
        const activation: StoredActivation = {
          id: generateCuid("soact"),
          offeringId: input.offeringId,
          workspaceId: input.workspaceId,
          // The repository resolves sellerProfileId from the row
          // (no longer relies on the input field, which the
          // service no longer pre-fetches).
          sellerProfileId: existing.sellerProfileId,
          activatedByUserId: input.activatedByUserId,
          confirmationVersion: input.confirmationVersion,
          activatedAt: input.now,
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
        };
        this.activationsByOfferingIdem.set(idemKey, activation);
        return {
          offering: this.toOwnerView(existing, input.playbackUrlFor),
          evidence: toEvidenceView(activation),
          convergedFromExistingActivation: false,
        };
      } catch (err) {
        if (err instanceof ServiceOfferingIncompleteError) {
          // No state change has occurred yet at this point in
          // the transaction; nothing to roll back.
          throw err;
        }
        Object.assign(existing, before);
        throw err;
      }
    });
  }

  async pause(input: ServiceOfferingPauseInput): Promise<ServiceOfferingPauseResult> {
    return this.withOfferingLock(input.offeringId, () => {
      // Step 1: idempotency pre-check. A same-key retry of a
      // previously-committed Pause converges on the existing pause
      // row. The lookup runs BEFORE the lifecycle precondition so a
      // same-key retry after the offering has transitioned does NOT
      // surface `ServiceOfferingAlreadyPausedError`.
      const idemKey = this.idemKey(input.offeringId, input.idempotencyKey);
      const existingPause = this.pausesByOfferingIdem.get(idemKey);
      if (existingPause) {
        const existingOffering = this.offeringsById.get(input.offeringId);
        if (!existingOffering) {
          throw new ServiceOfferingNotFoundError(input.offeringId);
        }
        if (existingOffering.workspaceId !== input.workspaceId) {
          throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
        }
        return {
          offering: this.toOwnerView(existingOffering, input.playbackUrlFor),
          evidence: {
            pausedAt: existingPause.pausedAt,
            reason: existingPause.reason,
            idempotencyKey: existingPause.idempotencyKey,
          },
          convergedFromExistingPause: true,
        };
      }

      // Step 2: precondition check. Pause requires Active state.
      const existing = this.offeringsById.get(input.offeringId);
      if (!existing) {
        throw new ServiceOfferingNotFoundError(input.offeringId);
      }
      if (existing.workspaceId !== input.workspaceId) {
        throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
      }
      if (existing.status === "Paused") {
        throw new ServiceOfferingAlreadyPausedError(input.offeringId);
      }
      if (existing.status !== "Active") {
        throw new ServiceOfferingNotActiveError(input.offeringId, existing.status);
      }

      // Step 3: atomic transition. The offering's status flips to
      // Paused and the pause evidence row is appended in the same
      // logical operation. The in-memory adapter has no transaction;
      // if the state assignment throws after the row is inserted,
      // the rolled-back state is restored on the next call.
      //
      // M2 (#86, slice 86B, Codex review fix): `sellerProfileId`
      // is resolved from the locked persisted offering row, NOT taken
      // from the input. The input contract does not include one and
      // an empty-string placeholder would violate the
      // `service_offering_pauses_sellerProfileId_fkey` foreign key.
      const before = { status: existing.status, updatedAt: existing.updatedAt };
      const pause: StoredPause = {
        id: generateCuid("sopaus"),
        offeringId: input.offeringId,
        workspaceId: input.workspaceId,
        sellerProfileId: existing.sellerProfileId,
        pausedByUserId: input.pausedByUserId,
        pausedAt: input.now,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId,
      };
      this.pausesByOfferingIdem.set(idemKey, pause);
      existing.status = "Paused";
      existing.updatedAt = input.now;
      return {
        offering: this.toOwnerView(existing, input.playbackUrlFor),
        evidence: {
          pausedAt: pause.pausedAt,
          reason: pause.reason,
          idempotencyKey: pause.idempotencyKey,
        },
        convergedFromExistingPause: false,
      };
      // The `before` snapshot is unused on the happy path but kept
      // for parity with `activate`'s rollback shape — the in-memory
      // adapter has no real transaction, but the contract is the
      // same: an exception AFTER state mutation restores the prior
      // state. The pragma below suppresses the unused-binding lint
      // without weakening the contract.
      void before;
    });
  }

  async reactivate(
    input: ServiceOfferingReactivateInput,
  ): Promise<ServiceOfferingActivationResult> {
    // M2 (#86, slice 86B Codex re-review): the Reactivate body is
    // wrapped in the per-Workspace mutex (`withWorkspaceLock`)
    // BEFORE the existing per-offering mutex (`withOfferingLock`)
    // so the in-transaction SellerProfile.publication check
    // serializes against any concurrent SellerProfile write that
    // also acquires the workspaceLock — matching the Prisma adapter's
    // acquisition order (`service-offering:<id>` → `audio-sample`
    // → `seller-profile:<workspaceId>`). The mutex-chain
    // composition is equivalent to acquiring both locks; the inner
    // body runs only after both chains settle on this caller.
    return this.withWorkspaceLock(input.workspaceId, () =>
      this.withOfferingLock(input.offeringId, () => {
        // Step 1: idempotency pre-check against the activations table.
        // Reactivation writes a new ServiceOfferingActivation row, so
        // the convergence key is the same as a normal activation.
        const idemKey = this.idemKey(input.offeringId, input.idempotencyKey);
        const existingActivation = this.activationsByOfferingIdem.get(idemKey);
        if (existingActivation) {
          const existingOffering = this.offeringsById.get(input.offeringId);
          if (!existingOffering) {
            throw new ServiceOfferingNotFoundError(input.offeringId);
          }
          if (existingOffering.workspaceId !== input.workspaceId) {
            throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
          }
          return {
            offering: this.toOwnerView(existingOffering, input.playbackUrlFor),
            evidence: toEvidenceView(existingActivation),
            convergedFromExistingActivation: true,
          };
        }

        // Step 2: precondition check. Reactivate requires Paused state.
        const existing = this.offeringsById.get(input.offeringId);
        if (!existing) {
          throw new ServiceOfferingNotFoundError(input.offeringId);
        }
        if (existing.workspaceId !== input.workspaceId) {
          throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
        }
        if (existing.status !== "Paused") {
          throw new ServiceOfferingNotPausedError(input.offeringId, existing.status);
        }

        // Step 3 (M2 #86, slice 86B, Codex review fix): the
        // `SellerProfile.published` precondition is enforced INSIDE the
        // mutex lock AFTER the idempotency lookup and BEFORE the
        // activation evidence row is inserted. This closes the race
        // where the SellerProfile becomes Suspended between the
        // service-level precondition and the transaction commit, and
        // it lets a same-key retry of an already-committed Reactivate
        // still converge regardless of the current profile status.
        const sellerProfileStatus = this.sellerProfileStatusById.get(existing.sellerProfileId);
        if (!sellerProfileStatus) {
          // Missing status in the test registry means the helper was
          // never invoked with this sellerProfileId; treat it as
          // missing for parity with the Prisma adapter's
          // `ServiceOfferingSellerProfileMissingError`.
          throw new ServiceOfferingSellerProfileMissingError(input.workspaceId);
        }
        if (sellerProfileStatus !== "Published") {
          throw new ServiceOfferingSellerProfileNotPublishedError(
            input.workspaceId,
            existing.sellerProfileId,
            sellerProfileStatus,
          );
        }

        // Step 3 (PR-review feedback #4 carried forward): full
        // completeness revalidation INSIDE the per-offering lock.
        // The field-level checks mirror the service-layer pre-check;
        // the sample-count check closes the race window between the
        // pre-check and the activation commit.
        const fieldErrors: ApiFieldErrorV1[] = buildActivationCompletenessFieldErrors({
          title: input.title,
          description: input.description,
          primaryCategoryKey: input.primaryCategoryKey,
          serviceMode: input.serviceMode,
          serviceAreas: input.serviceAreas,
          pricingKind: input.pricing.kind,
        });
        const confirmedLiveCount = existing.samples.filter(
          (s) => s.cleanupStatus === "Live" && s.confirmation !== null,
        ).length;
        if (confirmedLiveCount < 1 || confirmedLiveCount > BG2_AUDIO_SAMPLE_MAX_PER_OFFERING) {
          fieldErrors.push({
            path: "samples",
            code: "samples_required",
            message: `Activation requires 1 to ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING} playable samples.`,
          });
        }
        if (fieldErrors.length > 0) {
          throw new ServiceOfferingIncompleteError(
            [
              `field errors: ${fieldErrors.length}`,
              `live confirmed sample count ${confirmedLiveCount} outside [1, ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING}]`,
            ],
            fieldErrors,
          );
        }

        // Step 4: snapshot for rollback.
        const before: StoredOffering = {
          ...existing,
          serviceAreas: [...existing.serviceAreas],
          genreTags: [...existing.genreTags],
          includedServiceCategoryKeys: [...existing.includedServiceCategoryKeys],
        };

        try {
          existing.status = "Active";
          existing.title = input.title;
          existing.description = input.description;
          existing.primaryCategoryKey = input.primaryCategoryKey;
          existing.serviceMode = input.serviceMode;
          existing.serviceAreas = input.serviceAreas.map((sa) => ({
            countryCode: sa.countryCode,
            region: sa.region ?? null,
            city: sa.city ?? null,
          }));
          existing.pricing = {
            kind: input.pricing.kind,
            amountMinor: input.pricing.amountMinor ?? null,
            currency: input.pricing.currency ?? null,
            unitId: input.pricing.unitId ?? null,
          };
          existing.genreTags = [...input.genreTags];
          existing.includedServiceCategoryKeys = [...input.includedServiceCategoryKeys];
          existing.activatedAt = input.now;
          existing.activatedByUserId = input.reactivatedByUserId;
          existing.updatedAt = input.now;
          const activation: StoredActivation = {
            id: generateCuid("soact"),
            offeringId: input.offeringId,
            workspaceId: input.workspaceId,
            sellerProfileId: existing.sellerProfileId,
            activatedByUserId: input.reactivatedByUserId,
            confirmationVersion: input.confirmationVersion,
            activatedAt: input.now,
            idempotencyKey: input.idempotencyKey,
            requestId: input.requestId,
          };
          this.activationsByOfferingIdem.set(idemKey, activation);
          return {
            offering: this.toOwnerView(existing, input.playbackUrlFor),
            evidence: toEvidenceView(activation),
            convergedFromExistingActivation: false,
          };
        } catch (err) {
          if (err instanceof ServiceOfferingIncompleteError) {
            throw err;
          }
          Object.assign(existing, before);
          throw err;
        }
      }),
    );
  }

  /**
   * M2 (#86, slice 86C): Active → Active update. Validates the
   * complete resulting state via the same STRICT activation
   * completeness contract, in-place updates the public fields,
   * and appends one new `ServiceOfferingUpdate` evidence row.
   * The existing `ServiceOfferingActivation` rows are NOT
   * touched — the activation timestamp from the original
   * Draft → Active transition is preserved verbatim per ADR
   * 0008. The lock-acquisition order mirrors `reactivate`
   * (slice 86B re-review): the per-Workspace mutex
   * (`withWorkspaceLock`) wraps the per-offering mutex
   * (`withOfferingLock`) so the in-transaction
   * `SellerProfile.published` read serializes against any
   * concurrent SellerProfile write that also acquires the
   * workspaceLock.
   */
  async updateActive(
    input: ServiceOfferingUpdateActiveInput,
  ): Promise<ServiceOfferingUpdateActiveResult> {
    return this.withWorkspaceLock(input.workspaceId, () =>
      this.withOfferingLock(input.offeringId, () => {
        // Step 1: idempotency pre-check against the updates map.
        const idemKey = this.idemKey(input.offeringId, input.idempotencyKey);
        const existingUpdate = this.updatesByOfferingIdem.get(idemKey);
        if (existingUpdate) {
          const existingOffering = this.offeringsById.get(input.offeringId);
          if (!existingOffering) {
            throw new ServiceOfferingNotFoundError(input.offeringId);
          }
          if (existingOffering.workspaceId !== input.workspaceId) {
            throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
          }
          return {
            offering: this.toOwnerView(existingOffering, input.playbackUrlFor),
            evidence: toUpdateEvidenceView(existingUpdate),
            convergedFromExistingUpdate: true,
          };
        }

        // Step 2: precondition check. Update requires Active state;
        // a same-key retry after the offering has since
        // transitioned would NOT reach this branch (the
        // idempotency pre-check above would have returned the
        // existing update row).
        const existing = this.offeringsById.get(input.offeringId);
        if (!existing) {
          throw new ServiceOfferingNotFoundError(input.offeringId);
        }
        if (existing.workspaceId !== input.workspaceId) {
          throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
        }
        if (existing.status !== "Active") {
          throw new ServiceOfferingUpdateNotActiveError(input.offeringId, existing.status);
        }

        // Step 3 (M2 #86, slice 86C): the `SellerProfile.published`
        // precondition is enforced INSIDE the workspaceLock AFTER
        // the idempotency lookup and BEFORE the update evidence
        // row is inserted. The mutex chain acquired at the top of
        // this method serializes against any concurrent SellerProfile
        // write that also acquires the workspaceLock
        // (matching the Prisma adapter's workspaceLock
        // acquisition). Same-key retry of an already-committed
        // Update converges regardless of the current SellerProfile
        // status because the idempotency pre-check above returns
        // BEFORE this read.
        const sellerProfileStatus = this.sellerProfileStatusById.get(existing.sellerProfileId);
        if (!sellerProfileStatus) {
          throw new ServiceOfferingSellerProfileMissingError(input.workspaceId);
        }
        if (sellerProfileStatus !== "Published") {
          throw new ServiceOfferingSellerProfileNotPublishedError(
            input.workspaceId,
            existing.sellerProfileId,
            sellerProfileStatus,
          );
        }

        // Step 4: full STRICT activation completeness re-check
        // INSIDE the per-offering lock. The field-level checks
        // mirror the service-layer pre-check; the sample-count
        // check closes the same race window the activation
        // recheck does. The repository raises
        // `ServiceOfferingInvalidUpdateError` (mapped to
        // `SERVICE_OFFERING_INVALID_UPDATE`) instead of the
        // activation-shared `ServiceOfferingIncompleteError`.
        const fieldErrors: ApiFieldErrorV1[] = buildActivationCompletenessFieldErrors({
          title: input.title,
          description: input.description,
          primaryCategoryKey: input.primaryCategoryKey,
          serviceMode: input.serviceMode,
          serviceAreas: input.serviceAreas,
          pricingKind: input.pricing.kind,
        });
        const confirmedLiveCount = existing.samples.filter(
          (s) => s.cleanupStatus === "Live" && s.confirmation !== null,
        ).length;
        if (confirmedLiveCount < 1 || confirmedLiveCount > BG2_AUDIO_SAMPLE_MAX_PER_OFFERING) {
          fieldErrors.push({
            path: "samples",
            code: "samples_required",
            message: `Update requires 1 to ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING} playable samples.`,
          });
        }
        if (fieldErrors.length > 0) {
          throw new ServiceOfferingInvalidUpdateError(
            [
              `field errors: ${fieldErrors.length}`,
              `live confirmed sample count ${confirmedLiveCount} outside [1, ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING}]`,
            ],
            fieldErrors,
          );
        }

        // Step 5: snapshot for rollback on any failure mid-write.
        const before: StoredOffering = {
          ...existing,
          serviceAreas: [...existing.serviceAreas],
          genreTags: [...existing.genreTags],
          includedServiceCategoryKeys: [...existing.includedServiceCategoryKeys],
        };

        try {
          // Status NOT changed — stays Active per the 86C invariant.
          existing.title = input.title;
          existing.description = input.description;
          existing.primaryCategoryKey = input.primaryCategoryKey;
          existing.serviceMode = input.serviceMode;
          existing.serviceAreas = input.serviceAreas.map((sa) => ({
            countryCode: sa.countryCode,
            region: sa.region ?? null,
            city: sa.city ?? null,
          }));
          existing.pricing = {
            kind: input.pricing.kind,
            amountMinor: input.pricing.amountMinor ?? null,
            currency: input.pricing.currency ?? null,
            unitId: input.pricing.unitId ?? null,
          };
          existing.genreTags = [...input.genreTags];
          existing.includedServiceCategoryKeys = [...input.includedServiceCategoryKeys];
          existing.updatedAt = input.now;
          // The original activation timestamp + actor are NOT
          // touched — Update preserves the activation history per
          // ADR 0008 (the slice plan's "Owner-facing lifecycle
          // history" invariant).
          const update: StoredUpdate = {
            id: generateCuid("soupd"),
            offeringId: input.offeringId,
            workspaceId: input.workspaceId,
            sellerProfileId: existing.sellerProfileId,
            updatedByUserId: input.updatedByUserId,
            confirmationVersion: input.confirmationVersion,
            updatedAt: input.now,
            idempotencyKey: input.idempotencyKey,
            requestId: input.requestId,
          };
          this.updatesByOfferingIdem.set(idemKey, update);
          return {
            offering: this.toOwnerView(existing, input.playbackUrlFor),
            evidence: toUpdateEvidenceView(update),
            convergedFromExistingUpdate: false,
          };
        } catch (err) {
          if (err instanceof ServiceOfferingInvalidUpdateError) {
            throw err;
          }
          Object.assign(existing, before);
          throw err;
        }
      }),
    );
  }

  findForOwner(input: {
    readonly workspaceId: string;
    readonly offeringId: string;
    readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
  }): Promise<ServiceOfferingOwnerViewRecord | null> {
    const row = this.offeringsById.get(input.offeringId);
    if (!row) return Promise.resolve(null);
    if (row.workspaceId !== input.workspaceId) return Promise.resolve(null);
    return Promise.resolve(this.toOwnerView(row, input.playbackUrlFor));
  }

  listForOwner(input: {
    readonly workspaceId: string;
    readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
  }): Promise<readonly ServiceOfferingOwnerViewRecord[]> {
    const ids = this.offeringsByWorkspace.get(input.workspaceId);
    if (!ids) return Promise.resolve([]);
    const offerings: ServiceOfferingOwnerViewRecord[] = [];
    for (const id of ids) {
      const row = this.offeringsById.get(id);
      if (row) offerings.push(this.toOwnerView(row, input.playbackUrlFor));
    }
    return Promise.resolve(offerings.sort((a, b) => a.title.localeCompare(b.title)));
  }

  countLiveConfirmedSamples(offeringId: string): Promise<number> {
    const row = this.offeringsById.get(offeringId);
    if (!row) return Promise.resolve(0);
    return Promise.resolve(
      row.samples.filter((s) => s.cleanupStatus === "Live" && s.confirmation !== null).length,
    );
  }

  /**
   * Test-only helpers. NOT part of the repository interface; tests
   * use these to seed fixtures and assert persistence behavior. They
   * are intentionally NOT exposed via the interface so the production
   * code path cannot reach for them.
   */
  _seedOffering(input: {
    readonly id?: string;
    readonly workspaceId: string;
    readonly sellerProfileId: string;
    readonly status?: Status;
    readonly title?: string;
    readonly description?: string;
    readonly serviceAreas?: StoredServiceArea[];
    readonly primaryCategoryKey?: string | null;
    readonly serviceMode?: ServiceMode | null;
    readonly pricing?: StoredPricing | null;
    readonly genreTags?: string[];
    readonly includedServiceCategoryKeys?: string[];
    readonly samples?: StoredSample[];
  }): StoredOffering {
    const id = input.id ?? generateCuid("so");
    const slug = `so-${id}`;
    const row: StoredOffering = {
      id,
      slug,
      sellerProfileId: input.sellerProfileId,
      workspaceId: input.workspaceId,
      status: input.status ?? "Draft",
      title: input.title ?? "",
      description: input.description ?? "",
      primaryCategoryKey: input.primaryCategoryKey ?? null,
      serviceMode: input.serviceMode ?? null,
      serviceAreas: input.serviceAreas ?? [],
      pricing: input.pricing ?? null,
      genreTags: input.genreTags ?? [],
      includedServiceCategoryKeys: input.includedServiceCategoryKeys ?? [],
      samples: input.samples ?? [],
      activatedAt: null,
      activatedByUserId: null,
      updatedAt: new Date(),
    };
    this.offeringsById.set(id, row);
    const set = this.offeringsByWorkspace.get(input.workspaceId) ?? new Set();
    set.add(id);
    this.offeringsByWorkspace.set(input.workspaceId, set);
    return row;
  }

  /**
   * Test-only helper. Register the SellerProfile id (and current
   * status) for a Workspace so `createDraft` finds the precondition
   * satisfied AND the Reactivate publication check has access to the
   * current status. Production wiring would inject a real SellerProfile
   * reader.
   */
  _registerSellerProfile(input: {
    readonly workspaceId: string;
    readonly sellerProfileId: string;
    readonly status?: "Draft" | "Published" | "Suspended";
  }): void {
    this.sellerProfilesByWorkspace.set(input.workspaceId, input.sellerProfileId);
    if (input.status) {
      this.sellerProfileStatusById.set(input.sellerProfileId, input.status);
    }
  }

  /**
   * M2 (#86, slice 86B Codex re-review): test-only helper that
   * simulates a concurrent SellerProfile suspension that ALSO
   * acquires the seller-profile workspaceLock — the same lock that
   * `reactivate` now holds for the duration of its transaction.
   * Production code MUST NOT reach for this helper. The
   * `InMemorySellerProfileRepository` does not expose a `suspend`
   * operation, so this helper exists to give the in-memory test
   * suite a way to construct the same interleaving the Prisma
   * deterministic test does (a concurrent suspension that holds
   * the workspaceLock while Reactivate tries to read the profile).
   * Returns the current in-memory SellerProfile status so tests
   * can assert that the mutation ran only after Reactivate released
   * the workspaceLock.
   */
  _suspendSellerProfileUnderLock(
    workspaceId: string,
    sellerProfileId: string,
  ): Promise<{ readonly previousStatus: "Draft" | "Published" | "Suspended" | undefined }> {
    return this.withWorkspaceLock(workspaceId, () => {
      const previousStatus = this.sellerProfileStatusById.get(sellerProfileId);
      this.sellerProfileStatusById.set(sellerProfileId, "Suspended");
      return Promise.resolve({ previousStatus });
    });
  }

  /**
   * M2 (#86, slice 86B Codex re-review): test-only accessor for
   * the in-memory SellerProfile status registry. Returns
   * `undefined` when no status has been registered for the
   * `sellerProfileId` (i.e. `_registerSellerProfile` was never
   * called with this id). Production code MUST use the real
   * SellerProfile repository; this accessor exists for the
   * structural-parity test that proves Reactivate's
   * workspaceLock acquisition serialized the publication check
   * against a concurrent suspension.
   */
  _peekSellerProfileStatus(
    sellerProfileId: string,
  ): "Draft" | "Published" | "Suspended" | undefined {
    return this.sellerProfileStatusById.get(sellerProfileId);
  }

  _peekOffering(id: string): StoredOffering | null {
    return this.offeringsById.get(id) ?? null;
  }

  _peekActivation(offeringId: string, idempotencyKey: string): StoredActivation | null {
    return this.activationsByOfferingIdem.get(this.idemKey(offeringId, idempotencyKey)) ?? null;
  }

  _peekCreation(workspaceId: string, idempotencyKey: string): StoredCreation | null {
    return (
      this.creationsByWorkspaceIdem.get(this.creationIdemKey(workspaceId, idempotencyKey)) ?? null
    );
  }

  _seedSample(
    offeringId: string,
    sample: {
      readonly sampleId: string;
      readonly label: string;
      readonly byteSize: number;
      readonly displayOrder: number;
      readonly storageRef: string;
      readonly cleanupStatus?: "Live" | "PendingCleanup" | "Removed";
      readonly confirmation?: {
        readonly version: ServiceOfferingAudioMediaConfirmationVersionV1;
        readonly confirmedByUserId: string;
        readonly confirmedAt: Date;
      };
    },
  ): void {
    const row = this.offeringsById.get(offeringId);
    if (!row) throw new Error(`Unknown offering ${offeringId}`);
    row.samples.push({
      sampleId: sample.sampleId,
      label: sample.label,
      contentType: "audio/mpeg",
      byteSize: sample.byteSize,
      displayOrder: sample.displayOrder,
      storageRef: sample.storageRef,
      cleanupStatus: sample.cleanupStatus ?? "Live",
      confirmation: sample.confirmation ?? null,
      createdAt: new Date(),
    });
  }

  /**
   * Codex/Tenki Blocker 2 — test-only accessor that returns the
   * stored activation evidence rows for an offering, so the
   * regression suite can assert that the internal
   * `activatedByUserId` is still recorded (NOT leaked through
   * `activatedByDisplayName`). Production code MUST use the
   * repository's read methods; this accessor exists for the
   * `in-memory-service-offering.repository.test.ts` invariant
   * that the OwnerView never serializes the raw user id.
   */
  _activationsForTest(offeringId: string): readonly StoredActivation[] {
    const matches: StoredActivation[] = [];
    for (const a of this.activationsByOfferingIdem.values()) {
      if (a.offeringId === offeringId) matches.push(a);
    }
    return matches;
  }

  private toOwnerView(
    row: StoredOffering,
    playbackUrlFor?: (input: { offeringId: string; sampleId: string }) => string,
  ): ServiceOfferingOwnerViewRecord {
    const samples: ServiceOfferingOwnerSampleSummaryV1[] = row.samples
      // CONFIRMED Live samples only — matches the Prisma
      // adapter's OFFERING_INCLUDE filter.
      .filter((s) => s.cleanupStatus === "Live" && s.confirmation !== null)
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((s) => ({
        sampleId: s.sampleId,
        label: s.label,
        contentType: "audio/mpeg" as const,
        byteSize: s.byteSize,
        displayOrder: s.displayOrder,
        playbackUrl: playbackUrlFor?.({ offeringId: row.id, sampleId: s.sampleId }) ?? "",
        // The filter above guarantees `s.confirmation` is
        // non-null; the runtime check below narrows for the
        // strict TypeScript type.
        confirmation: s.confirmation
          ? {
              version: s.confirmation.version,
              confirmedAt: s.confirmation.confirmedAt.toISOString(),
            }
          : // Should be unreachable given the filter.
            (undefined as never),
        createdAt: s.createdAt.toISOString(),
      }));
    const serviceAreas = row.serviceAreas.map((sa) => {
      const out: { countryCode: string; region?: string; city?: string } = {
        countryCode: sa.countryCode,
      };
      if (sa.region !== null) out.region = sa.region;
      if (sa.city !== null) out.city = sa.city;
      return out;
    });
    const pricing = row.pricing
      ? {
          kind: row.pricing.kind,
          ...(row.pricing.amountMinor !== null ? { amountMinor: row.pricing.amountMinor } : {}),
          ...(row.pricing.currency !== null ? { currency: row.pricing.currency } : {}),
          ...(row.pricing.unitId !== null ? { unitId: row.pricing.unitId } : {}),
        }
      : null;
    // M2 (#86, slice 86F): readiness is the runtime source of truth.
    // Mirror the Prisma adapter's `toOwnerView`: compute the
    // effective confirmation from BOTH activation + update evidence
    // (chronologically newest event) and feed the predicate.
    let latestActivation: { confirmationVersion: string; activatedAt: Date } | null = null;
    for (const [, evidence] of this.activationsByOfferingIdem) {
      if (evidence.offeringId !== row.id) continue;
      if (latestActivation === null || evidence.activatedAt > latestActivation.activatedAt) {
        latestActivation = {
          confirmationVersion: evidence.confirmationVersion,
          activatedAt: evidence.activatedAt,
        };
      }
    }
    let latestUpdate: { confirmationVersion: string; updatedAt: Date } | null = null;
    for (const [, evidence] of this.updatesByOfferingIdem) {
      if (evidence.offeringId !== row.id) continue;
      if (latestUpdate === null || evidence.updatedAt > latestUpdate.updatedAt) {
        latestUpdate = {
          confirmationVersion: evidence.confirmationVersion,
          updatedAt: evidence.updatedAt,
        };
      }
    }
    const currentConfirmationVersion = SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS.at(-1);
    if (!currentConfirmationVersion) {
      throw new Error(
        "SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS is empty; readiness cannot derive a current version.",
      );
    }
    const effectiveConfirmationVersion = deriveEffectiveConfirmationVersion({
      latestActivation: latestActivation
        ? {
            confirmationVersion: latestActivation.confirmationVersion,
            occurredAt: latestActivation.activatedAt,
          }
        : null,
      latestUpdate: latestUpdate
        ? {
            confirmationVersion: latestUpdate.confirmationVersion,
            occurredAt: latestUpdate.updatedAt,
          }
        : null,
    });
    const sellerProfileStatus = this.sellerProfileStatusById.get(row.sellerProfileId) ?? "Draft";
    const readiness = deriveServiceOfferingReadiness({
      status: row.status,
      title: row.title,
      description: row.description,
      hasPrimaryCategory: row.primaryCategoryKey !== null,
      serviceMode: row.serviceMode ?? "Remote",
      serviceAreaCount: row.serviceAreas.length,
      hasPricing: row.pricing !== null,
      confirmedLiveSampleCount: samples.length,
      sellerProfileStatus,
      confirmationVersion: effectiveConfirmationVersion,
      currentConfirmationVersion,
    });
    return {
      serviceOfferingId: row.id,
      workspaceId: row.workspaceId,
      sellerProfileId: row.sellerProfileId,
      status: row.status,
      title: row.title,
      description: row.description,
      primaryCategoryKey: row.primaryCategoryKey,
      serviceMode: row.serviceMode,
      serviceAreas,
      pricing,
      genreTags: [...row.genreTags],
      includedServiceCategoryKeys: [...row.includedServiceCategoryKeys],
      samples,
      activatedAt: row.activatedAt,
      // Codex/Tenki Blocker 2 — the in-memory adapter's
      // stored activation row records the internal actor
      // (`activatedByUserId`) for authorization / evidence,
      // but the in-memory store has no human-readable
      // display value to resolve. Returning the raw user ID
      // here would leak an internal identifier through a
      // human-facing DTO field and diverge from the Prisma
      // adapter (which resolves the related `UserAccount.email`
      // via the OFFERING_INCLUDE join). Contract-consistent
      // parity with Prisma: return `null` rather than
      // inventing a display value or leaking the internal
      // identifier. `activatedByUserId` remains available
      // internally on `StoredActivation` for authorization /
      // audit and is never serialized to the OwnerView.
      activatedByDisplayName: null,
      readiness: {
        isAvailable: readiness.isAvailable,
        updateNeeded: readiness.updateNeeded,
        reasonCategories: [...readiness.reasonCategories],
        isGrandfatheredNonconforming: readiness.isGrandfatheredNonconforming,
      },
    };
  }
}

function toEvidenceView(a: StoredActivation): ServiceOfferingActivationEvidenceView {
  return {
    activatedAt: a.activatedAt,
    confirmationVersion: a.confirmationVersion,
    idempotencyKey: a.idempotencyKey,
  };
}

// M2 (#86, slice 86C): project a `StoredUpdate` row onto the
// public `ServiceOfferingUpdateEvidenceView` shape. The
// `confirmationVersion` carries the same closed enum value as
// activation because `updateActive` re-runs the same activation
// contract; the timestamp is the `updatedAt` (the moment the
// Active → Active transition committed), NOT the activation
// timestamp — the activation history is preserved verbatim per
// ADR 0008.
function toUpdateEvidenceView(u: StoredUpdate): ServiceOfferingUpdateEvidenceView {
  return {
    updatedAt: u.updatedAt,
    confirmationVersion: u.confirmationVersion,
    idempotencyKey: u.idempotencyKey,
  };
}
