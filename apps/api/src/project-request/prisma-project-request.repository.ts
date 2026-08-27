// Prisma adapter for ProjectRequestRepository.
//
// Background: this module is the only place the BG4 ProjectRequest /
// Deal boundary touches Prisma. Higher layers depend on
// `ProjectRequestRepository`; tests can swap in the in-memory
// adapter without changing the service or route code.
//
// All consequential writes are wrapped in a transaction. Accept uses
// a guarded updateMany on the Pending status so two concurrent
// accepts cannot both succeed; the unique index on
// `deals.projectRequestId` is the second defense against retries
// creating duplicate Deals (ticket #62 GS 26).
//
// `createProjectRequestWithRevalidation` runs every revalidation
// read (Brief ownership + persisted BriefSearchResult matching +
// ServiceOffering eligibility chain) AND the INSERT inside one
// `$transaction` so a concurrent mutation cannot bypass the
// boundary (P1-002). The Prisma adapter is the only layer that
// knows the SQL/Prisma boundary; the service has no Prisma
// dependency (P1-003).

import type { PrismaClient } from "@soundhub/db";
import { PrismaClientKnownRequestError } from "@soundhub/db/dist/generated/internal/prismaNamespace.js";
import type { ProjectRequestStatusV1, DealStatusV1 } from "@soundhub/types";
import type {
  AcceptProjectRequestInput,
  AcceptProjectRequestResult,
  CreateProjectRequestFailureReason,
  CreateProjectRequestResult,
  CreateProjectRequestRevalidatedInput,
  DeclineProjectRequestInput,
  DecideResult,
  PersistedDeal,
  PersistedProjectRequest,
  ProjectRequestRepository,
} from "./project-request.repository.js";

// Cast helper: PG row.status is the Prisma enum string union;
// the persisted view uses the shared v1 string-union type.
type DbStatus = "Pending" | "Accepted" | "Declined";
type DbDealStatus = "Negotiating" | "Active";

function toProjectRequestStatus(value: DbStatus): ProjectRequestStatusV1 {
  return value;
}
function toDealStatus(value: DbDealStatus): DealStatusV1 {
  return value;
}

/**
 * Thrown when the partial unique index rejects a Pending duplicate
 * inside an in-memory adapter that does not own the partial-index
 * SQL. The Prisma adapter never throws this exception — its
 * `createProjectRequestWithRevalidation` translates the P2002
 * violation into the `ALREADY_PENDING` discriminated-union reason.
 * The export remains so the in-memory adapter can mirror the same
 * surface for service-level tests.
 */
export class PendingDuplicateError extends Error {
  constructor() {
    super("A Pending ProjectRequest already exists for this tuple.");
    this.name = "PendingDuplicateError";
  }
}

