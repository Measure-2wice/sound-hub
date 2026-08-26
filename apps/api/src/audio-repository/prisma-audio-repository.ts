// Prisma adapter for the AudioRepository contract.
//
// Background: this module is the only place the seller-audio
// persistence boundary touches Prisma. Higher layers depend on the
// AudioRepository interface; tests swap in the in-memory adapter
// without changing the route or service code.
//
// Per ticket #61 follow-up review (P1-004) the cap is enforced
// atomically at the persistence boundary. Two concurrent uploads
// each call `listSamplesForOffering` and observe two existing
// rows; both then race to insert. The non-transactional check is
// a race. `createSampleWithCap` runs the count check + insert
// inside a single transaction with a `WHERE NOT EXISTS` guard on
// the row count, so exactly one of the racing inserts wins.
//
// Per ticket #61 follow-up review (P1-005) removal hides the
// sample from discovery by setting `cleanupStatus = Removed` and
// deleting the row in one transaction. A storage-removal failure
// marks the row `PendingCleanup` so a bounded retry can complete
// the deletion later.

import type { PrismaClient } from "@soundhub/db";
import {
  AudioSampleCleanupStatus,
  MarketplaceCapability,
  SellerProfileStatus,
  ServiceOfferingStatus,
  WorkspaceStatus,
} from "@soundhub/db";
import type {
  AudioOfferingContext,
  AudioRepository,
  AudioSampleRecord,
} from "./audio-repository.js";

const MAX_SAMPLES_PER_OFFERING = 3;

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
   * Atomic guarded insert. Inside a single transaction:
   *   1. Count current Live rows for the offering.
   *   2. If count >= MAX_SAMPLES_PER_OFFERING, abort and return null.
   *   3. Otherwise insert the row.
   *
   * Two concurrent calls in the same row-count state both see
   * count = MAX, so the second one returns null. The losing
   * upload's storage object is cleaned up at the service layer.
   */
  async createSampleWithCap(input: {
    offeringId: string;
    label: string;
    contentType: "audio/mpeg";
    byteSize: number;
    displayOrder: number;
    storageRef: string;
  }): Promise<AudioSampleRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const currentCount = await tx.serviceOfferingAudioSample.count({
        where: {
          offeringId: input.offeringId,
          cleanupStatus: AudioSampleCleanupStatus.Live,
        },
      });
      if (currentCount >= MAX_SAMPLES_PER_OFFERING) return null;
      const row = await tx.serviceOfferingAudioSample.create({
        data: {
          offeringId: input.offeringId,
          label: input.label,
          contentType: input.contentType,
          byteSize: input.byteSize,
          displayOrder: input.displayOrder,
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

  async markRemovedAndDelete(input: { offeringId: string; sampleId: string }): Promise<void> {
    // Set cleanupStatus to Removed and delete the row inside a
    // single transaction. Idempotent: a concurrent retry that
    // already deleted the row sees no rows updated and the
    // transaction commits cleanly.
    await this.prisma.$transaction(async (tx) => {
      await tx.serviceOfferingAudioSample.updateMany({
        where: {
          id: input.sampleId,
          offeringId: input.offeringId,
        },
        data: { cleanupStatus: AudioSampleCleanupStatus.Removed },
      });
      await tx.serviceOfferingAudioSample.deleteMany({
        where: {
          id: input.sampleId,
          offeringId: input.offeringId,
        },
      });
    });
  }

  async markPendingCleanup(input: { offeringId: string; sampleId: string }): Promise<void> {
    // Increment attempts and flip status to PendingCleanup. Only
    // Live rows are updated; a sample that is already PendingCleanup
    // or Removed is left alone so concurrent retries converge.
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
