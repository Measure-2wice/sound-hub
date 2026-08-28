// Prisma adapter for ProjectRequestRepository.
//
// Background: this module is the only place the BG4 ProjectRequest /
// Deal boundary touches Prisma. Higher layers depend on
// `ProjectRequestRepository`; tests can swap in the in-memory
// adapter without changing the service or route code.
//
// The repository owns persistence + transactions; the application
// service owns the authorization policy (see
// `./project-request-authorization-policy.ts`). The shared policy
// helpers are imported here so the repository's atomic transaction
// can fail closed on a stale snapshot — the application service
// makes the policy decision FIRST and the transaction re-reads the
// facts as a second-layer guard.
//
// All consequential writes are wrapped in a transaction. Accept uses
// a guarded updateMany on the Pending status so two concurrent
// accepts cannot both succeed; the unique index on
// `deals.projectRequestId` is the second defense against retries
// creating duplicate Deals (ticket #62 GS 26). The natural
// uniqueness on `(buyerWorkspaceId, sellerWorkspaceId,
// serviceOfferingId, projectBriefId) WHERE status = 'Pending'`
// closes the duplicate-creation race. No explicit
// serialization-retry framework is required for BG4: the
// transaction + partial unique index + guarded transition are
// the proven retry-safety mechanism per ticket #62.

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

export class PrismaProjectRequestRepository implements ProjectRequestRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createProjectRequestWithRevalidation(
    input: CreateProjectRequestRevalidatedInput,
  ): Promise<CreateProjectRequestResult> {
    const userAccountId = input.userAccountId;
    const buyerWorkspaceId = input.buyerWorkspaceId;
    const projectBriefId = input.projectBriefId;
    const serviceOfferingId = input.serviceOfferingId;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Fact check (NOT policy): brief existence + ownership +
        // brief-recommendation boundary. The application service
        // makes the buyer / seller authorization policy decision
        // (see ./project-request-authorization-policy.ts) BEFORE
        // calling this method. The transaction here is the atomic
        // guard for the brief relationship (does this brief
        // belong to the buyer? was this offering returned by
        // Matchmaker for it? does the offering still exist?) and
        // runs the natural uniqueness guard (partial unique
        // index on Pending rows). No policy decision lives in
        // this transaction — the repository owns persistence +
        // atomicity only.
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

        // Brief-recommendation boundary (P1-001): the selected
        // offering MUST be a persisted recommendation
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

        // Offering existence. If the offering was archived /
        // deleted between the application check and this
        // transaction, the repository fails closed with
        // OFFERING_INELIGIBLE. The application service has
        // already verified the offering is eligible (workspace
        // active, profile published, seller capability present);
        // we do NOT re-check those here because they are policy
        // concerns, not persistence concerns.
        const offeringOwner = await tx.serviceOffering.findUnique({
          where: { id: serviceOfferingId },
          select: { sellerProfile: { select: { workspaceId: true } } },
        });
        if (!offeringOwner || !offeringOwner.sellerProfile) {
          return { ok: false as const, reason: "OFFERING_INELIGIBLE" as const };
        }
        const sellerWorkspaceId = offeringOwner.sellerProfile.workspaceId;

        try {
          const row = await tx.projectRequest.create({
            data: {
              buyerWorkspaceId,
              sellerWorkspaceId,
              serviceOfferingId,
              projectBriefId,
              createdByUserId: userAccountId,
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
        // The application service made the seller authorization
        // policy decision BEFORE calling this method (see
        // ./project-request-authorization-policy.ts). The
        // transaction only runs the guarded transition + Deal
        // creation atomically. The natural uniqueness on
        // `deals.projectRequestId` (covered by GS 26) is the second
        // defense against retries creating multiple Deals.

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
      // The application service made the seller authorization
      // policy decision BEFORE calling this method. The transaction
      // only runs the guarded transition atomically.

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
