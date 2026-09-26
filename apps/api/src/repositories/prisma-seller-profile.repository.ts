// Prisma implementation of SellerProfileRepository.
//
// This is the only place in the application that issues Prisma queries
// against `seller_profiles`, `seller_profile_specialties`,
// `caribbean_affiliations`, and `seller_profile_publications` for the
// seller-profile slice. The route depends on this adapter through the
// `SellerProfileRepository` interface so the HTTP layer never reaches
// into Prisma directly, satisfying the contract rule that routes
// never query Prisma.
//
// Transaction model: each write operation opens ONE `Prisma.$transaction`
// and uses `pg_advisory_xact_lock` to serialize concurrent attempts on
// the same Workspace. This mirrors the `provisionIntentAtomically`
// primitive at `apps/api/src/auth-repository/prisma-auth-repository.ts:498`.
// FOR UPDATE row locks on the Workspace + WorkspaceMembership rows
// follow the `DealTermsRepository` pattern at
// `apps/api/src/deal-terms/deal-terms.repository.ts:281-285`.
//
// Retry semantics: the application-layer pre-check on
// `(workspaceId, idempotencyKey)` is the first defense. The DB unique
// index `seller_profile_publications_workspace_idem_unique_idx` is the
// second defense — if a concurrent same-key request wins the race, the
// unique-constraint violation is caught and the existing row is
// re-read.
//
// Acting-user attribution: UserAccount has no `displayName` column
// today. The evidence row stores the UserAccount id; the route layer
// can join the existing `bg1PublicUserV1` (which carries `email`)
// when constructing the public response. The `publishedByUserId`
// FK is the audit attribution.

import { type PrismaClient, Prisma } from "@soundhub/db";
import type { Prisma as PrismaTypes } from "@soundhub/db";
import type { SellerProfilePublicationModel as PrismaSellerProfilePublication } from "@soundhub/db/dist/generated/models/SellerProfilePublication.js";
import type {
  SellerProfileDisciplineV1,
  SellerProfileIdentityV1,
  SellerProfilePublicationConfirmationVersionV1,
} from "@soundhub/types";
import type {
  SellerProfileDraftInput,
  SellerProfileOwnerViewRecord,
  SellerProfilePublicationEvidenceView,
  SellerProfilePublicationInput,
  SellerProfilePublicationResult,
  SellerProfileRepository,
} from "./seller-profile.repository.js";
import {
  SellerProfileNotDraftError,
  SellerProfileNotPublishedError,
} from "./seller-profile.repository.js";

/**
 * Stable per-Workspace lock key for `pg_advisory_xact_lock`. Mirrors
 * the `provisionIntentAtomically` primitive at
 * `apps/api/src/auth-repository/prisma-auth-repository.ts:511` —
 * Postgres's built-in `hashtext` returns int4, which is always in
 * signed-32-bit range and fits the `pg_advisory_xact_lock(int4, int4)`
 * two-argument form, sidestepping the signed-64-bit overflow that a
 * JS-side 64-bit FNV-1a would otherwise produce.
 */
