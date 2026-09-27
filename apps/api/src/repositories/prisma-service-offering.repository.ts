// Prisma implementation of ServiceOfferingRepository.
//
// This is the only place in the application that issues Prisma queries
// against `service_offerings`, `service_offering_service_areas`,
// `offering_pricing`, `included_services`,
// `service_offering_activations`, and
// `service_offering_creations` for the seller-offering slice. The
// route depends on this adapter through the `ServiceOfferingRepository`
// interface so the HTTP layer never reaches into Prisma directly,
// satisfying the contract rule that routes never query Prisma.
//
// Transaction model: each write operation opens ONE `Prisma.$transaction`
// and uses `pg_advisory_xact_lock` to serialize concurrent attempts on
// the same resource. `createDraft` and `saveDraft` lock the
// per-workspace scope; `activate` locks the per-offering scope. This
// mirrors the `provisionIntentAtomically` primitive at
// `apps/api/src/auth-repository/prisma-auth-repository.ts:498` and the
// SellerProfile writePublication primitive at
// `apps/api/src/repositories/prisma-seller-profile.repository.ts:182`.
//
// Retry semantics: the application-layer pre-check on
// `(workspaceId, idempotencyKey)` for createDraft and
// `(offeringId, idempotencyKey)` for activate is the first defense.
// The DB unique indexes
// `service_offering_creations_workspace_idem_unique_idx` and
// `service_offering_activations_offering_idem_unique_idx` are the
// second defense — if a concurrent same-key request wins the race,
// the unique-constraint violation is caught and the existing row is
// re-read.
//
// PR-review feedback #4 (activation atomicity): the activation
// transaction re-counts CONFIRMED Live samples INSIDE the same
// advisory lock as the Draft → Active transition. A concurrent
// remove between a service-layer pre-check and the activation
// commit used to be able to produce a newly Active offering with
// zero qualifying samples; the repository-level recheck closes
// that window.
//
// Acting-user attribution: the activation / creation evidence rows
// store the UserAccount id; the route layer can join the existing
// `bg1PublicUserV1` (which carries `email`) when constructing the
// public response. The `activatedByUserId` / `createdByUserId` FKs
// are the audit attribution.

import { type PrismaClient, Prisma, AudioSampleCleanupStatus, PurchaseMode } from "@soundhub/db";
import type { Prisma as PrismaTypes } from "@soundhub/db";
import { randomBytes } from "node:crypto";
import type {
  ServiceOfferingActivationConfirmationVersionV1,
  ServiceOfferingOwnerSampleSummaryV1,
} from "@soundhub/types";
import type {
  ServiceOfferingActivateInput,
  ServiceOfferingActivationEvidenceView,
  ServiceOfferingActivationResult,
  ServiceOfferingCreateDraftInput,
  ServiceOfferingDraftInput,
  ServiceOfferingOwnerViewRecord,
  ServiceOfferingRepository,
} from "./service-offering.repository.js";
import {
  buildActivationCompletenessFieldErrors,
  ServiceOfferingIncompleteError,
  ServiceOfferingNotDraftError,
  ServiceOfferingNotFoundError,
  ServiceOfferingNotOwnedError,
  ServiceOfferingSellerProfileMissingError,
  ServiceOfferingUnknownKeyError,
} from "./service-offering.repository.js";
import type { ApiFieldErrorV1 } from "@soundhub/types";
import { BG2_AUDIO_SAMPLE_MAX_PER_OFFERING } from "@soundhub/types";
import { SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS } from "@soundhub/types";
import { acquireAudioSampleLockTx } from "../audio-repository/audio-sample-lock.js";

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

/**
 * Cryptographically random cuid-style suffix used to mint stable
 * ServiceOffering ids. The Prisma `default(cuid())` is overridden
 * here because the repository sets the id explicitly so it can
 * surface the value to the caller in a single round-trip.
 */
