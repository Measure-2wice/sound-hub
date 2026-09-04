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
  SellerProfileStatus,
  ServiceOfferingStatus,
  WorkspaceStatus,
} from "@soundhub/db";
import { Prisma } from "@soundhub/db/src/generated/client.js";
import type {
  AudioOfferingContext,
  AudioRepository,
  AudioSampleRecord,
} from "./audio-repository.js";

const MAX_SAMPLES_PER_OFFERING = 3;
// Lock class — distinct from any other advisory-lock users in the
// schema (none today; reserved for future expansion).
const AUDIO_SAMPLE_LOCK_CLASS = 0x4155_4449; // 'AUDI'
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
    // FNV-1a 32-bit. Stable across processes and languages.
    let hash = 0x811c9dc5;
    for (let i = 0; i < offeringId.length; i++) {
      hash ^= offeringId.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    // Force into a signed 32-bit range as required by the
    // pg_advisory_xact_lock(int, int) signature.
    return hash | 0;
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
   */
  async markPendingCleanup(input: { offeringId: string; sampleId: string }): Promise<void> {
    await this.prisma.serviceOfferingAudioSample.updateMany({
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
  }

  /**
   * Idempotent: deletes a PendingCleanup (or Live) row for the
   * given offering. Called by the application service after a
   * successful provider deletion OR after the provider already
   * reports the object as gone.
   */
  async finalizePendingCleanup(input: { offeringId: string; sampleId: string }): Promise<void> {
    await this.prisma.serviceOfferingAudioSample.deleteMany({
      where: {
        id: input.sampleId,
        offeringId: input.offeringId,
        cleanupStatus: {
          in: [AudioSampleCleanupStatus.PendingCleanup, AudioSampleCleanupStatus.Live],
        },
      },
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
  createdAt: Date;
  updatedAt: Date;
}): AudioSampleRecord {
  if (row.contentType !== "audio/mpeg") {
    throw new Error(
      `ServiceOfferingAudioSample ${row.id} has unexpected contentType ${row.contentType}; refusing to map.`,
    );
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
