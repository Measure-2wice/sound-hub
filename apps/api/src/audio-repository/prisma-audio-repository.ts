// Prisma adapter for the AudioRepository contract.
//
// Background: this module is the only place the seller-audio
// persistence boundary touches Prisma. Higher layers depend on the
// AudioRepository interface; tests swap in the in-memory adapter
// without changing the route or service code.
//
// Per ticket #61 follow-up review (P1-002) the 3-sample cap is
// serialized at the database boundary. Two concurrent uploads
// starting with two existing rows both observe count = 2 under
// READ COMMITTED isolation; the un-guarded count + insert lets
// both inserts commit and the offering ends up with four Live
// rows. The fix acquires a per-offering PostgreSQL advisory lock
// at the start of the transaction so all writes against the
// offering serialize; the count + display-order allocation +
// insert run atomically against that lock, so exactly one of the
// racing inserts wins.
//
// Per ticket #61 follow-up review (P1-005) removal hides the
// sample from discovery immediately via the cleanup status flip
// and persists a PendingCleanup record so a bounded retry can
// complete the deletion later.

import type { PrismaClient } from "@soundhub/db";
import {
  AudioSampleCleanupStatus,
  MarketplaceCapability,
  Prisma,
  SellerProfileStatus,
  ServiceOfferingPauseReason,
  ServiceOfferingStatus,
  WorkspaceStatus,
} from "@soundhub/db";
import type {
  AudioOfferingContext,
  AudioRepository,
  AudioSampleConfirmation,
  AudioSampleRecord,
} from "./audio-repository.js";
import { AudioSampleFinalRemovalNotApplicableError } from "./audio-repository.js";
import {
  AUDIO_SAMPLE_LOCK_CLASS,
  acquireAudioSampleLockTx,
  audioSampleLockKey,
} from "./audio-sample-lock.js";
import { offeringLockSql } from "../repositories/service-offering-lock.js";
import { sellerProfileWorkspaceLockSql } from "../repositories/seller-profile-workspace-lock.js";

const MAX_SAMPLES_PER_OFFERING = 3;
// Lock class — distinct from any other advisory-lock users in the
// schema (none today; reserved for future expansion).
export { AUDIO_SAMPLE_LOCK_CLASS };
const MAX_DISPLAY_ORDER = 1024;

