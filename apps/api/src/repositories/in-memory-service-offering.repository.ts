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
// The (offeringId, idempotencyKey) retry convergence for activation
// is implemented at the application layer (mirroring the Prisma DB
// unique constraint): the activate method looks up the existing
// activation by (offeringId, idempotencyKey) BEFORE writing; if
// found, it returns the existing evidence without creating a new
// row.
//
// The in-memory adapter only knows about the offering row itself,
// not the rest of the marketplace graph (WorkspaceMembership,
// WorkspaceCapability, etc.). It is the SERVICE-LAYER test's job
// to assert that the application policy composes the authorization
// gate; the in-memory adapter ONLY enforces the offering-shape
// invariants (status transitions, idempotency, ownership).

import type {
  ServiceOfferingActivationConfirmationVersionV1,
  ServiceOfferingOwnerSampleSummaryV1,
} from "@soundhub/types";
import type {
  ServiceOfferingActivateInput,
  ServiceOfferingActivationEvidenceView,
  ServiceOfferingActivationResult,
  ServiceOfferingDraftInput,
  ServiceOfferingOwnerViewRecord,
  ServiceOfferingRepository,
} from "./service-offering.repository.js";
import {
  ServiceOfferingNotDraftError,
  ServiceOfferingNotFoundError,
  ServiceOfferingNotOwnedError,
} from "./service-offering.repository.js";

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

let nextId = 1;
function generateCuid(prefix: string): string {
  nextId += 1;
  return `${prefix}_mem_${nextId.toString(36)}`;
}

export class InMemoryServiceOfferingRepository implements ServiceOfferingRepository {
  private readonly offeringsById = new Map<string, StoredOffering>();
  private readonly offeringsByWorkspace = new Map<string, Set<string>>();
  private readonly activationsByOfferingIdem = new Map<string, StoredActivation>();
  // Per-offering mutex chain (mirrors in-memory-seller-profile.repository.ts).
  private readonly mutexChains = new Map<string, Promise<void>>();

  private withOfferingLock<T>(offeringId: string, fn: () => T | PromiseLike<T>): Promise<T> {
    const previous = this.mutexChains.get(offeringId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexChains.set(
      offeringId,
      previous.then(() => next),
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
      return this.toOwnerView(existing);
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
          offering: this.toOwnerView(existingOffering),
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
      if (existing.sellerProfileId !== input.sellerProfileId) {
        throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
      }

      // Step 3: snapshot for rollback.
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
          sellerProfileId: input.sellerProfileId,
          activatedByUserId: input.activatedByUserId,
          confirmationVersion: input.confirmationVersion,
          activatedAt: input.now,
          idempotencyKey: input.idempotencyKey,
          requestId: input.requestId,
        };
        this.activationsByOfferingIdem.set(idemKey, activation);
        return {
          offering: this.toOwnerView(existing),
          evidence: toEvidenceView(activation),
          convergedFromExistingActivation: false,
        };
      } catch (err) {
        Object.assign(existing, before);
        throw err;
      }
    });
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

  countLiveSamples(offeringId: string): Promise<number> {
    const row = this.offeringsById.get(offeringId);
    if (!row) return Promise.resolve(0);
    return Promise.resolve(row.samples.filter((s) => s.cleanupStatus === "Live").length);
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

  _peekOffering(id: string): StoredOffering | null {
    return this.offeringsById.get(id) ?? null;
  }

  _peekActivation(offeringId: string, idempotencyKey: string): StoredActivation | null {
    return this.activationsByOfferingIdem.get(this.idemKey(offeringId, idempotencyKey)) ?? null;
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
      createdAt: new Date(),
    });
  }

  private toOwnerView(
    row: StoredOffering,
    playbackUrlFor?: (input: { offeringId: string; sampleId: string }) => string,
  ): ServiceOfferingOwnerViewRecord {
    const samples: ServiceOfferingOwnerSampleSummaryV1[] = row.samples
      .filter((s) => s.cleanupStatus === "Live")
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((s) => ({
        sampleId: s.sampleId,
        label: s.label,
        contentType: "audio/mpeg" as const,
        byteSize: s.byteSize,
        displayOrder: s.displayOrder,
        playbackUrl: playbackUrlFor?.({ offeringId: row.id, sampleId: s.sampleId }) ?? "",
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
      activatedByDisplayName: row.activatedByUserId,
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
