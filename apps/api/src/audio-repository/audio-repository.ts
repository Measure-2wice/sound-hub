// Audio repository contract.
//
// Background: ticket #61 requires the seller-audio persistence layer
// to live behind a contract that the application service depends on.
// The Prisma adapter (apps/api/src/audio-repository/prisma-audio-
// repository.ts) and the in-memory adapter (used by service-level
// unit tests) both implement this interface. Public DTOs are mapped
// at the service layer; the repository never returns Prisma models to
// the public contract.

import type { Bg2AudioSamplePublicV1 } from "@soundhub/types";

export type AudioSampleCleanupStatus = "Live" | "PendingCleanup" | "Removed";

export interface AudioSampleRecord {
  readonly sampleId: string;
  readonly offeringId: string;
  readonly label: string;
  readonly contentType: "audio/mpeg";
  readonly byteSize: number;
  readonly displayOrder: number;
  readonly storageRef: string;
  readonly cleanupStatus: AudioSampleCleanupStatus;
  readonly cleanupAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AudioOfferingContext {
  readonly offeringId: string;
  readonly offeringStatus: "Active" | "Draft" | "Paused" | "Archived";
  readonly sellerProfileStatus: "Draft" | "Published" | "Suspended";
  readonly sellerWorkspaceId: string;
  readonly sellerWorkspaceStatus: "Active" | "Suspended";
  readonly hasSellerCapability: boolean;
  readonly title: string;
}

export interface AudioRepository {
  /**
   * Load the bounded ServiceOffering context required to authorize
   * seller-audio commands. Returns `null` when the offering does
   * not exist. The application service uses this to enforce
   * WorkspaceMembership, Seller capability, and ServiceOffering
   * ownership in one read.
   */
  getOfferingContext(offeringId: string): Promise<AudioOfferingContext | null>;

  /**
   * List all LIVE samples for an offering, ordered by `displayOrder`
   * then creation time. Pending-cleanup and removed samples are
   * hidden from this view; the application service uses the
   * PendingCleanup list for the bounded retry path.
   *
   * The repository does NOT enforce the 3-sample cap; the
   * application service does so at the trusted boundary.
   */
  listSamplesForOffering(offeringId: string): Promise<readonly AudioSampleRecord[]>;

  /**
   * Persist a new sample row inside a database transaction that
   * ALSO enforces the 3-sample cap at the persistence boundary
   * (P1-002). The repository acquires a per-offering advisory lock
   * for the duration of the transaction so concurrent writers
   * serialize; the count + display-order allocation + insert run
   * atomically against that lock. The repository owns display-
   * order allocation; callers do not pass it in.
   *
   * Returns `null` when the cap is hit (the row was NOT inserted).
   * Throws for other persistence failures.
   */
  createSampleWithCap(input: {
    readonly offeringId: string;
    readonly label: string;
    readonly contentType: "audio/mpeg";
    readonly byteSize: number;
    readonly storageRef: string;
  }): Promise<AudioSampleRecord | null>;

  /**
   * Look up a single sample by id within an offering. Returns
   * `null` when the sample does not exist or does not belong to the
   * offering. Used to validate removal commands.
   */
  findSampleById(input: {
    readonly offeringId: string;
    readonly sampleId: string;
  }): Promise<AudioSampleRecord | null>;

  /**
   * Mark a sample as `PendingCleanup` and increment
   * `cleanupAttempts`. Per P1-003 the row is preserved (NOT
   * deleted) so the bounded retry can drive a follow-up provider
   * delete + row sweep. Only Live rows are updated; a sample
   * that is already PendingCleanup or Removed is left alone so
   * concurrent retries converge.
   */
  markPendingCleanup(input: {
    readonly offeringId: string;
    readonly sampleId: string;
  }): Promise<void>;

  /**
   * Delete a row whose provider-side cleanup has been confirmed
   * (success or already-absent). Called by the bounded retry
   * sweep and the immediate removal command after the provider
   * delete resolves.
   */
  finalizePendingCleanup(input: {
    readonly offeringId: string;
    readonly sampleId: string;
  }): Promise<void>;

  /**
   * List the bounded set of `PendingCleanup` samples for retry.
   * Used by the application service to drive a bounded, no-job
   * cleanup pass at the next operation against the offering.
   */
  listPendingCleanupForOffering(offeringId: string): Promise<readonly AudioSampleRecord[]>;
}

/**
 * Public mapper. The repository returns internal `AudioSampleRecord`
 * views; the service maps them to the allow-listed public DTO.
 *
 * The mapper does NOT carry `storageRef`, `cleanupStatus`,
 * `cleanupAttempts`, or any provider-internal shape across the
 * public boundary. The service populates `playbackUrl` after
 * consulting the storage adapter so the serialized DTO only
 * carries buyer-safe fields. Storage credentials, bucket names,
 * object keys, and provider subjects never appear here.
 */
export function toPublicAudioSample(input: {
  readonly record: AudioSampleRecord;
  readonly playbackUrl: string;
}): Bg2AudioSamplePublicV1 {
  return {
    sampleId: input.record.sampleId,
    offeringId: input.record.offeringId,
    label: input.record.label,
    contentType: input.record.contentType,
    byteSize: input.record.byteSize,
    displayOrder: input.record.displayOrder,
    playbackUrl: input.playbackUrl,
    createdAt: input.record.createdAt.toISOString(),
  };
}
