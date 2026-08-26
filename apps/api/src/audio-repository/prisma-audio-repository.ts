// Prisma adapter for the AudioRepository contract.
//
// Background: this module is the only place the seller-audio
// persistence boundary touches Prisma. Higher layers depend on the
// AudioRepository interface; tests swap in the in-memory adapter
// without changing the route or service code.
//
// Authorization is NOT enforced here. The application service runs
// WorkspaceAuthorizationService.requireCapability for Seller commands
// and ownership checks before any repository call reaches this
// adapter. The repository's only job is to translate inputs to
// Prisma and return the structured record view the service maps.

import type { PrismaClient } from "@soundhub/db";
import {
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
      where: { offeringId },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(toRecord);
  }

  async createSample(input: {
    offeringId: string;
    label: string;
    contentType: "audio/mpeg";
    byteSize: number;
    displayOrder: number;
    storageRef: string;
  }): Promise<AudioSampleRecord> {
    const row = await this.prisma.serviceOfferingAudioSample.create({
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

  async deleteSample(input: { offeringId: string; sampleId: string }): Promise<void> {
    await this.prisma.serviceOfferingAudioSample.deleteMany({
      where: { id: input.sampleId, offeringId: input.offeringId },
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
  createdAt: Date;
  updatedAt: Date;
}): AudioSampleRecord {
  // `contentType` is allow-listed at the application boundary; the
  // repository narrows the cast defensively so a future schema
  // relaxation cannot widen it without a contract change.
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Re-export the closed enum surfaces this adapter casts from Prisma
// so the import path stays in this file.
export { MarketplaceCapability, SellerProfileStatus, ServiceOfferingStatus, WorkspaceStatus };
