// Prisma implementation of ServiceOfferingRepository.
//
// This is the only place in the application that issues Prisma queries
// against `service_offerings`, `service_offering_service_areas`,
// `offering_pricing`, `included_services`, and
// `service_offering_activations` for the seller-offering slice. The
// route depends on this adapter through the `ServiceOfferingRepository`
// interface so the HTTP layer never reaches into Prisma directly,
// satisfying the contract rule that routes never query Prisma.
//
// Transaction model: each write operation opens ONE `Prisma.$transaction`
// and uses `pg_advisory_xact_lock` to serialize concurrent attempts on
// the same offering. This mirrors the `provisionIntentAtomically`
// primitive at `apps/api/src/auth-repository/prisma-auth-repository.ts:498`
// and the SellerProfile writePublication primitive at
// `apps/api/src/repositories/prisma-seller-profile.repository.ts:182`.
//
// Retry semantics: the application-layer pre-check on
// `(offeringId, idempotencyKey)` is the first defense. The DB unique
// index `service_offering_activations_offering_idem_unique_idx` is the
// second defense — if a concurrent same-key request wins the race, the
// unique-constraint violation is caught and the existing row is re-read.
//
// Acting-user attribution: the activation evidence row stores the
// UserAccount id; the route layer can join the existing
// `bg1PublicUserV1` (which carries `email`) when constructing the public
// response. The `activatedByUserId` FK is the audit attribution.

import { type PrismaClient, Prisma, AudioSampleCleanupStatus, PurchaseMode } from "@soundhub/db";
import type { Prisma as PrismaTypes } from "@soundhub/db";
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

/**
 * Stable per-offering lock key for `pg_advisory_xact_lock`. Mirrors
 * the SellerProfile lock pattern: hashtext on a namespaced string
 * returns int4, which fits the two-argument signed-32-bit signature.
 */
