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
// boundary (P1-002). The transaction uses PostgreSQL's
// `Serializable` isolation level with bounded retry on a
// serialization conflict (SQLSTATE 40001) so a concurrent
// authority / eligibility mutation that lands between the
// revalidation reads and the INSERT aborts the write rather than
// committing an ineligible Pending row (P1-001). The Prisma
// adapter is the only layer that knows the SQL/Prisma boundary;
// the application service has no Prisma dependency (P1-003).

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
import {
  evaluateBuyerAuthority,
  evaluateSellerAuthority,
} from "./project-request-authorization-policy.js";

// Bounded retry on PostgreSQL serialization conflicts
// (SQLSTATE 40001). Three attempts give the losing transaction a
// chance to re-run against a fresh snapshot while still failing
// closed under sustained contention.
const SERIALIZABLE_RETRY_LIMIT = 3;

async function runSerializable<T>(
  prisma: PrismaClient,
  work: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  let lastErr: unknown = undefined;
  for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => work(tx as unknown as PrismaClient), {
        isolationLevel: "Serializable",
      });
    } catch (err) {
      lastErr = err;
      if (!isSerializationFailure(err)) throw err;
    }
  }
  throw lastErr;
}

function isSerializationFailure(err: unknown): boolean {
  // Prisma surfaces PostgreSQL SQLSTATE 40001 as `code: "P2034"`
  // (transaction conflict). The driver may also forward the raw
  // pg error code via message inspection; both shapes are checked
  // so a future Prisma upgrade does not silently bypass the
  // detection.
  if (err instanceof PrismaClientKnownRequestError && err.code === "P2034") return true;
  if (err && typeof err === "object") {
    const anyErr = err as { code?: unknown; message?: unknown };
    if (typeof anyErr.code === "string" && anyErr.code === "40001") return true;
    if (typeof anyErr.message === "string" && anyErr.message.includes("40001")) return true;
  }
  return false;
}

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
      const result = await runSerializable(this.prisma, async (tx) => {
        // Step 1: Buyer authority inside the write transaction.
        // The repository re-checks Workspace.status, the buyer's
        // current WorkspaceMembership, and the buyer Workspace's
        // Buyer capability, so a revoke that races an upstream
        // authorize call cannot slip through (P1-001). The
        // enclosing transaction runs at PostgreSQL's Serializable
        // isolation level so a concurrent revoke / status flip /
        // capability removal aborts this write rather than
        // letting an ineligible Pending row commit.
        const buyerWorkspace = await tx.workspace.findUnique({
          where: { id: buyerWorkspaceId },
          select: { id: true, status: true },
        });
        const buyerMembership = await tx.workspaceMembership.findUnique({
          where: {
            userId_workspaceId: { userId: userAccountId, workspaceId: buyerWorkspaceId },
          },
          select: { userId: true },
        });
        const buyerCapability = await tx.workspaceCapability.findUnique({
          where: {
            workspaceId_capability: { workspaceId: buyerWorkspaceId, capability: "Buyer" },
          },
          select: { workspaceId: true },
        });
        const buyerVerdict = evaluateBuyerAuthority({
          userAccountId,
          buyerWorkspaceId,
          workspaceStatus: buyerWorkspace?.status ?? "Suspended",
          isMember: buyerMembership !== null,
          hasBuyerCapability: buyerCapability !== null,
        });
        if (!buyerVerdict.ok) {
          return { ok: false as const, reason: "BUYER_NOT_AUTHORIZED" as const };
        }

        // Step 2: Brief existence + ownership. The brief is the
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

        // Step 3: Brief-recommendation boundary (P1-001). The
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

        // Step 4: Eligibility chain (workspace active + Seller
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

        // Step 5: Persist. The partial unique index
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
    const actingWorkspaceId = input.actingWorkspaceId;
    const userAccountId = input.userAccountId;
    const now = input.now;

    try {
      const result = await runSerializable(this.prisma, async (tx) => {
        // P1-002: seller authority inside the same transaction as
        // the guarded Pending→Accepted transition. Re-check the
        // seller Workspace status, the seller's current
        // WorkspaceMembership, and the seller Workspace's Seller
        // capability so a revoke between the upstream authorize call
        // and this write cannot slip through. The Serializable
        // isolation level aborts the write if a concurrent
        // membership revoke / capability removal / workspace
        // suspension lands between the revalidation reads and the
        // guarded update.
        const sellerWorkspace = await tx.workspace.findUnique({
          where: { id: actingWorkspaceId },
          select: { id: true, status: true },
        });
        const sellerMembership = await tx.workspaceMembership.findUnique({
          where: {
            userId_workspaceId: { userId: userAccountId, workspaceId: actingWorkspaceId },
          },
          select: { userId: true },
        });
        const sellerCapability = await tx.workspaceCapability.findUnique({
          where: {
            workspaceId_capability: { workspaceId: actingWorkspaceId, capability: "Seller" },
          },
          select: { workspaceId: true },
        });
        const sellerVerdict = evaluateSellerAuthority({
          userAccountId,
          actingWorkspaceId,
          workspaceStatus: sellerWorkspace?.status ?? "Suspended",
          isMember: sellerMembership !== null,
          hasSellerCapability: sellerCapability !== null,
        });
        if (!sellerVerdict.ok) {
          return { ok: false as const, reason: "SELLER_NOT_AUTHORIZED" as const };
        }

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
    const actingWorkspaceId = input.actingWorkspaceId;
    const userAccountId = input.userAccountId;
    const now = input.now;

    const result = await runSerializable(this.prisma, async (tx) => {
      // P1-002: seller authority inside the same transaction as
      // the guarded Pending→Declined transition. Serializable
      // isolation aborts the write if a concurrent revoke lands
      // between the revalidation reads and the guarded update.
      const sellerWorkspace = await tx.workspace.findUnique({
        where: { id: actingWorkspaceId },
        select: { id: true, status: true },
      });
      const sellerMembership = await tx.workspaceMembership.findUnique({
        where: {
          userId_workspaceId: { userId: userAccountId, workspaceId: actingWorkspaceId },
        },
        select: { userId: true },
      });
      const sellerCapability = await tx.workspaceCapability.findUnique({
        where: {
          workspaceId_capability: { workspaceId: actingWorkspaceId, capability: "Seller" },
        },
        select: { workspaceId: true },
      });
      const sellerVerdict = evaluateSellerAuthority({
        userAccountId,
        actingWorkspaceId,
        workspaceStatus: sellerWorkspace?.status ?? "Suspended",
        isMember: sellerMembership !== null,
        hasSellerCapability: sellerCapability !== null,
      });
      if (!sellerVerdict.ok) {
        return { ok: false as const, reason: "SELLER_NOT_AUTHORIZED" as const };
      }

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
