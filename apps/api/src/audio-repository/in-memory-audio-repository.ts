// In-memory AudioRepository for service-level unit tests.
//
// Mirrors the Prisma adapter's contract surface so the application
// service tests can exercise every authorization and limit branch
// without a database. The repository is intentionally simple — the
// Prisma adapter is the canonical implementation.

import { randomUUID } from "node:crypto";
import type {
  AudioOfferingContext,
  AudioRepository,
  AudioSampleCleanupStatus,
  AudioSampleConfirmation,
  AudioSampleRecord,
} from "./audio-repository.js";
import { AudioSampleFinalRemovalNotApplicableError } from "./audio-repository.js";

export interface InMemoryAudioFixture {
  readonly offerings?: readonly InMemoryAudioOffering[];
  readonly samples?: readonly InMemoryAudioSampleSeed[];
}

export interface InMemoryAudioOffering {
  readonly offeringId: string;
  readonly offeringStatus: AudioOfferingContext["offeringStatus"];
  readonly sellerProfileStatus: AudioOfferingContext["sellerProfileStatus"];
  readonly sellerWorkspaceId: string;
  readonly sellerWorkspaceStatus: AudioOfferingContext["sellerWorkspaceStatus"];
  readonly hasSellerCapability: boolean;
  readonly title: string;
}

export interface InMemoryAudioSampleSeed {
  readonly sampleId?: string;
  readonly offeringId: string;
  readonly label: string;
  readonly byteSize: number;
  readonly displayOrder: number;
  readonly storageRef: string;
  readonly cleanupStatus?: AudioSampleCleanupStatus;
  readonly cleanupAttempts?: number;
  readonly confirmation?: AudioSampleConfirmation;
}

export class InMemoryAudioRepository implements AudioRepository {
  private readonly contexts = new Map<string, AudioOfferingContext>();
  private readonly samples = new Map<string, AudioSampleRecord & { readonly _seeded?: boolean }>();
  // M2 (#86, slice 86D): tracking the offering's lifecycle status
  // + the append-only Pause evidence rows so the in-memory
  // `removeFinalSamplePendingCleanup` mirror can verify preconditions
  // and persist a deterministic Pause row keyed by the same
  // `(offeringId, idempotencyKey)` unique constraint the Prisma
  // adapter enforces. The in-memory adapter is a test seam only;
  // production wiring always uses the Prisma adapter.
  private readonly offeringStatusById = new Map<string, AudioOfferingContext["offeringStatus"]>();
  private readonly pauseEvidenceByOfferingIdem = new Map<
    string,
    {
      readonly offeringId: string;
      readonly workspaceId: string;
      readonly sellerProfileId: string;
      readonly pausedByUserId: string;
      readonly pausedAt: Date;
      readonly reason: "user_initiated" | "final_sample_removal";
      readonly idempotencyKey: string;
      readonly requestId: string;
    }
  >();