export class PrismaAudioRepository implements AudioRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getOfferingContext(offeringId: string): Promise<AudioOfferingContext | null> {
    const offering = await this.prisma.serviceOffering.findUnique({
      where: { id: offeringId },
      include: {
        sellerProfile: {
          include: {
            workspace: {
              include: { capabilities: true },
            },
          },
        },
      },
    });
    if (!offering) return null;
    const profile = offering.sellerProfile;
    const workspace = profile.workspace;
    return {
      offeringId: offering.id,
      offeringStatus: offering.status,
      sellerProfileStatus: profile.status,
      sellerWorkspaceId: workspace.id,
      sellerWorkspaceStatus: workspace.status,
      hasSellerCapability: workspace.capabilities.some(
        (cap) => cap.capability === MarketplaceCapability.Seller,
      ),
      title: offering.title,
    };
  }

  async listSamplesForOffering(offeringId: string): Promise<readonly AudioSampleRecord[]> {
    const rows = await this.prisma.serviceOfferingAudioSample.findMany({
      where: { offeringId, cleanupStatus: AudioSampleCleanupStatus.Live },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(toRecord);
  }

  /**
   * Per-offering advisory lock key. PostgreSQL exposes only two
   * advisory-lock signatures for `pg_advisory_xact_lock`: a single
   * `bigint` argument or two `integer` arguments. The two-int
   * variant gives us a name-space class (this adapter) plus a
   * per-offering hash that fits inside a signed 32-bit integer.
   *
   * The function returns the per-offering `key` (the second int).
   * The first int (class) is fixed at `AUDIO_SAMPLE_LOCK_CLASS`
   * below. The hash is FNV-1a 32-bit so the resulting int always
   * fits and the value is stable across processes. A collision
   * only causes two offerings to serialize unnecessarily, never a
   * correctness gap.
   */
  private lockKeyForOffering(offeringId: string): number {
    // Delegated to the shared helper so the activation transaction
    // uses the same per-offering key.
    return audioSampleLockKey(offeringId);
  }

  /**
   * Atomic guarded insert. Acquires a per-offering advisory lock
   * for the lifetime of the transaction so concurrent writers
   * serialize on the same offering without affecting other
   * offerings. Inside the lock:
   *   1. Count current Live rows for the offering.
   *   2. If count >= MAX_SAMPLES_PER_OFFERING, abort and return null.
   *   3. Allocate the next free displayOrder slot.
   *   4. Insert the row.
   *
   * Two concurrent calls both acquire the lock sequentially; the
   * loser observes count = MAX after the winner commits and
   * returns null. The losing upload's storage object is cleaned
   * up at the service layer.
   */
  async createSampleWithCap(input: {
    offeringId: string;
    label: string;
    contentType: "audio/mpeg";
    byteSize: number;
    storageRef: string;
    confirmation: AudioSampleConfirmation;
  }): Promise<AudioSampleRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      // Acquire the per-offering advisory lock so concurrent
      // writers serialize. The lock is held until commit/rollback.
      // PostgreSQL exposes only two pg_advisory_xact_lock overloads:
      // one bigint argument or two integer arguments. We use the
      // two-int form: the class is fixed at AUDIO_SAMPLE_LOCK_CLASS
      // (a stable namespace for audio-sample locks) and the per-
      // offering key is a signed 32-bit FNV-1a hash.
      const lockKey = this.lockKeyForOffering(input.offeringId);
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(${AUDIO_SAMPLE_LOCK_CLASS}::int, ${lockKey}::int)`,
      );
      const liveRows = await tx.serviceOfferingAudioSample.findMany({
        where: {
          offeringId: input.offeringId,
          cleanupStatus: AudioSampleCleanupStatus.Live,
        },
        select: { displayOrder: true },
        orderBy: { displayOrder: "asc" },
      });
      if (liveRows.length >= MAX_SAMPLES_PER_OFFERING) return null;
      const taken = new Set(liveRows.map((r) => r.displayOrder));
      let displayOrder: number | null = null;
      for (let candidate = 1; candidate <= MAX_DISPLAY_ORDER; candidate += 1) {
        if (!taken.has(candidate)) {
          displayOrder = candidate;
          break;
        }
      }
      if (displayOrder === null) {
        // The cap on displayOrder slots is exhausted even though
        // the cap on samples is not. Treat as cap hit so the
        // service cleans up the uploaded object.
        return null;
      }
      const row = await tx.serviceOfferingAudioSample.create({
        data: {
          offeringId: input.offeringId,
          label: input.label,
          contentType: input.contentType,
          byteSize: input.byteSize,
          displayOrder,
          storageRef: input.storageRef,
          // M2 (#85) PR-review feedback: durable media-use
          // confirmation. The actor and version are persisted
          // alongside the sample; the activation completeness
          // recheck reads these columns rather than any
          // client-supplied flag.
          confirmationVersion: input.confirmation.version,
          confirmedByUserId: input.confirmation.confirmedByUserId,
          confirmedAt: input.confirmation.confirmedAt,
        },
      });
      return toRecord(row);
    });
  }

  async findSampleById(input: {
    offeringId: string;
    sampleId: string;
  }): Promise<AudioSampleRecord | null> {
    const row = await this.prisma.serviceOfferingAudioSample.findUnique({
      where: { id: input.sampleId },
    });
    if (!row) return null;
    if (row.offeringId !== input.offeringId) return null;
    return toRecord(row);
  }

  /**
   * Per P1-003, removal happens in three atomic steps:
   *   1. Flip the row to `PendingCleanup` so it is hidden from
   *      buyer-facing discovery immediately and the storage ref
   *      is durably preserved for retry.
   *   2. Attempt the provider delete (caller does this outside the
   *      transaction).
   *   3. On success (or `StorageReferenceUnknownError`), delete
   *      the row in a follow-up transactional sweep.
   *
   * This method performs step 1: mark PendingCleanup. The
   * companion `finalizePendingCleanup` deletes the row on
   * successful provider delete. `restoreLiveToRemoved` is used
   * by the rare case where the row was already deleted by a
   * concurrent retry before the caller observed PendingCleanup.
   *
   * M2 (#85) PR-review feedback (round 2): both removal steps
   * take the per-offering audio-sample advisory lock so a
   * concurrent activation transaction (which ALSO acquires this
   * lock — see `prisma-service-offering.repository.activate`)
   * serializes with the removal. Without the lock, a removal
   * can commit AFTER the activation counted the last Live
   * sample but BEFORE the activation commits, leaving a newly
   * Active offering whose only sample is PendingCleanup (which
   * the buyer-side list filters out — effectively zero playable
   * samples).
   */
  async markPendingCleanup(input: { offeringId: string; sampleId: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await acquireAudioSampleLockTx(tx, input.offeringId);
      await tx.serviceOfferingAudioSample.updateMany({
        where: {
          id: input.sampleId,
          offeringId: input.offeringId,
          cleanupStatus: AudioSampleCleanupStatus.Live,
        },
        data: {
          cleanupStatus: AudioSampleCleanupStatus.PendingCleanup,
          cleanupAttempts: { increment: 1 },
          cleanupLastFailureAt: new Date(),
        },
      });
    });
  }

  /**
   * Idempotent: deletes a PendingCleanup (or Live) row for the
   * given offering. Called by the application service after a
   * successful provider deletion OR after the provider already
   * reports the object as gone. Acquires the per-offering
   * audio-sample advisory lock (see `markPendingCleanup` for the
   * removal-vs-activation race rationale).
   */
  async finalizePendingCleanup(input: { offeringId: string; sampleId: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await acquireAudioSampleLockTx(tx, input.offeringId);
      await tx.serviceOfferingAudioSample.deleteMany({
        where: {
          id: input.sampleId,
          offeringId: input.offeringId,
          cleanupStatus: {
            in: [AudioSampleCleanupStatus.PendingCleanup, AudioSampleCleanupStatus.Live],
          },
        },
      });
    });
  }

  async listPendingCleanupForOffering(offeringId: string): Promise<readonly AudioSampleRecord[]> {
    const rows = await this.prisma.serviceOfferingAudioSample.findMany({
      where: {
        offeringId,
        cleanupStatus: AudioSampleCleanupStatus.PendingCleanup,
      },
      orderBy: [{ updatedAt: "asc" }],
    });
    return rows.map(toRecord);
  }

  async recordOrphanedStorage(input: { offeringId: string; storageRef: string }): Promise<void> {
    // Upsert so concurrent orphan-detect paths converge on a
    // single durable locator row. On overwrite we reset the
    // attempt counter so a fresh failure is recorded as such.
    await this.prisma.audioSampleOrphanedStorage.upsert({
      where: { storageRef: input.storageRef },
      create: {
        storageRef: input.storageRef,
        offeringId: input.offeringId,
        cleanupAttempts: 0,
      },
      update: {
        offeringId: input.offeringId,
        cleanupAttempts: 0,
        cleanupLastFailureAt: new Date(),
      },
    });
  }

  async listOrphanedStorageForOffering(
    offeringId: string,
  ): Promise<readonly { readonly storageRef: string; readonly cleanupAttempts: number }[]> {
    const rows = await this.prisma.audioSampleOrphanedStorage.findMany({
      where: { offeringId },
      orderBy: [{ updatedAt: "asc" }],
    });
    return rows.map((row) => ({
      storageRef: row.storageRef,
      cleanupAttempts: row.cleanupAttempts,
    }));
  }

  async removeOrphanedStorage(storageRef: string): Promise<void> {
    await this.prisma.audioSampleOrphanedStorage.deleteMany({
      where: { storageRef },
    });
  }

  /**
   * M2 (#86, slice 86D): atomic Active → Paused transition
   * triggered by the removal of the final qualifying sample from
   * an Active offering. See the interface docblock for the full
   * contract.
   *
   * Lock acquisition order matches the established slice 86B /
   * 86C pattern so concurrent writers serialize consistently:
   *   (1) `service-offering:<offeringId>`
   *   (2) audio-sample per-offering
   *   (3) `seller-profile:<workspaceId>`
   *
   * The audio-sample lock prevents a concurrent `markPendingCleanup`
   * / `finalizePendingCleanup` from landing on the same sample
   * while we transition the offering; the workspaceLock serializes
   * the offering's transition against a concurrent SellerProfile
   * suspension (matching the slice 86B Reactivate pattern).
   *
   * The same-key idempotency lookup for the Pause evidence row
   * runs BEFORE the precondition checks so a same-key retry of an
   * already-committed final-sample removal converges on the
   * existing Pause row regardless of the current offering /
   * sample state.
   */
  async removeFinalSamplePendingCleanup(input: {
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
    return this.prisma.$transaction(async (tx) => {
      // Lock acquisition order (matches the slice 86C Update pattern).
      await tx.$executeRaw(offeringLockSql(input.offeringId));
      await acquireAudioSampleLockTx(tx, input.offeringId);
      await tx.$executeRaw(sellerProfileWorkspaceLockSql(input.workspaceId));

      // Idempotency pre-check on the pause-evidence table. A
      // same-key retry after a committed final-sample removal
      // converges on the existing Pause row.
      const existingPause = await tx.serviceOfferingPause.findUnique({
        where: {
          offeringId_idempotencyKey: {
            offeringId: input.offeringId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existingPause) {
        // The Pause row's `reason` confirms this was a final-sample
        // removal (the slice plan's slice 86D invariant — Pause
        // rows for `user_initiated` removals carry a different
        // `requestId`/`idempotencyKey` shape because they're issued
        // by the service-offering route, not the audio route).
        if (existingPause.reason !== ServiceOfferingPauseReason.final_sample_removal) {
          throw new AudioSampleFinalRemovalNotApplicableError("offering_not_active");
        }
        // Re-load the marked sample (the persisted row carries
        // PendingCleanup status; the bounded retry path will
        // finalize it once storage.delete resolves).
        //
        // M2 (#86, slice 86D Codex re-review): when `findUnique`
        // returns null — because `finalizePendingCleanup` already
        // deleted the row after a successful provider-side cleanup
        // — we still converge. The durable Pause evidence row IS
        // present, which is sufficient to prove the removal
        // completed; we synthesize a record carrying the converged
        // status (`Removed`) so the application service treats the
        // retry as a successful removal. Without this branch a lost
        // success response turns the same logical retry into
        // `sample_not_found`, violating the issue #86 retry-safety
        // invariant for consequential commands.
        const markedSample = await tx.serviceOfferingAudioSample.findUnique({
          where: {
            id: input.sampleId,
          },
        });
        if (!markedSample) {
          return {
            offeringStatus: "Paused" as const,
            sample: {
              sampleId: input.sampleId,
              offeringId: input.offeringId,
              label: "",
              contentType: "audio/mpeg",
              byteSize: 0,
              displayOrder: 0,
              storageRef: "",
              cleanupStatus: AudioSampleCleanupStatus.Removed,
              cleanupAttempts: 1,
              confirmation: null,
              createdAt: existingPause.pausedAt,
              updatedAt: existingPause.pausedAt,
            },
          };
        }
        return {
          offeringStatus: "Paused" as const,
          sample: toRecord(markedSample),
        };
      }

      // Step 2: precondition — offering must be Active.
      const existing = await tx.serviceOffering.findUnique({
        where: { id: input.offeringId },
        select: { id: true, status: true, sellerProfileId: true },
      });
      if (!existing) {
        throw new AudioSampleFinalRemovalNotApplicableError("offering_not_found");
      }
      if (existing.status !== ServiceOfferingStatus.Active) {
        // A non-Active offering cannot undergo a final-sample
        // eligibility-loss transition. The service catches this
        // and falls back to the non-final-sample path.
        throw new AudioSampleFinalRemovalNotApplicableError("offering_not_active");
      }

      // Step 3: precondition — sample must exist, belong to this
      // offering, and be currently `Live`.
      const sample = await tx.serviceOfferingAudioSample.findUnique({
        where: {
          id: input.sampleId,
        },
      });
      if (!sample || sample.offeringId !== input.offeringId) {
        throw new AudioSampleFinalRemovalNotApplicableError("sample_not_found");
      }
      if (sample.cleanupStatus !== AudioSampleCleanupStatus.Live) {
        throw new AudioSampleFinalRemovalNotApplicableError("sample_not_live");
      }

      // Step 4: precondition — the sample must be the LAST CONFIRMED
      // Live sample. A non-final removal does not require
      // `confirmEligibilityLoss` and is rejected so the service
      // layer routes through the non-final path.
      const liveConfirmedCount = await tx.serviceOfferingAudioSample.count({
        where: {
          offeringId: input.offeringId,
          cleanupStatus: AudioSampleCleanupStatus.Live,
          confirmationVersion: { not: null },
          confirmedByUserId: { not: null },
          confirmedAt: { not: null },
        },
      });
      if (liveConfirmedCount !== 1) {
        throw new AudioSampleFinalRemovalNotApplicableError("not_last_live_sample");
      }

      // Step 5: atomic transition. The offering's status flips to
      // Paused, the Pause evidence row is inserted, and the sample
      // is marked PendingCleanup — all in this transaction. The
      // DB unique constraint on `(offeringId, idempotencyKey)` is
      // the second defense behind the application-layer pre-check.
      await tx.serviceOffering.update({
        where: { id: input.offeringId },
        data: { status: ServiceOfferingStatus.Paused },
      });
      await tx.serviceOfferingPause.create({
        data: {
          offeringId: input.offeringId,
          workspaceId: input.workspaceId,
          sellerProfileId: existing.sellerProfileId,
          pausedByUserId: input.pausedByUserId,
          pausedAt: input.now,
          reason: ServiceOfferingPauseReason.final_sample_removal,
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
        },
      });
      const markedSample = await tx.serviceOfferingAudioSample.update({
        where: { id: input.sampleId },
        data: {
          cleanupStatus: AudioSampleCleanupStatus.PendingCleanup,
          cleanupAttempts: { increment: 1 },
        },
      });

      return {
        offeringStatus: "Paused" as const,
        sample: toRecord(markedSample),
      };
    });
  }

  /**
   * M2 (#86, slice 86D Codex re-review): read-only lookup for the
   * durable `final_sample_removal` Pause evidence row. Returns
   * `null` when no such row exists. Used by the application service
   * to converge retries after the provider-side cleanup finalized
   * the sample row (the sample row may have been deleted via
   * `finalizePendingCleanup` but the durable Pause evidence row
   * IS still present).
   */
  async findFinalSampleRemovalPauseEvidence(input: {
    offeringId: string;
    idempotencyKey: string;
  }): Promise<{
    readonly offeringId: string;
    readonly idempotencyKey: string;
    readonly pausedAt: Date;
    readonly pausedByUserId: string;
    readonly requestId: string;
  } | null> {
    const row = await this.prisma.serviceOfferingPause.findFirst({
      where: {
        offeringId: input.offeringId,
        idempotencyKey: input.idempotencyKey,
        reason: ServiceOfferingPauseReason.final_sample_removal,
      },
      select: {
        offeringId: true,
        idempotencyKey: true,
        pausedAt: true,
        pausedByUserId: true,
        requestId: true,
      },
    });
    if (!row) return null;
    return {
      offeringId: row.offeringId,
      idempotencyKey: row.idempotencyKey,
      pausedAt: row.pausedAt,
      pausedByUserId: row.pausedByUserId,
      requestId: row.requestId,
    };
  }
}

function toRecord(row: {
  id: string;
  offeringId: string;
  label: string;
  contentType: string;
  byteSize: number;
  displayOrder: number;
  storageRef: string;
  cleanupStatus: AudioSampleCleanupStatus;
  cleanupAttempts: number;
  confirmationVersion: string | null;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AudioSampleRecord {
  if (row.contentType !== "audio/mpeg") {
    throw new Error(
      `ServiceOfferingAudioSample ${row.id} has unexpected contentType ${row.contentType}; refusing to map.`,
    );
  }
  // Legacy rows (persisted before the confirmation columns
  // existed) surface as `confirmation: null` so the activation
  // recheck filters them out. They remain readable for
  // listSamplesForOffering callers that scope to Live, but the
  // public mapper throws if a legacy row slips through without
  // being filtered.
  let confirmation: AudioSampleConfirmation | null = null;
  if (
    row.confirmationVersion !== null &&
    row.confirmedByUserId !== null &&
    row.confirmedAt !== null
  ) {
    confirmation = {
      version: row.confirmationVersion as AudioSampleConfirmation["version"],
      confirmedByUserId: row.confirmedByUserId,
      confirmedAt: row.confirmedAt,
    };
  }
  return {
    sampleId: row.id,
    offeringId: row.offeringId,
    label: row.label,
    contentType: "audio/mpeg",
    byteSize: row.byteSize,
    displayOrder: row.displayOrder,
    storageRef: row.storageRef,
    cleanupStatus: row.cleanupStatus,
    cleanupAttempts: row.cleanupAttempts,
    confirmation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Re-export the closed enum surfaces this adapter casts from Prisma
// so the import path stays in this file.
export {
  AudioSampleCleanupStatus,
  MarketplaceCapability,
  SellerProfileStatus,
  ServiceOfferingStatus,
  WorkspaceStatus,
};