export class PrismaProjectRequestRepository implements ProjectRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createProjectRequestWithRevalidation(
    input: CreateProjectRequestRevalidatedInput,
  ): Promise<CreateProjectRequestResult> {
    const buyerWorkspaceId = input.buyerWorkspaceId;
    const projectBriefId = input.projectBriefId;
    const serviceOfferingId = input.serviceOfferingId;
    const createdByUserId = input.createdByUserId;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Step 1: Brief existence + ownership. The brief is the
        // buyer's anchor; without it the buyer has no persisted
        // search criteria to anchor on.
        const brief = await tx.projectBrief.findUnique({
          where: { id: projectBriefId },
          select: { id: true, buyerWorkspaceId: true },
        });
        if (!brief) {
          return { ok: false as const, reason: "BRIEF_NOT_FOUND" as const };
        }
        if (brief.buyerWorkspaceId !== buyerWorkspaceId) {
          return { ok: false as const, reason: "BRIEF_FORBIDDEN" as const };
        }

        // Step 2: Brief-recommendation boundary (P1-001). The
        // selected offering MUST be a persisted recommendation
        // (bestOfferingId) OR appear in the additionalOfferingsJson
        // of any BriefSearchResult for this brief. A buyer cannot
        // submit an arbitrary eligible offering that Matchmaker
        // never returned for this brief.
        const briefResults = await tx.briefSearchResult.findMany({
          where: { briefId: projectBriefId },
          select: { bestOfferingId: true, additionalOfferingsJson: true },
        });
        const offeringIsInBrief = briefResults.some((row) => {
          if (row.bestOfferingId === serviceOfferingId) return true;
          const additional = row.additionalOfferingsJson;
          if (!Array.isArray(additional)) return false;
          // Each entry may carry its own `offeringId`; we accept
          // either a bare string id (legacy shape) or an object
          // carrying { offeringId } / { id }.
          for (const entry of additional) {
            if (typeof entry === "string" && entry === serviceOfferingId) return true;
            if (
              entry &&
              typeof entry === "object" &&
              "offeringId" in entry &&
              (entry as { offeringId: unknown }).offeringId === serviceOfferingId
            ) {
              return true;
            }
            if (
              entry &&
              typeof entry === "object" &&
              "id" in entry &&
              (entry as { id: unknown }).id === serviceOfferingId
            ) {
              return true;
            }
          }
          return false;
        });
        if (!offeringIsInBrief) {
          return { ok: false as const, reason: "OFFERING_NOT_IN_BRIEF" as const };
        }

        // Step 3: Eligibility chain (workspace active + Seller
        // capability + SellerProfile Published + ServiceOffering
        // Active). Same shape as the previous service-level
        // eligibility check, now under transaction control so a
        // concurrent mutation that flips one of these conditions
        // between the read and the INSERT would still be caught by
        // the re-read after the eligibility check, OR by the FK
        // constraint when the buyer/seller workspace is removed.
        const offering = await tx.serviceOffering.findUnique({
          where: { id: serviceOfferingId },
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
        if (!offering) {
          return { ok: false as const, reason: "OFFERING_INELIGIBLE" as const };
        }
        if (offering.status !== "Active") {
          return { ok: false as const, reason: "OFFERING_INELIGIBLE" as const };
        }
        if (offering.sellerProfile.status !== "Published") {
          return { ok: false as const, reason: "OFFERING_INELIGIBLE" as const };
        }
        if (offering.sellerProfile.workspace.status !== "Active") {
          return { ok: false as const, reason: "OFFERING_INELIGIBLE" as const };
        }
        const hasSeller = offering.sellerProfile.workspace.capabilities.some(
          (c) => c.capability === "Seller",
        );
        if (!hasSeller) {
          return { ok: false as const, reason: "OFFERING_INELIGIBLE" as const };
        }

        // Step 4: Persist. The partial unique index
        // `project_requests_pending_unique_idx` rejects a duplicate
        // Pending row for the same tuple; we translate the P2002
        // violation into ALREADY_PENDING so the service fails closed
        // (covered by GS 26).
        const sellerWorkspaceId = offering.sellerProfile.workspace.id;
        try {
          const row = await tx.projectRequest.create({
            data: {
              buyerWorkspaceId,
              sellerWorkspaceId,
              serviceOfferingId,
              projectBriefId,
              createdByUserId,
            },
          });
          return { ok: true as const, value: toPersisted(row) };
        } catch (err) {
          if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
            return {
              ok: false as const,
              reason: "ALREADY_PENDING" as CreateProjectRequestFailureReason,
            };
          }
          throw err;
        }
      });
      return result;
    } catch (err) {
      // Same defense in the rare case the partial unique index
      // violation escapes the inner catch (e.g. transaction rollback
      // races).
      if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
        return { ok: false, reason: "ALREADY_PENDING" };
      }
      throw err;
    }
  }

  async findProjectRequestById(projectRequestId: string): Promise<PersistedProjectRequest | null> {
    const row = await this.prisma.projectRequest.findUnique({
      where: { id: projectRequestId },
    });
    if (!row) return null;
    return toPersisted(row);
  }

  async listProjectRequests(input: {
    readonly workspaceId: string;
    readonly statusFilter?: ProjectRequestStatusV1;
  }): Promise<readonly PersistedProjectRequest[]> {
    const rows = await this.prisma.projectRequest.findMany({
      where: {
        OR: [{ buyerWorkspaceId: input.workspaceId }, { sellerWorkspaceId: input.workspaceId }],
        ...(input.statusFilter ? { status: input.statusFilter } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toPersisted);
  }

  async acceptProjectRequest(
    input: AcceptProjectRequestInput,
  ): Promise<DecideResult<AcceptProjectRequestResult>> {
    const projectRequestId = input.projectRequestId;
    const sellerDecisionByUserId = input.sellerDecisionByUserId;
    const now = input.now;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Guarded transition: the WHERE status='Pending' clause is
        // the gate. A retried accept on an already-Accepted request
        // updates 0 rows and the service fails closed. A retried
        // accept on a Declined request behaves the same.
        const guarded = await tx.projectRequest.updateMany({
          where: { id: projectRequestId, status: "Pending" },
          data: {
            status: "Accepted",
            sellerDecisionAt: now,
            sellerDecisionByUserId,
            sellerConsentAt: now,
          },
        });
        if (guarded.count === 0) {
          const exists = await tx.projectRequest.findUnique({ where: { id: projectRequestId } });
          if (!exists) {
            return { ok: false as const, reason: "NOT_FOUND" as const };
          }
          return { ok: false as const, reason: "ALREADY_RESPONDED" as const };
        }
        const updated = await tx.projectRequest.findUniqueOrThrow({
          where: { id: projectRequestId },
        });
        const deal = await tx.deal.create({
          data: {
            buyerWorkspaceId: updated.buyerWorkspaceId,
            sellerWorkspaceId: updated.sellerWorkspaceId,
            serviceOfferingId: updated.serviceOfferingId,
            projectBriefId: updated.projectBriefId,
            projectRequestId: updated.id,
          },
        });
        return {
          ok: true as const,
          value: {
            projectRequest: toPersisted(updated),
            deal: toPersistedDeal(deal),
          },
        };
      });
      return result;
    } catch (err) {
      // The unique index on `deals.projectRequestId` is the second
      // defense. If a concurrent accept slipped past the guarded
      // update (theoretically impossible — guarded update uses
      // PostgreSQL row-locking semantics inside the transaction,
      // and updateMany acquires the lock before reading the row),
      // the create would fail with P2002 and we surface it as
      // ALREADY_RESPONDED so the service fails closed.
      if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
        return { ok: false, reason: "ALREADY_RESPONDED" };
      }
      throw err;
    }
  }

  async declineProjectRequest(
    input: DeclineProjectRequestInput,
  ): Promise<DecideResult<PersistedProjectRequest>> {
    const projectRequestId = input.projectRequestId;
    const sellerDecisionByUserId = input.sellerDecisionByUserId;
    const now = input.now;

    const result = await this.prisma.$transaction(async (tx) => {
      const guarded = await tx.projectRequest.updateMany({
        where: { id: projectRequestId, status: "Pending" },
        data: {
          status: "Declined",
          sellerDecisionAt: now,
          sellerDecisionByUserId,
          // sellerConsentAt is intentionally null on decline —
          // explicit consent belongs only to acceptance.
        },
      });
      if (guarded.count === 0) {
        const exists = await tx.projectRequest.findUnique({ where: { id: projectRequestId } });
        if (!exists) {
          return { ok: false as const, reason: "NOT_FOUND" as const };
        }
        return { ok: false as const, reason: "ALREADY_RESPONDED" as const };
      }
      const updated = await tx.projectRequest.findUniqueOrThrow({
        where: { id: projectRequestId },
      });
      return { ok: true as const, value: toPersisted(updated) };
    });
    return result;
  }
}