function workspaceLockSql(workspaceId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`seller-profile:${workspaceId}`}::text))
  `;
}

const PROFILE_INCLUDE = {
  specialties: { include: { specialty: { select: { key: true, name: true } } } },
  caribbeanAffiliations: true,
} satisfies PrismaTypes.SellerProfileInclude;

type ProfileRow = PrismaTypes.SellerProfileGetPayload<{
  include: typeof PROFILE_INCLUDE;
}>;

export class PrismaSellerProfileRepository implements SellerProfileRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  async findCurrentProfile(workspaceId: string): Promise<SellerProfileOwnerViewRecord | null> {
    const row = await this.prisma.sellerProfile.findUnique({
      where: { workspaceId },
      include: PROFILE_INCLUDE,
    });
    return row ? toOwnerView(row) : null;
  }

  async saveDraft(input: SellerProfileDraftInput): Promise<SellerProfileOwnerViewRecord> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(workspaceLockSql(input.workspaceId));

      const existing = await tx.sellerProfile.findUnique({
        where: { workspaceId: input.workspaceId },
      });

      if (existing) {
        if (existing.status === "Published" || existing.status === "Suspended") {
          throw new SellerProfileNotDraftError(input.workspaceId, existing.status);
        }
        const specialtyCreates = await this.specialtyConnects(tx, input.disciplines.specialtyKeys);
        const updated = await tx.sellerProfile.update({
          where: { id: existing.id },
          data: {
            professionalName: input.identity.professionalName,
            bio: input.identity.bio,
            ...(input.identity.avatarUrl !== undefined
              ? { avatarUrl: input.identity.avatarUrl }
              : existing.avatarUrl !== null
                ? { avatarUrl: existing.avatarUrl }
                : {}),
            basedInCountryCode: input.basedIn.countryCode,
            basedInRegion: input.basedIn.region ?? null,
            basedInCity: input.basedIn.city ?? null,
            specialties: {
              deleteMany: {},
              create: specialtyCreates,
            },
            caribbeanAffiliations: {
              deleteMany: {},
              create: input.disciplines.caribbeanAffiliationCodes.map((countryCode) => ({
                countryCode,
              })),
            },
          },
          include: PROFILE_INCLUDE,
        });
        return toOwnerView(updated);
      }

      // Lazy first-save. The `INSERT ... ON CONFLICT DO NOTHING`
      // primitive is enforced by Prisma `upsert` on the
      // `workspaceId @unique` constraint.
      const specialtyCreates = await this.specialtyConnects(tx, input.disciplines.specialtyKeys);
      const created = await tx.sellerProfile.upsert({
        where: { workspaceId: input.workspaceId },
        create: {
          workspaceId: input.workspaceId,
          professionalName: input.identity.professionalName,
          bio: input.identity.bio,
          ...(input.identity.avatarUrl !== undefined
            ? { avatarUrl: input.identity.avatarUrl }
            : {}),
          basedInCountryCode: input.basedIn.countryCode,
          basedInRegion: input.basedIn.region ?? null,
          basedInCity: input.basedIn.city ?? null,
          specialties: {
            create: specialtyCreates,
          },
          caribbeanAffiliations: {
            create: input.disciplines.caribbeanAffiliationCodes.map((countryCode) => ({
              countryCode,
            })),
          },
        },
        update: {
          // No-op on conflict: the WHERE row exists; we return
          // the existing row's current state.
        },
        include: PROFILE_INCLUDE,
      });
      return toOwnerView(created);
    });
  }

  async publishProfile(
    input: SellerProfilePublicationInput,
  ): Promise<SellerProfilePublicationResult> {
    return this.writePublication(input, /* requireDraft */ true);
  }

  async updatePublishedProfile(
    input: SellerProfilePublicationInput,
  ): Promise<SellerProfilePublicationResult> {
    return this.writePublication(input, /* requireDraft */ false);
  }

  private async writePublication(
    input: SellerProfilePublicationInput,
    requireDraft: boolean,
  ): Promise<SellerProfilePublicationResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(workspaceLockSql(input.workspaceId));

      // Step 1: idempotency pre-check (first defense).
      const existingPublication = await tx.sellerProfilePublication.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (existingPublication) {
        const existingProfile = await tx.sellerProfile.findUnique({
          where: { workspaceId: input.workspaceId },
          include: PROFILE_INCLUDE,
        });
        if (!existingProfile) {
          throw new Error(
            `PrismaSellerProfileRepository.writePublication: existing publication without profile for workspace=${input.workspaceId}`,
          );
        }
        return {
          profile: toOwnerView(existingProfile),
          evidence: toEvidenceView(existingPublication),
          convergedFromExistingPublication: true,
        };
      }

      // Step 2: precondition check.
      const existing = await tx.sellerProfile.findUnique({
        where: { workspaceId: input.workspaceId },
      });
      if (!existing) {
        throw new Error(
          `PrismaSellerProfileRepository.writePublication: no draft row for workspace=${input.workspaceId}`,
        );
      }
      if (requireDraft && existing.status !== "Draft") {
        throw new SellerProfileNotDraftError(input.workspaceId, existing.status);
      }
      if (!requireDraft && existing.status !== "Published") {
        throw new SellerProfileNotPublishedError(input.workspaceId);
      }

      // Step 3: snapshot for rollback on any failure mid-write.
      const before = {
        professionalName: existing.professionalName,
        bio: existing.bio,
        avatarUrl: existing.avatarUrl,
        basedInCountryCode: existing.basedInCountryCode,
        basedInRegion: existing.basedInRegion,
        basedInCity: existing.basedInCity,
        status: existing.status,
        publishedAt: existing.publishedAt,
        publishedByUserId: existing.publishedByUserId,
      };

      try {
        const specialtyCreates = await this.specialtyConnects(tx, input.disciplines.specialtyKeys);
        const updated = await tx.sellerProfile.update({
          where: { id: existing.id },
          data: {
            status: "Published",
            professionalName: input.identity.professionalName,
            bio: input.identity.bio,
            ...(input.identity.avatarUrl !== undefined
              ? { avatarUrl: input.identity.avatarUrl }
              : existing.avatarUrl !== null
                ? { avatarUrl: existing.avatarUrl }
                : {}),
            basedInCountryCode: input.basedIn.countryCode,
            basedInRegion: input.basedIn.region ?? null,
            basedInCity: input.basedIn.city ?? null,
            publishedAt: input.now,
            specialties: {
              deleteMany: {},
              create: specialtyCreates,
            },
            caribbeanAffiliations: {
              deleteMany: {},
              create: input.disciplines.caribbeanAffiliationCodes.map((countryCode) => ({
                countryCode,
              })),
            },
          },
          include: PROFILE_INCLUDE,
        });

        // Insert the evidence row. The DB unique constraint on
        // (workspaceId, idempotencyKey) is the second defense if
        // a concurrent same-key request slipped past the
        // pre-check.
        let publication;
        try {
          publication = await tx.sellerProfilePublication.create({
            data: {
              publishedByUserId: input.publishedByUserId,
              workspaceId: input.workspaceId,
              sellerProfileId: existing.id,
              confirmationVersion: input.confirmationVersion,
              publishedAt: input.now,
              idempotencyKey: input.idempotencyKey,
              requestId: input.requestId,
            },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            const winner = await tx.sellerProfilePublication.findUnique({
              where: {
                workspaceId_idempotencyKey: {
                  workspaceId: input.workspaceId,
                  idempotencyKey: input.idempotencyKey,
                },
              },
            });
            if (winner) {
              return {
                profile: toOwnerView(updated),
                evidence: toEvidenceView(winner),
                convergedFromExistingPublication: true,
              };
            }
          }
          throw err;
        }

        return {
          profile: toOwnerView(updated),
          evidence: toEvidenceView(publication),
          convergedFromExistingPublication: false,
        };
      } catch (err) {
        await tx.sellerProfile
          .update({
            where: { id: existing.id },
            data: before,
          })
          .catch(() => undefined);
        throw err;
      }
    });
  }

  private async specialtyConnects(
    tx: PrismaTypes.TransactionClient,
    keys: readonly string[],
  ): Promise<Array<{ specialty: { connect: { key: string } } }>> {
    if (keys.length === 0) return [];
    const found = await tx.specialty.findMany({
      where: { key: { in: [...keys] } },
      select: { key: true },
    });
    const foundKeys = new Set(found.map((row) => row.key));
    const missing = keys.filter((key) => !foundKeys.has(key));
    if (missing.length > 0) {
      throw new Error(
        `PrismaSellerProfileRepository.specialtyConnects: unknown specialty keys: ${missing.join(", ")}`,
      );
    }
    return keys.map((key) => ({ specialty: { connect: { key } } }));
  }
}

function toOwnerView(row: ProfileRow): SellerProfileOwnerViewRecord {
  const basedIn: { countryCode: string; region?: string; city?: string } = {
    countryCode: row.basedInCountryCode,
  };
  if (row.basedInRegion !== null) basedIn.region = row.basedInRegion;
  if (row.basedInCity !== null) basedIn.city = row.basedInCity;
  const disciplines: SellerProfileDisciplineV1 = {
    specialtyKeys: row.specialties.map((s) => s.specialty.key),
    caribbeanAffiliationCodes: row.caribbeanAffiliations.map((c) => c.countryCode),
  };
  const identity: SellerProfileIdentityV1 = {
    professionalName: row.professionalName,
    bio: row.bio,
  };
  if (row.avatarUrl !== null) identity.avatarUrl = row.avatarUrl;
  return {
    sellerProfileId: row.id,
    workspaceId: row.workspaceId,
    status: row.status,
    identity,
    basedIn,
    disciplines,
    publishedAt: row.publishedAt,
    publishedByUserId: row.publishedByUserId,
    publishedByDisplayName: null,
  };
}

function toEvidenceView(p: PrismaSellerProfilePublication): SellerProfilePublicationEvidenceView {
  return {
    publishedAt: p.publishedAt,
    confirmationVersion: p.confirmationVersion as SellerProfilePublicationConfirmationVersionV1,
    idempotencyKey: p.idempotencyKey,
  };
}
