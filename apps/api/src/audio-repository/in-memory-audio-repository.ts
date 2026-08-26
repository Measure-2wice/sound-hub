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
  readonly cleanupStatus?: AudioSampleCleanupStatus;
  readonly cleanupAttempts?: number;
}

export class InMemoryAudioRepository implements AudioRepository {
  private readonly contexts = new Map<string, AudioOfferingContext>();
  private readonly samples = new Map<string, AudioSampleRecord & { readonly _seeded?: boolean }>();

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
        cleanupStatus: seed.cleanupStatus ?? "Live",
        cleanupAttempts: seed.cleanupAttempts ?? 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  getOfferingContext(offeringId: string): Promise<AudioOfferingContext | null> {
    return Promise.resolve(this.contexts.get(offeringId) ?? null);
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
   * before display-order allocation.
   */
  createSampleWithCap(input: {
    offeringId: string;
    label: string;
    contentType: "audio/mpeg";
    byteSize: number;
    storageRef: string;
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
}
