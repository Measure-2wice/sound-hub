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

import type { PrismaClient } from "@soundhub/db";
import { PrismaClientKnownRequestError } from "@soundhub/db/dist/generated/internal/prismaNamespace.js";
import type { ProjectRequestStatusV1, DealStatusV1 } from "@soundhub/types";
import type {
  AcceptProjectRequestInput,
  AcceptProjectRequestResult,
  CreateProjectRequestInput,
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

  async createProjectRequest(input: CreateProjectRequestInput): Promise<PersistedProjectRequest> {
    try {
      const row = await this.prisma.projectRequest.create({
        data: {
          buyerWorkspaceId: input.buyerWorkspaceId,
          sellerWorkspaceId: input.sellerWorkspaceId,
          serviceOfferingId: input.serviceOfferingId,
          projectBriefId: input.projectBriefId,
          createdByUserId: input.createdByUserId,
        },
      });
      return toPersisted(row);
    } catch (err) {
      // The partial unique index `project_requests_pending_unique_idx`
      // rejects a duplicate Pending row for the same tuple. Surface
      // the violation as a domain-meaningful error so the service
      // can fail closed with PROJECT_REQUEST_ALREADY_PENDING
      // (covered by GS 26).
      if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
        throw new PendingDuplicateError();
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

/**
 * Thrown when the partial unique index rejects a Pending duplicate.
 * The service catches this and translates it to
 * PROJECT_REQUEST_ALREADY_PENDING so the route can fail closed with
 * a buyer-safe 409 envelope.
 */
export class PendingDuplicateError extends Error {
  constructor() {
    super("A Pending ProjectRequest already exists for this tuple.");
    this.name = "PendingDuplicateError";
  }
}