function randomCuidSuffix(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * Stable per-workspace lock key for `createDraft` so concurrent
 * "Create service" clicks on the same Workspace serialize.
 */
function workspaceCreateLockSql(workspaceId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`service-offering-create:${workspaceId}`}::text))
  `;
}

const OFFERING_INCLUDE = {
  primaryCategory: { select: { key: true } },
  serviceAreas: true,
  pricing: true,
  includedServices: { include: { category: { select: { key: true } } } },
  // M2 (#85) PR-review feedback: only CONFIRMED Live samples
  // appear in the OwnerView so the editor's readiness checklist
  // reads from the same predicate the activation recheck uses.
  // A confirmation version + actor + timestamp must all be
  // present (legacy samples without confirmation are filtered).
  audioSamples: {
    where: {
      cleanupStatus: AudioSampleCleanupStatus.Live,
      confirmationVersion: { not: null },
      confirmedByUserId: { not: null },
      confirmedAt: { not: null },
    },
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  },
  // M2 (#85): the latest activation row carries `activatedAt` +
  // `activatedByDisplayName` so the owner view is derived from
  // durable records (not from denormalized cache columns). The
  // `orderBy: activatedAt desc + take: 1` is the canonical "latest
  // activation" lookup pattern from the SellerProfilePublication
  // precedent. A Draft offering has no activation row, so the
  // include returns an empty array and the toOwnerView helper
  // surfaces `activatedAt: null` for Draft owners.
  activations: {
    orderBy: { activatedAt: "desc" },
    take: 1,
    include: {
      activatedBy: {
        select: { email: true },
      },
    },
  },
} satisfies PrismaTypes.ServiceOfferingInclude;

export class PrismaServiceOfferingRepository implements ServiceOfferingRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  /**
   * M2 (#85) PR-review feedback: lazy first-create. The
   * `(workspaceId, idempotencyKey)` unique index on
   * `service_offering_creations` is the convergence key — a
   * transport retry with the same idempotencyKey returns the
   * SAME offeringId; a deliberate second click (a new
   * idempotencyKey) creates a NEW offering. The per-workspace
   * advisory lock serializes concurrent first-create attempts so
   * the unique-constraint fallback is the only DB-level
   * serialization.
   */
  async createDraft(
    input: ServiceOfferingCreateDraftInput,
  ): Promise<ServiceOfferingOwnerViewRecord> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(workspaceCreateLockSql(input.workspaceId));

      // Step 1: idempotency pre-check.
      const existingCreation = await tx.serviceOfferingCreation.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existingCreation) {
        const existingOffering = await tx.serviceOffering.findUnique({
          where: { id: existingCreation.offeringId },
          include: {
            ...OFFERING_INCLUDE,
            sellerProfile: { select: { workspaceId: true, id: true } },
          },
        });
        if (!existingOffering) {
          throw new ServiceOfferingNotFoundError(existingCreation.offeringId);
        }
        if (existingOffering.sellerProfile.workspaceId !== input.workspaceId) {
          // The previously-created offering does not belong to
          // this Workspace — defensive guard against the
          // evidence row pointing at a row owned elsewhere.
          throw new ServiceOfferingNotOwnedError(existingOffering.id, input.workspaceId);
        }
        return toOwnerView(
          existingOffering,
          {
            workspaceId: existingOffering.sellerProfile.workspaceId,
            sellerProfileId: existingOffering.sellerProfile.id,
          },
          input.playbackUrlFor,
        );
      }

      // Step 2: precondition — Workspace must have a SellerProfile.
      const sellerProfile = await tx.sellerProfile.findUnique({
        where: { workspaceId: input.workspaceId },
        select: { id: true, workspaceId: true },
      });
      if (!sellerProfile) {
        throw new ServiceOfferingSellerProfileMissingError(input.workspaceId);
      }

      // Step 3: create the offering with the first-save draft
      // fields applied atomically. M2 (#85) PR-review feedback
      // (round 3): the spec requires the stable identity to be
      // created on the first successful save, so the title /
      // description / category / mode / pricing / service areas /
      // genre tags the seller just typed are persisted in this
      // same transaction — a deliberate second click (a new
      // idempotencyKey) creates a NEW offering row AND starts a
      // fresh field-set, so no orphan empty rows accumulate.
      const id = `so_${randomCuidSuffix()}`;
      const slug = `${id}-draft`;
      const categoryId = input.primaryCategoryKey
        ? await resolvePrimaryCategoryId(tx, input.primaryCategoryKey)
        : null;
      const unitId =
        input.pricing && input.pricing.unitId
          ? await resolvePricingUnitId(tx, input.pricing.unitId)
          : null;

      await tx.serviceOffering.create({
        data: {
          id,
          slug,
          sellerProfileId: sellerProfile.id,
          title: input.title,
          description: input.description,
          status: "Draft",
          primaryCategoryId: categoryId,
          serviceMode: input.serviceMode,
          genreTags: [...input.genreTags],
          serviceAreas: {
            create: input.serviceAreas.map((sa) => ({
              countryCode: sa.countryCode,
              region: sa.region ?? null,
              city: sa.city ?? null,
            })),
          },
          pricing: input.pricing
            ? {
                create: {
                  kind: input.pricing.kind,
                  amountMinor: input.pricing.amountMinor ?? null,
                  currency: input.pricing.currency ?? null,
                  unitId,
                },
              }
            : undefined,
          includedServices: {
            create: await resolveIncludedServices(tx, input.includedServiceCategoryKeys),
          },
        },
        include: OFFERING_INCLUDE,
      });

      // Step 4: insert the creation-evidence row. The
      // (workspaceId, idempotencyKey) unique constraint is the
      // second defense if a concurrent same-key request slipped
      // past the pre-check.
      try {
        await tx.serviceOfferingCreation.create({
          data: {
            offeringId: id,
            workspaceId: input.workspaceId,
            createdByUserId: input.createdByUserId,
            idempotencyKey: input.idempotencyKey,
            requestId: input.requestId,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          const winner = await tx.serviceOfferingCreation.findUnique({
            where: {
              workspaceId_idempotencyKey: {
                workspaceId: input.workspaceId,
                idempotencyKey: input.idempotencyKey,
              },
            },
          });
          if (winner) {
            const existingOffering = await tx.serviceOffering.findUnique({
              where: { id: winner.offeringId },
              include: {
                ...OFFERING_INCLUDE,
                sellerProfile: { select: { workspaceId: true, id: true } },
              },
            });
            if (existingOffering) {
              return toOwnerView(
                existingOffering,
                {
                  workspaceId: existingOffering.sellerProfile.workspaceId,
                  sellerProfileId: existingOffering.sellerProfile.id,
                },
                input.playbackUrlFor,
              );
            }
          }
        }
        throw err;
      }

      // Step 5: re-read the new offering via OFFERING_INCLUDE so
      // the OwnerView shape matches the read paths.
      const created = await tx.serviceOffering.findUnique({
        where: { id },
        include: {
          ...OFFERING_INCLUDE,
          sellerProfile: { select: { workspaceId: true, id: true } },
        },
      });
      if (!created) {
        throw new ServiceOfferingNotFoundError(id);
      }
      return toOwnerView(
        created,
        {
          workspaceId: created.sellerProfile.workspaceId,
          sellerProfileId: created.sellerProfile.id,
        },
        input.playbackUrlFor,
      );
    });
  }

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
      // When the draft omits pricing entirely, mirror the
      // in-memory adapter by clearing any persisted pricing row.
      // Prisma throws when `delete: true` runs against a missing
      // row; gate the delete on existence so the operation is
      // idempotent.
      if (input.pricing === null) {
        const existingPricing = await tx.serviceOfferingPricing.findUnique({
          where: { offeringId: input.offeringId },
          select: { offeringId: true },
        });
        if (existingPricing) {
          await tx.serviceOfferingPricing.delete({
            where: { offeringId: input.offeringId },
          });
        }
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
      return toOwnerView(
        updated,
        {
          workspaceId: existingSellerProfile.workspaceId,
          sellerProfileId: existingSellerProfile.id,
        },
        input.playbackUrlFor,
      );
    });
  }

  async activate(input: ServiceOfferingActivateInput): Promise<ServiceOfferingActivationResult> {
    return this.prisma.$transaction(async (tx) => {
      // M2 (#85) PR-review feedback (round 2): acquire BOTH the
      // service-offering lock AND the per-offering audio-sample
      // advisory lock so the activation serializes with any
      // concurrent audio-sample create/remove. Without the
      // audio-sample lock, a remove could commit after the
      // activation's eligibility count but before the activation
      // commits, leaving a newly Active offering with zero Live
      // samples. Lock acquisition order is consistent (offering
      // first, audio-sample second) — the createSampleWithCap /
      // markPendingCleanup / finalizePendingCleanup paths acquire
      // only the audio-sample lock, so the activation's outer
      // service-offering lock does not introduce a new
      // dependency for them.
      await tx.$executeRaw(offeringLockSql(input.offeringId));
      await acquireAudioSampleLockTx(tx, input.offeringId);

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

      // Step 3 (PR-review feedback #4): full completeness
      // revalidation INSIDE the activation transaction. The
      // advisory lock acquired at the top serializes concurrent
      // removes against this check, so a remove that lands
      // between the service-layer pre-check and the activation
      // commit cannot produce a newly Active offering with zero
      // qualifying samples. The field-level checks mirror the
      // service-layer pre-check so the editor renders the same
      // multi-error summary either way; the sample-count check is
      // the new source-of-truth recheck that closes the race
      // window. The repository raises
      // `ServiceOfferingIncompleteError` carrying the full
      // field-error list; the service translates to
      // `SERVICE_OFFERING_INCOMPLETE`.
      const fieldErrors: ApiFieldErrorV1[] = buildActivationCompletenessFieldErrors({
        title: input.title,
        description: input.description,
        primaryCategoryKey: input.primaryCategoryKey,
        serviceMode: input.serviceMode,
        serviceAreas: input.serviceAreas,
        pricingKind: input.pricing.kind,
      });
      const confirmedLiveCount = await tx.serviceOfferingAudioSample.count({
        where: {
          offeringId: input.offeringId,
          cleanupStatus: AudioSampleCleanupStatus.Live,
          confirmationVersion: { not: null },
          confirmedByUserId: { not: null },
          confirmedAt: { not: null },
        },
      });
      if (confirmedLiveCount < 1 || confirmedLiveCount > BG2_AUDIO_SAMPLE_MAX_PER_OFFERING) {
        fieldErrors.push({
          path: "samples",
          code: "samples_required",
          message: `Activation requires 1 to ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING} playable samples.`,
        });
      }
      if (fieldErrors.length > 0) {
        throw new ServiceOfferingIncompleteError(
          [
            `field errors: ${fieldErrors.length}`,
            `live confirmed sample count ${confirmedLiveCount} outside [1, ${BG2_AUDIO_SAMPLE_MAX_PER_OFFERING}]`,
          ],
          fieldErrors,
        );
      }

      // Step 4: snapshot for rollback on any failure mid-write.
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

        // Step 5: insert the evidence row. The DB unique constraint
        // on (offeringId, idempotencyKey) is the second defense if
        // a concurrent same-key request slipped past the pre-check.
        let activation;
        try {
          activation = await tx.serviceOfferingActivation.create({
            data: {
              offeringId: input.offeringId,
              workspaceId: input.workspaceId,
              sellerProfileId: existing.sellerProfile.id,
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
                offering: toOwnerView(
                  updated,
                  {
                    workspaceId: input.workspaceId,
                    sellerProfileId: existing.sellerProfile.id,
                  },
                  input.playbackUrlFor,
                ),
                evidence: toEvidenceView(winner),
                convergedFromExistingActivation: true,
              };
            }
          }
          throw err;
        }

        return {
          offering: toOwnerView(
            updated,
            {
              workspaceId: input.workspaceId,
              sellerProfileId: existing.sellerProfile.id,
            },
            input.playbackUrlFor,
          ),
          evidence: toEvidenceView(activation),
          convergedFromExistingActivation: false,
        };
      } catch (err) {
        // The repository's source-of-truth recheck already raised
        // `ServiceOfferingIncompleteError` before any state change
        // for completeness failures; the snapshot rollback below
        // covers any other mid-write failure.
        if (err instanceof ServiceOfferingIncompleteError) {
          throw err;
        }
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

  async countLiveConfirmedSamples(offeringId: string): Promise<number> {
    return this.prisma.serviceOfferingAudioSample.count({
      where: {
        offeringId,
        cleanupStatus: AudioSampleCleanupStatus.Live,
        confirmationVersion: { not: null },
        confirmedByUserId: { not: null },
        confirmedAt: { not: null },
      },
    });
  }
}

async function resolvePrimaryCategoryId(
  tx: PrismaTypes.TransactionClient,
  key: string,
): Promise<string> {
  const found = await tx.serviceCategory.findUnique({ where: { key } });
  if (!found) {
    throw new ServiceOfferingUnknownKeyError("primaryCategoryKey", key);
  }
  return found.id;
}

async function resolvePricingUnitId(
  tx: PrismaTypes.TransactionClient,
  key: string,
): Promise<string> {
  const found = await tx.pricingUnit.findUnique({ where: { key } });
  if (!found) {
    throw new ServiceOfferingUnknownKeyError("pricingUnitId", key);
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
    throw new ServiceOfferingUnknownKeyError("includedServiceCategoryKeys", missing.join(", "));
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
    readonly confirmationVersion: string | null;
    readonly confirmedAt: Date | null;
    readonly createdAt: Date;
  }[];
  // The OFFERING_INCLUDE loads the single most recent activation row
  // via `orderBy: activatedAt desc + take: 1`. A Draft offering
  // (no activation yet) returns an empty array so the owner view
  // surfaces `activatedAt: null` for Draft owners. The human
  // attribution is the actor's email — never the raw UserAccount
  // id — to keep the private identifier off the public DTO.
  readonly activations: readonly {
    readonly activatedAt: Date;
    readonly activatedBy: { readonly email: string | null } | null;
  }[];
};

function toOwnerView(
  row: OwnerViewRowShape,
  ctx: { readonly workspaceId: string; readonly sellerProfileId: string },
  playbackUrlFor?: (input: { offeringId: string; sampleId: string }) => string,
): ServiceOfferingOwnerViewRecord {
  const samples: ServiceOfferingOwnerSampleSummaryV1[] = row.audioSamples.map((s) => {
    // The OFFERING_INCLUDE.audioSamples filter requires all three
    // confirmation columns to be non-null, so a sample that
    // reaches this map is CONFIRMED. If a legacy row slips
    // through (e.g. via a future schema change), the helper
    // throws so the inconsistency is loud rather than silently
    // surfaced as a confirmation-less DTO.
    if (
      s.confirmationVersion === null ||
      s.confirmedAt === null ||
      !SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS.includes(
        s.confirmationVersion as (typeof SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS)[number],
      )
    ) {
      throw new Error(
        `ServiceOfferingAudioSample ${s.id} reached the OwnerView mapper without a valid confirmation; the OFFERING_INCLUDE filter must reject legacy rows.`,
      );
    }
    return {
      sampleId: s.id,
      label: s.label,
      contentType: "audio/mpeg" as const,
      byteSize: s.byteSize,
      displayOrder: s.displayOrder,
      playbackUrl: playbackUrlFor?.({ offeringId: row.id, sampleId: s.id }) ?? "",
      confirmation: {
        version:
          s.confirmationVersion as (typeof SERVICE_OFFERING_AUDIO_MEDIA_CONFIRMATION_VERSIONS)[number],
        confirmedAt: s.confirmedAt.toISOString(),
      },
      createdAt: s.createdAt.toISOString(),
    };
  });
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
  const latestActivation = row.activations[0];
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
    activatedAt: latestActivation ? latestActivation.activatedAt : null,
    activatedByDisplayName: latestActivation ? (latestActivation.activatedBy?.email ?? null) : null,
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
