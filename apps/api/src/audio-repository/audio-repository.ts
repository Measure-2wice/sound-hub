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

export interface AudioSampleRecord {
  readonly sampleId: string;
  readonly offeringId: string;
  readonly label: string;
  readonly contentType: "audio/mpeg";
  readonly byteSize: number;
  readonly displayOrder: number;
  readonly storageRef: string;
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
   * List all samples for an offering, ordered by `displayOrder` then
   * creation time. The repository does NOT enforce the 3-sample cap;
   * the application service does so at the trusted boundary.
   */
  listSamplesForOffering(offeringId: string): Promise<readonly AudioSampleRecord[]>;

  /**
   * Persist a new sample row. The application service guarantees
   * the row count has not yet reached the cap. The repository
   * performs no further authorization.
   */
  createSample(input: {
    readonly offeringId: string;
    readonly label: string;
    readonly contentType: "audio/mpeg";
    readonly byteSize: number;
    readonly displayOrder: number;
    readonly storageRef: string;
  }): Promise<AudioSampleRecord>;

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
   * Delete a sample row inside a transaction. The caller MUST have
   * already removed the storage object (or scheduled its cleanup).
   * The repository never throws for a missing row — deletion is
   * idempotent at the persistence layer.
   */
  deleteSample(input: { readonly offeringId: string; readonly sampleId: string }): Promise<void>;
}

/**
 * Public mapper. The repository returns internal `AudioSampleRecord`
 * views; the service maps them to the allow-listed public DTO. Lives
 * here so every call site goes through the same boundary and Prisma
 * models never cross the contract.
 */
export function toPublicAudioSample(record: AudioSampleRecord): Bg2AudioSamplePublicV1 {
  return {
    sampleId: record.sampleId,
    offeringId: record.offeringId,
    label: record.label,
    contentType: record.contentType,
    byteSize: record.byteSize,
    displayOrder: record.displayOrder,
    storageRef: record.storageRef,
    createdAt: record.createdAt.toISOString(),
  };
}
