// In-memory ProjectRequestRepository for unit tests.
//
// Background: the ProjectRequest service tests run without a database.
// The in-memory adapter mirrors the Prisma adapter's surface so tests
// can substitute it without changing the service or route code. The
// Prisma adapter is the canonical implementation; this is for unit
// tests only.
//
// The adapter enforces the same semantic guards as the Prisma adapter
// (a Pending duplicate for the same tuple is rejected; an accept or
// decline on a non-Pending row returns ALREADY_RESPONDED) so the
// service-level tests can prove the GS 26 contract without a
// database.

import { randomUUID } from "node:crypto";
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
import type { ProjectRequestStatusV1 } from "@soundhub/types";
import { PendingDuplicateError } from "./prisma-project-request.repository.js";

export class InMemoryProjectRequestRepository implements ProjectRequestRepository {
  private readonly requests = new Map<string, PersistedProjectRequest>();
  private readonly deals = new Map<string, PersistedDeal>();

  async createProjectRequest(input: CreateProjectRequestInput): Promise<PersistedProjectRequest> {
    for (const existing of this.requests.values()) {
      if (
        existing.status === "Pending" &&
        existing.buyerWorkspaceId === input.buyerWorkspaceId &&
        existing.sellerWorkspaceId === input.sellerWorkspaceId &&
        existing.serviceOfferingId === input.serviceOfferingId &&
        existing.projectBriefId === input.projectBriefId
      ) {
        // Mirror the Prisma adapter's behavior: throw the same
        // PendingDuplicateError type so the service catches it
        // and surfaces PROJECT_REQUEST_ALREADY_PENDING.
        throw new PendingDuplicateError();
      }
    }
    const row: PersistedProjectRequest = {
      id: `pr-${randomUUID()}`,
      buyerWorkspaceId: input.buyerWorkspaceId,
      sellerWorkspaceId: input.sellerWorkspaceId,
      serviceOfferingId: input.serviceOfferingId,
      projectBriefId: input.projectBriefId,
      createdByUserId: input.createdByUserId,
      status: "Pending",
      sellerDecisionAt: null,
      sellerDecisionByUserId: null,
      sellerConsentAt: null,
      createdAt: new Date(),
    };
    this.requests.set(row.id, row);
    return Promise.resolve(row);
  }

  async findProjectRequestById(projectRequestId: string): Promise<PersistedProjectRequest | null> {
    return Promise.resolve(this.requests.get(projectRequestId) ?? null);
  }

  async listProjectRequests(input: {
    readonly workspaceId: string;
    readonly statusFilter?: ProjectRequestStatusV1;
  }): Promise<readonly PersistedProjectRequest[]> {
    const all = [...this.requests.values()]
      .filter(
        (row) =>
          row.buyerWorkspaceId === input.workspaceId || row.sellerWorkspaceId === input.workspaceId,
      )
      .filter((row) => (input.statusFilter ? row.status === input.statusFilter : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(all);
  }

  async acceptProjectRequest(
    input: AcceptProjectRequestInput,
  ): Promise<DecideResult<AcceptProjectRequestResult>> {
    const existing = this.requests.get(input.projectRequestId);
    if (!existing) return Promise.resolve({ ok: false, reason: "NOT_FOUND" });
    if (existing.status !== "Pending") {
      return Promise.resolve({ ok: false, reason: "ALREADY_RESPONDED" });
    }
    // Guard against a duplicate Deal if a concurrent accept slipped
    // past the status check — same guarantee the unique index
    // provides in PostgreSQL.
    for (const deal of this.deals.values()) {
      if (deal.projectRequestId === existing.id) {
        return Promise.resolve({ ok: false, reason: "ALREADY_RESPONDED" });
      }
    }
    const updated: PersistedProjectRequest = {
      ...existing,
      status: "Accepted",
      sellerDecisionAt: input.now,
      sellerDecisionByUserId: input.sellerDecisionByUserId,
      sellerConsentAt: input.now,
    };
    this.requests.set(updated.id, updated);
    const deal: PersistedDeal = {
      id: `deal-${randomUUID()}`,
      buyerWorkspaceId: updated.buyerWorkspaceId,
      sellerWorkspaceId: updated.sellerWorkspaceId,
      serviceOfferingId: updated.serviceOfferingId,
      projectBriefId: updated.projectBriefId,
      projectRequestId: updated.id,
      status: "Negotiating",
      activatedAt: null,
      createdAt: new Date(),
    };
    this.deals.set(deal.id, deal);
    return Promise.resolve({ ok: true, value: { projectRequest: updated, deal } });
  }

  async declineProjectRequest(
    input: DeclineProjectRequestInput,
  ): Promise<DecideResult<PersistedProjectRequest>> {
    const existing = this.requests.get(input.projectRequestId);
    if (!existing) return Promise.resolve({ ok: false, reason: "NOT_FOUND" });
    if (existing.status !== "Pending") {
      return Promise.resolve({ ok: false, reason: "ALREADY_RESPONDED" });
    }
    const updated: PersistedProjectRequest = {
      ...existing,
      status: "Declined",
      sellerDecisionAt: input.now,
      sellerDecisionByUserId: input.sellerDecisionByUserId,
      sellerConsentAt: null,
    };
    this.requests.set(updated.id, updated);
    return Promise.resolve({ ok: true, value: updated });
  }
}