  constructor(fixture: InMemoryAudioFixture = {}) {
    for (const offering of fixture.offerings ?? []) {
      this.contexts.set(offering.offeringId, {
        offeringId: offering.offeringId,
        offeringStatus: offering.offeringStatus,
        sellerProfileStatus: offering.sellerProfileStatus,
        sellerWorkspaceId: offering.sellerWorkspaceId,
        sellerWorkspaceStatus: offering.sellerWorkspaceStatus,
        hasSellerCapability: offering.hasSellerCapability,
        title: offering.title,
      });
      // M2 (#86, slice 86D): mirror the offering's lifecycle status
      // so the in-memory `removeFinalSamplePendingCleanup` path can
      // transition it. The Prisma adapter reads this from
      // `service_offerings.status` directly.
      this.offeringStatusById.set(offering.offeringId, offering.offeringStatus);
    }
    for (const seed of fixture.samples ?? []) {
      const id = seed.sampleId ?? `smp-${randomUUID().slice(0, 12)}`;
      const now = new Date();
      this.samples.set(id, {
        sampleId: id,
        offeringId: seed.offeringId,
        label: seed.label,
        contentType: "audio/mpeg",
        byteSize: seed.byteSize,
        displayOrder: seed.displayOrder,
        storageRef: seed.storageRef,
        cleanupStatus: seed.cleanupStatus ?? "Live",
        cleanupAttempts: seed.cleanupAttempts ?? 0,
        confirmation: seed.confirmation ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  getOfferingContext(offeringId: string): Promise<AudioOfferingContext | null> {
    const original = this.contexts.get(offeringId);
    if (!original) return Promise.resolve(null);
    // M2 (#86, slice 86D Codex re-review): the `contexts` map
    // captures the seeded status; the lifecycle mirror
    // (`offeringStatusById`) tracks the post-transition status
    // (final-sample removal transitions Active → Paused). Read
    // the mirror as the authoritative post-transition status so
    // downstream consumers (e.g. the audio sample service's
    // "is this the last Live sample?" check on a replacement
    // upload after final removal) observe the Paused state and
    // do not auto-reactivate the offering. Without this, a
    // replacement upload would see Active and the new sample
    // would become buyer-visible, violating the issue #86
    // cross-slice invariant "A replacement sample uploaded while
    // Paused never auto-reactivates the offering."
    const status = this.offeringStatusById.get(offeringId) ?? original.offeringStatus;
    return Promise.resolve({
      ...original,
      offeringStatus: status,
    });
  }

  listSamplesForOffering(offeringId: string): Promise<readonly AudioSampleRecord[]> {
    return Promise.resolve(
      [...this.samples.values()]
        .filter((s) => s.offeringId === offeringId && s.cleanupStatus === "Live")
        .sort((a, b) => {
          if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
          return a.createdAt.getTime() - b.createdAt.getTime();
        }),
    );
  }

  /**
   * Atomic guarded insert mirroring the Prisma adapter's
   * transaction. JavaScript is single-threaded so the count +
   * insert pair is implicitly serialized; the cap is enforced
   * before display-order allocation. The seller-side upload
   * boundary requires a closed-version media-use confirmation;
   * the in-memory adapter stores it directly on the record so
   * the activation completeness recheck reads the same field the
   * Prisma adapter persists.
   */
  createSampleWithCap(input: {
    offeringId: string;
    label: string;
    contentType: "audio/mpeg";
    byteSize: number;
    storageRef: string;
    confirmation: AudioSampleConfirmation;
  }): Promise<AudioSampleRecord | null> {
    const liveRows = [...this.samples.values()].filter(
      (s) => s.offeringId === input.offeringId && s.cleanupStatus === "Live",
    );
    if (liveRows.length >= 3) return Promise.resolve(null);
    const taken = new Set(liveRows.map((r) => r.displayOrder));
    let displayOrder: number | null = null;
    for (let candidate = 1; candidate <= 1024; candidate += 1) {
      if (!taken.has(candidate)) {
        displayOrder = candidate;
        break;
      }
    }
    if (displayOrder === null) return Promise.resolve(null);
    const id = `smp-${randomUUID().slice(0, 12)}`;
    const now = new Date();
    const record: AudioSampleRecord = {
      sampleId: id,
      offeringId: input.offeringId,
      label: input.label,
      contentType: input.contentType,
      byteSize: input.byteSize,
      displayOrder,
      storageRef: input.storageRef,
      cleanupStatus: "Live",
      cleanupAttempts: 0,
      confirmation: input.confirmation,
      createdAt: now,
      updatedAt: now,
    };
    this.samples.set(id, record);
    return Promise.resolve(record);
  }

  findSampleById(input: {
    offeringId: string;
    sampleId: string;
  }): Promise<AudioSampleRecord | null> {
    const sample = this.samples.get(input.sampleId);
    if (!sample) return Promise.resolve(null);
    if (sample.offeringId !== input.offeringId) return Promise.resolve(null);
    return Promise.resolve(sample);
  }

  markPendingCleanup(input: { offeringId: string; sampleId: string }): Promise<void> {
    const sample = this.samples.get(input.sampleId);
    if (!sample) return Promise.resolve();
    if (sample.offeringId !== input.offeringId) return Promise.resolve();
    if (sample.cleanupStatus !== "Live") return Promise.resolve();
    const now = new Date();
    this.samples.set(input.sampleId, {
      ...sample,
      cleanupStatus: "PendingCleanup",
      cleanupAttempts: sample.cleanupAttempts + 1,
      updatedAt: now,
    });
    return Promise.resolve();
  }

  finalizePendingCleanup(input: { offeringId: string; sampleId: string }): Promise<void> {
    const sample = this.samples.get(input.sampleId);
    if (!sample) return Promise.resolve();
    if (sample.offeringId !== input.offeringId) return Promise.resolve();
    if (sample.cleanupStatus !== "PendingCleanup" && sample.cleanupStatus !== "Live") {
      return Promise.resolve();
    }
    this.samples.delete(input.sampleId);
    return Promise.resolve();
  }

  listPendingCleanupForOffering(offeringId: string): Promise<readonly AudioSampleRecord[]> {
    return Promise.resolve(
      [...this.samples.values()]
        .filter((s) => s.offeringId === offeringId && s.cleanupStatus === "PendingCleanup")
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime()),
    );
  }

  private readonly orphans = new Map<
    string,
    {
      storageRef: string;
      offeringId: string;
      cleanupAttempts: number;
      updatedAt: Date;
    }
  >();

  async recordOrphanedStorage(input: { offeringId: string; storageRef: string }): Promise<void> {
    this.orphans.set(input.storageRef, {
      storageRef: input.storageRef,
      offeringId: input.offeringId,
      cleanupAttempts: 0,
      updatedAt: new Date(),
    });
    return Promise.resolve();
  }

  async listOrphanedStorageForOffering(
    offeringId: string,
  ): Promise<readonly { readonly storageRef: string; readonly cleanupAttempts: number }[]> {
    return Promise.resolve(
      [...this.orphans.values()]
        .filter((o) => o.offeringId === offeringId)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .map((o) => ({ storageRef: o.storageRef, cleanupAttempts: o.cleanupAttempts })),
    );
  }

  async removeOrphanedStorage(storageRef: string): Promise<void> {
    this.orphans.delete(storageRef);
    return Promise.resolve();
  }

  /**
   * Test-only helper: seed a Live sample whose `confirmation` is
   * null, simulating a legacy sample persisted before the M2
   * migration. Used by the round-2 PR-review feedback test that
   * proves the public buyer-side list does not crash on a
   * grandfathered sample.
   */
  _seedLegacyLiveSample(input: {
    readonly offeringId: string;
    readonly sampleId: string;
    readonly label: string;
    readonly byteSize: number;
    readonly displayOrder: number;
    readonly storageRef: string;
  }): void {
    if (this.samples.has(input.sampleId)) {
      throw new Error(`Sample ${input.sampleId} already exists in the in-memory store`);
    }
    const now = new Date();
    this.samples.set(input.sampleId, {
      sampleId: input.sampleId,
      offeringId: input.offeringId,
      label: input.label,
      contentType: "audio/mpeg",
      byteSize: input.byteSize,
      displayOrder: input.displayOrder,
      storageRef: input.storageRef,
      cleanupStatus: "Live",
      cleanupAttempts: 0,
      confirmation: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * M2 (#86, slice 86D): in-memory mirror of the Prisma adapter's
   * `removeFinalSamplePendingCleanup`. The in-memory adapter has
   * no real advisory locks — the test-only helper verifies the
   * preconditions + transitions the offering + marks the sample
   * PendingCleanup + appends a Pause evidence row, in the same
   * observable order the Prisma adapter commits them. The
   * `(offeringId, idempotencyKey)` uniqueness is enforced by the
   * `pauseEvidenceByOfferingIdem` Map's key.
   */
  removeFinalSamplePendingCleanup(input: {
    offeringId: string;
    sampleId: string;
    workspaceId: string;
    pausedByUserId: string;
    idempotencyKey: string;
    requestId: string;
    now: Date;
  }): Promise<{
    readonly offeringStatus: "Paused";
    readonly sample: AudioSampleRecord;
  }> {
    return Promise.resolve().then(
      (): {
        readonly offeringStatus: "Paused";
        readonly sample: AudioSampleRecord;
      } => {
        // Idempotency pre-check on the pause-evidence table.
        const pauseKey = `${input.offeringId}::${input.idempotencyKey}`;
        const existingPause = this.pauseEvidenceByOfferingIdem.get(pauseKey);
        if (existingPause) {
          if (existingPause.reason !== "final_sample_removal") {
            throw new AudioSampleFinalRemovalNotApplicableError("offering_not_active");
          }
          const marked = this.samples.get(input.sampleId);
          if (!marked) {
            throw new AudioSampleFinalRemovalNotApplicableError("sample_not_found");
          }
          return { offeringStatus: "Paused" as const, sample: marked };
        }

        // Step 1: precondition — offering must be Active.
        const offeringStatus = this.offeringStatusById.get(input.offeringId);
        if (!offeringStatus) {
          throw new AudioSampleFinalRemovalNotApplicableError("offering_not_found");
        }
        if (offeringStatus !== "Active") {
          throw new AudioSampleFinalRemovalNotApplicableError("offering_not_active");
        }

        // Step 2: precondition — sample must exist and be Live.
        const sample = this.samples.get(input.sampleId);
        if (!sample || sample.offeringId !== input.offeringId) {
          throw new AudioSampleFinalRemovalNotApplicableError("sample_not_found");
        }
        if (sample.cleanupStatus !== "Live") {
          throw new AudioSampleFinalRemovalNotApplicableError("sample_not_live");
        }

        // Step 3: precondition — sample must be the LAST CONFIRMED
        // Live sample. CONFIRMED = confirmationVersion/By/At all set
        // (matching the Prisma adapter's filter).
        let liveConfirmedCount = 0;
        for (const s of this.samples.values()) {
          if (
            s.offeringId === input.offeringId &&
            s.cleanupStatus === "Live" &&
            s.confirmation !== null
          ) {
            liveConfirmedCount += 1;
          }
        }
        if (liveConfirmedCount !== 1) {
          throw new AudioSampleFinalRemovalNotApplicableError("not_last_live_sample");
        }

        // Step 4: atomic transition. The offering transitions to
        // Paused, a Pause evidence row is appended, the sample is
        // marked PendingCleanup — all observable in this single
        // synchronous block (the in-memory adapter has no real
        // transaction but mirrors the Prisma adapter's commit
        // order so observable behavior matches).
        this.offeringStatusById.set(input.offeringId, "Paused");
        const context = this.contexts.get(input.offeringId);
        const sellerProfileId = "sp-mirror"; // Mirror only; tests register profiles via ServiceOfferingRepository._registerSellerProfile.
        this.pauseEvidenceByOfferingIdem.set(pauseKey, {
          offeringId: input.offeringId,
          workspaceId: input.workspaceId,
          sellerProfileId,
          pausedByUserId: input.pausedByUserId,
          pausedAt: input.now,
          reason: "final_sample_removal",
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
        });
        const markedSample: AudioSampleRecord = {
          ...sample,
          cleanupStatus: "PendingCleanup",
          cleanupAttempts: sample.cleanupAttempts + 1,
          updatedAt: input.now,
        };
        this.samples.set(input.sampleId, markedSample);
        // The contexts map is keyed by AudioOfferingContext; the
        // offeringStatus change is reflected through `offeringStatusById`.
        // The next `getOfferingContext` read returns the new status
        // because the constructor mirrors `offering.offeringStatus`
        // into both maps.
        void context;
        return {
          offeringStatus: "Paused" as const,
          sample: markedSample,
        };
      },
    );
  }

  /**
   * M2 (#86, slice 86D Codex re-review): in-memory mirror of the
   * Prisma adapter's read-only lookup. Reads
   * `pauseEvidenceByOfferingIdem` and returns the row only when
   * its `reason === "final_sample_removal"`; returns `null`
   * otherwise. Used by the application service to converge
   * retries after provider-side cleanup finalized the sample
   * row (the durable Pause evidence row is still present).
   */
  findFinalSampleRemovalPauseEvidence(input: {
    offeringId: string;
    idempotencyKey: string;
  }): Promise<{
    readonly offeringId: string;
    readonly idempotencyKey: string;
    readonly pausedAt: Date;
    readonly pausedByUserId: string;
    readonly requestId: string;
  } | null> {
    return Promise.resolve().then(
      (): {
        readonly offeringId: string;
        readonly idempotencyKey: string;
        readonly pausedAt: Date;
        readonly pausedByUserId: string;
        readonly requestId: string;
      } | null => {
        const pauseKey = `${input.offeringId}::${input.idempotencyKey}`;
        const row = this.pauseEvidenceByOfferingIdem.get(pauseKey);
        if (!row || row.reason !== "final_sample_removal") {
          return null;
        }
        return {
          offeringId: row.offeringId,
          idempotencyKey: row.idempotencyKey,
          pausedAt: row.pausedAt,
          pausedByUserId: row.pausedByUserId,
          requestId: row.requestId,
        };
      },
    );
  }
}