function offeringLockSql(offeringId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`service-offering:${offeringId}`}::text))
  `;
}

const OFFERING_INCLUDE = {
  primaryCategory: { select: { key: true } },
  serviceAreas: true,
  pricing: true,
  includedServices: { include: { category: { select: { key: true } } } },
  audioSamples: {
    where: { cleanupStatus: AudioSampleCleanupStatus.Live },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  },
} satisfies PrismaTypes.ServiceOfferingInclude;

export class PrismaServiceOfferingRepository implements ServiceOfferingRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  async saveDraft(input: ServiceOfferingDraftInput): Promise<ServiceOfferingOwnerViewRecord> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(offeringLockSql(input.offeringId));
      const existing = await tx.serviceOffering.findUnique({
        where: { id: input.offeringId },
        include: { sellerProfile: { select: { workspaceId: true } } },
      });
      if (!existing) {
        throw new ServiceOfferingNotFoundError(input.offeringId);
      }
      if (existing.sellerProfile.workspaceId !== input.workspaceId) {
        throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
      }
      if (existing.status !== "Draft") {
        throw new ServiceOfferingNotDraftError(input.offeringId, existing.status);
      }
      const categoryId = input.primaryCategoryKey
        ? await resolvePrimaryCategoryId(tx, input.primaryCategoryKey)
        : null;
      const unitId =
        input.pricing && input.pricing.unitId
          ? await resolvePricingUnitId(tx, input.pricing.unitId)
          : null;
      const updated = await tx.serviceOffering.update({
        where: { id: input.offeringId },
        data: {
          title: input.title,
          description: input.description,
          primaryCategoryId: categoryId,
          serviceMode: input.serviceMode,
          serviceAreas: {
            deleteMany: {},
            create: input.serviceAreas.map((sa) => ({
              countryCode: sa.countryCode,
              region: sa.region ?? null,
              city: sa.city ?? null,
            })),
          },
          ...(input.pricing
            ? {
                pricing: {
                  upsert: {
                    create: {
                      kind: input.pricing.kind,
                      amountMinor: input.pricing.amountMinor ?? null,
                      currency: input.pricing.currency ?? null,
                      unitId,
                    },
                    update: {
                      kind: input.pricing.kind,
                      amountMinor: input.pricing.amountMinor ?? null,
                      currency: input.pricing.currency ?? null,
                      unitId,
                    },
                  },
                },
              }
            : {}),
          genreTags: [...input.genreTags],
          includedServices: {
            deleteMany: {},
            create: await resolveIncludedServices(tx, input.includedServiceCategoryKeys),
          },
        },
        include: OFFERING_INCLUDE,
      });
      const existingSellerProfile = await tx.sellerProfile.findUnique({
        where: { id: existing.sellerProfileId },
        select: { id: true, workspaceId: true },
      });
      if (!existingSellerProfile) {
        throw new Error(
          `PrismaServiceOfferingRepository.saveDraft: missing seller profile ${existing.sellerProfileId}`,
        );
      }
      return toOwnerView(updated, {
        workspaceId: existingSellerProfile.workspaceId,
        sellerProfileId: existingSellerProfile.id,
      });
    });
  }

  async activate(input: ServiceOfferingActivateInput): Promise<ServiceOfferingActivationResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(offeringLockSql(input.offeringId));

      // Step 1: idempotency pre-check (first defense).
      const existingActivation = await tx.serviceOfferingActivation.findUnique({
        where: {
          offeringId_idempotencyKey: {
            offeringId: input.offeringId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existingActivation) {
        const existingOffering = await tx.serviceOffering.findUnique({
          where: { id: input.offeringId },
          include: {
            ...OFFERING_INCLUDE,
            sellerProfile: { select: { workspaceId: true, id: true } },
          },
        });
        if (!existingOffering) {
          throw new ServiceOfferingNotFoundError(input.offeringId);
        }
        return {
          offering: toOwnerView(existingOffering, {
            workspaceId: existingOffering.sellerProfile.workspaceId,
            sellerProfileId: existingOffering.sellerProfile.id,
          }),
          evidence: toEvidenceView(existingActivation),
          convergedFromExistingActivation: true,
        };
      }

      // Step 2: precondition check.
      const existing = await tx.serviceOffering.findUnique({
        where: { id: input.offeringId },
        include: { sellerProfile: { select: { workspaceId: true, id: true } } },
      });
      if (!existing) {
        throw new ServiceOfferingNotFoundError(input.offeringId);
      }
      if (existing.sellerProfile.workspaceId !== input.workspaceId) {
        throw new ServiceOfferingNotOwnedError(input.offeringId, input.workspaceId);
      }
      if (existing.status !== "Draft") {
        throw new ServiceOfferingNotDraftError(input.offeringId, existing.status);
      }

      // Step 3: snapshot for rollback on any failure mid-write.
      const before = {
        title: existing.title,
        description: existing.description,
        primaryCategoryId: existing.primaryCategoryId,
        serviceMode: existing.serviceMode,
        status: existing.status,
      };

      try {
        const categoryId = await resolvePrimaryCategoryId(tx, input.primaryCategoryKey);
        const unitId = input.pricing.unitId
          ? await resolvePricingUnitId(tx, input.pricing.unitId)
          : null;
        const updated = await tx.serviceOffering.update({
          where: { id: input.offeringId },
          data: {
            status: "Active",
            title: input.title,
            description: input.description,
            primaryCategoryId: categoryId,
            serviceMode: input.serviceMode,
            serviceAreas: {
              deleteMany: {},
              create: input.serviceAreas.map((sa) => ({
                countryCode: sa.countryCode,
                region: sa.region ?? null,
                city: sa.city ?? null,
              })),
            },
            pricing: {
              upsert: {
                create: {
                  kind: input.pricing.kind,
                  amountMinor: input.pricing.amountMinor ?? null,
                  currency: input.pricing.currency ?? null,
                  unitId,
                },
                update: {
                  kind: input.pricing.kind,
                  amountMinor: input.pricing.amountMinor ?? null,
                  currency: input.pricing.currency ?? null,
                  unitId,
                },
              },
            },
            genreTags: [...input.genreTags],
            includedServices: {
              deleteMany: {},
              create: await resolveIncludedServices(tx, input.includedServiceCategoryKeys),
            },
          },
          include: OFFERING_INCLUDE,
        });

        // Step 4: insert the evidence row. The DB unique constraint
        // on (offeringId, idempotencyKey) is the second defense if
        // a concurrent same-key request slipped past the pre-check.
        let activation;
        try {
          activation = await tx.serviceOfferingActivation.create({
            data: {
              offeringId: input.offeringId,
              workspaceId: input.workspaceId,
              sellerProfileId: input.sellerProfileId,
              activatedByUserId: input.activatedByUserId,
              confirmationVersion: input.confirmationVersion,
              activatedAt: input.now,
              idempotencyKey: input.idempotencyKey,
              requestId: input.requestId,
            },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            const winner = await tx.serviceOfferingActivation.findUnique({
              where: {
                offeringId_idempotencyKey: {
                  offeringId: input.offeringId,
                  idempotencyKey: input.idempotencyKey,
                },
              },
            });
            if (winner) {
              return {
                offering: toOwnerView(updated, {
                  workspaceId: input.workspaceId,
                  sellerProfileId: existing.sellerProfile.id,
                }),
                evidence: toEvidenceView(winner),
                convergedFromExistingActivation: true,
              };
            }
          }
          throw err;
        }

        return {
          offering: toOwnerView(updated, {
            workspaceId: input.workspaceId,
            sellerProfileId: existing.sellerProfile.id,
          }),
          evidence: toEvidenceView(activation),
          convergedFromExistingActivation: false,
        };
      } catch (err) {
        await tx.serviceOffering
          .update({
            where: { id: input.offeringId },
            data: before,
          })
          .catch(() => undefined);
        throw err;
      }
    });
  }

  async findForOwner(input: {
    readonly workspaceId: string;
    readonly offeringId: string;
    readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
  }): Promise<ServiceOfferingOwnerViewRecord | null> {
    const row = await this.prisma.serviceOffering.findUnique({
      where: { id: input.offeringId },
      include: {
        ...OFFERING_INCLUDE,
        sellerProfile: { select: { workspaceId: true, id: true } },
      },
    });
    if (!row) return null;
    if (row.sellerProfile.workspaceId !== input.workspaceId) return null;
    return toOwnerView(
      row,
      {
        workspaceId: row.sellerProfile.workspaceId,
        sellerProfileId: row.sellerProfile.id,
      },
      input.playbackUrlFor,
    );
  }

  async listForOwner(input: {
    readonly workspaceId: string;
    readonly playbackUrlFor: (input: { offeringId: string; sampleId: string }) => string;
  }): Promise<readonly ServiceOfferingOwnerViewRecord[]> {
    const rows = await this.prisma.serviceOffering.findMany({
      where: { sellerProfile: { workspaceId: input.workspaceId } },
      include: {
        ...OFFERING_INCLUDE,
        sellerProfile: { select: { workspaceId: true, id: true } },
      },
      orderBy: { title: "asc" },
    });
    return rows.map((row) =>
      toOwnerView(
        row,
        {
          workspaceId: row.sellerProfile.workspaceId,
          sellerProfileId: row.sellerProfile.id,
        },
        input.playbackUrlFor,
      ),
    );
  }

  async countLiveSamples(offeringId: string): Promise<number> {
    return this.prisma.serviceOfferingAudioSample.count({
      where: { offeringId, cleanupStatus: AudioSampleCleanupStatus.Live },
    });
  }
}

async function resolvePrimaryCategoryId(
  tx: PrismaTypes.TransactionClient,
  key: string,
): Promise<string> {
  const found = await tx.serviceCategory.findUnique({ where: { key } });
  if (!found) {
    throw new Error(`PrismaServiceOfferingRepository: unknown ServiceCategory key: ${key}`);
  }
  return found.id;
}

async function resolvePricingUnitId(
  tx: PrismaTypes.TransactionClient,
  key: string,
): Promise<string> {
  const found = await tx.pricingUnit.findUnique({ where: { key } });
  if (!found) {
    throw new Error(`PrismaServiceOfferingRepository: unknown PricingUnit key: ${key}`);
  }
  return found.id;
}

async function resolveIncludedServices(
  tx: PrismaTypes.TransactionClient,
  keys: readonly string[],
): Promise<
  Array<{ category: { connect: { id: string } }; purchaseMode: typeof PurchaseMode.BundleOnly }>
> {
  if (keys.length === 0) return [];
  const found = await tx.serviceCategory.findMany({
    where: { key: { in: [...keys] } },
    select: { id: true, key: true },
  });
  const foundKeys = new Set(found.map((r) => r.key));
  const missing = keys.filter((k) => !foundKeys.has(k));
  if (missing.length > 0) {
    throw new Error(
      `PrismaServiceOfferingRepository: unknown includedService keys: ${missing.join(", ")}`,
    );
  }
  return found.map((row) => ({
    category: { connect: { id: row.id } },
    purchaseMode: PurchaseMode.BundleOnly,
  }));
}

// The OwnerView include shape differs slightly between read (returns
// sellerProfile.workspaceId) and write paths (which carry the full
// included-shape). The helper accepts the basic shape and the
// workspace / sellerProfile ids as separate parameters so the
// `update` result (which omits sellerProfile) and the
// `findForOwner` / `listForOwner` result (which include it) both
// type-check.
type OwnerViewRowShape = {
  readonly id: string;
  readonly status: "Draft" | "Active" | "Paused" | "Archived";
  readonly title: string;
  readonly description: string;
  readonly primaryCategory: { readonly key: string } | null;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid" | null;
  readonly serviceAreas: readonly {
    readonly countryCode: string;
    readonly region: string | null;
    readonly city: string | null;
  }[];
  readonly pricing: {
    readonly offeringId: string;
    readonly kind: "Fixed" | "StartingAt" | "ContactForQuote";
    readonly amountMinor: number | null;
    readonly currency: string | null;
    readonly unitId: string | null;
  } | null;
  readonly genreTags: string[];
  readonly includedServices: readonly {
    readonly category: { readonly key: string };
  }[];
  readonly audioSamples: readonly {
    readonly id: string;
    readonly label: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly displayOrder: number;
    readonly createdAt: Date;
  }[];
};

function toOwnerView(
  row: OwnerViewRowShape,
  ctx: { readonly workspaceId: string; readonly sellerProfileId: string },
  playbackUrlFor?: (input: { offeringId: string; sampleId: string }) => string,
): ServiceOfferingOwnerViewRecord {
  const samples: ServiceOfferingOwnerSampleSummaryV1[] = row.audioSamples.map((s) => ({
    sampleId: s.id,
    label: s.label,
    contentType: "audio/mpeg" as const,
    byteSize: s.byteSize,
    displayOrder: s.displayOrder,
    playbackUrl: playbackUrlFor?.({ offeringId: row.id, sampleId: s.id }) ?? "",
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
    workspaceId: ctx.workspaceId,
    sellerProfileId: ctx.sellerProfileId,
    status: row.status,
    title: row.title,
    description: row.description,
    primaryCategoryKey: row.primaryCategory?.key ?? null,
    serviceMode: row.serviceMode,
    serviceAreas,
    pricing,
    genreTags: [...row.genreTags],
    includedServiceCategoryKeys: row.includedServices.map((is) => is.category.key),
    samples,
    activatedAt: null,
    activatedByDisplayName: null,
  };
}

function toEvidenceView(p: {
  activatedAt: Date;
  confirmationVersion: string;
  idempotencyKey: string;
}): ServiceOfferingActivationEvidenceView {
  return {
    activatedAt: p.activatedAt,
    confirmationVersion: p.confirmationVersion as ServiceOfferingActivationConfirmationVersionV1,
    idempotencyKey: p.idempotencyKey,
  };
}
