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
  AudioSampleRecord,
} from "./audio-repository.js";

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
}

export class InMemoryAudioRepository implements AudioRepository {
  private readonly contexts = new Map<string, AudioOfferingContext>();
  private readonly samples = new Map<string, AudioSampleRecord>();

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
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async getOfferingContext(offeringId: string): Promise<AudioOfferingContext | null> {
    return Promise.resolve(this.contexts.get(offeringId) ?? null);
  }

  async listSamplesForOffering(offeringId: string): Promise<readonly AudioSampleRecord[]> {
    return Promise.resolve(
      [...this.samples.values()]
        .filter((s) => s.offeringId === offeringId)
        .sort((a, b) => {
          if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
          return a.createdAt.getTime() - b.createdAt.getTime();
        }),
    );
  }

  async createSample(input: {
    offeringId: string;
    label: string;
    contentType: "audio/mpeg";
    byteSize: number;
    displayOrder: number;
    storageRef: string;
  }): Promise<AudioSampleRecord> {
    const id = `smp-${randomUUID().slice(0, 12)}`;
    const now = new Date();
    const record: AudioSampleRecord = {
      sampleId: id,
      offeringId: input.offeringId,
      label: input.label,
      contentType: input.contentType,
      byteSize: input.byteSize,
      displayOrder: input.displayOrder,
      storageRef: input.storageRef,
      createdAt: now,
      updatedAt: now,
    };
    this.samples.set(id, record);
    return Promise.resolve(record);
  }

  async findSampleById(input: {
    offeringId: string;
    sampleId: string;
  }): Promise<AudioSampleRecord | null> {
    const sample = this.samples.get(input.sampleId);
    if (!sample) return Promise.resolve(null);
    if (sample.offeringId !== input.offeringId) return Promise.resolve(null);
    return Promise.resolve(sample);
  }

  deleteSample(input: { offeringId: string; sampleId: string }): Promise<void> {
    const sample = this.samples.get(input.sampleId);
    if (!sample) return Promise.resolve();
    if (sample.offeringId !== input.offeringId) return Promise.resolve();
    this.samples.delete(input.sampleId);
    return Promise.resolve();
  }
}