// ---------- helpers ----------

function toPersisted(row: {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly createdByUserId: string;
  readonly status: DbStatus;
  readonly sellerDecisionAt: Date | null;
  readonly sellerDecisionByUserId: string | null;
  readonly sellerConsentAt: Date | null;
  readonly createdAt: Date;
}): PersistedProjectRequest {
  return {
    id: row.id,
    buyerWorkspaceId: row.buyerWorkspaceId,
    sellerWorkspaceId: row.sellerWorkspaceId,
    serviceOfferingId: row.serviceOfferingId,
    projectBriefId: row.projectBriefId,
    createdByUserId: row.createdByUserId,
    status: toProjectRequestStatus(row.status),
    sellerDecisionAt: row.sellerDecisionAt,
    sellerDecisionByUserId: row.sellerDecisionByUserId,
    sellerConsentAt: row.sellerConsentAt,
    createdAt: row.createdAt,
  };
}

function toPersistedDeal(row: {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly projectRequestId: string;
  readonly status: DbDealStatus;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}): PersistedDeal {
  return {
    id: row.id,
    buyerWorkspaceId: row.buyerWorkspaceId,
    sellerWorkspaceId: row.sellerWorkspaceId,
    serviceOfferingId: row.serviceOfferingId,
    projectBriefId: row.projectBriefId,
    projectRequestId: row.projectRequestId,
    status: toDealStatus(row.status),
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
  };
}
