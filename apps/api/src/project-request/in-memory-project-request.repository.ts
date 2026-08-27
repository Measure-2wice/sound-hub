// In-memory ProjectRequestRepository for unit tests.
//
// Background: the ProjectRequest service tests run without a database.
// The in-memory adapter mirrors the Prisma adapter's surface so tests
// can substitute it without changing the service or route code. The
// Prisma adapter is the canonical implementation; this is for unit
// tests only.
//
// The adapter enforces the same semantic guards as the Prisma adapter:
//
//   - createProjectRequestWithRevalidation enforces brief-ownership,
//     brief-recommendation (P1-001), and offering-eligibility
//     boundaries in one logical operation. Test fixtures seed
//     `seedBriefRecommendations` so the adapter can answer
//     "is offering X in brief Y's persisted results?" without a
//     database.
//   - acceptProjectRequest / declineProjectRequest atomically
//     transition Pending→Accepted/Declined via guarded semantics; a
//     Pending duplicate for the same tuple is rejected via the same
//     `PendingDuplicateError` type as the Prisma adapter's
//     pre-atomic contract (still thrown here so test fixtures that
//     call the older helper catch the same exception type the
//     service historically translated).

import { randomUUID } from "node:crypto";
import type {
  AcceptProjectRequestInput,
  AcceptProjectRequestResult,
  CreateProjectRequestResult,
  CreateProjectRequestRevalidatedInput,
  DeclineProjectRequestInput,
  DecideResult,
  PersistedDeal,
  PersistedProjectRequest,
  ProjectRequestRepository,
} from "./project-request.repository.js";
import type { ProjectRequestStatusV1 } from "@soundhub/types";
import { PendingDuplicateError } from "./prisma-project-request.repository.js";

export interface OfferingEligibilityInput {
  readonly id: string;
  readonly status: "Active" | "Draft" | "Paused" | "Archived";
  readonly sellerWorkspaceId: string;
  readonly workspaceStatus: "Active" | "Suspended";
  readonly workspaceHasSellerCapability: boolean;
  readonly profileStatus: "Draft" | "Published" | "Suspended";
}

export class InMemoryProjectRequestRepository implements ProjectRequestRepository {
  private readonly requests = new Map<string, PersistedProjectRequest>();
  private readonly deals = new Map<string, PersistedDeal>();
  /** briefId → set of ServiceOffering ids that Matchmaker returned. */
  private readonly briefRecommendations = new Map<string, Set<string>>();
  /** briefId → buyerWorkspaceId ownership. */
  private readonly briefOwnership = new Map<string, string>();
  /** Offering id → eligibility snapshot. */
  private readonly offeringEligibility = new Map<string, OfferingEligibilityInput>();

  /** Test seam: register a brief's ownership + persisted recommendations. */
  seedBrief(input: {
    readonly briefId: string;
    readonly buyerWorkspaceId: string;
    readonly offeringIds: readonly string[];
  }): void {
    this.briefOwnership.set(input.briefId, input.buyerWorkspaceId);
    this.briefRecommendations.set(input.briefId, new Set(input.offeringIds));
  }

  /** Test seam: register an offering's eligibility snapshot. */
  seedOfferingEligibility(input: OfferingEligibilityInput): void {
    this.offeringEligibility.set(input.id, input);
  }

  async createProjectRequestWithRevalidation(
    input: CreateProjectRequestRevalidatedInput,
  ): Promise<CreateProjectRequestResult> {
    // Step 1: Brief existence + ownership.
    const buyerWorkspaceId = this.briefOwnership.get(input.projectBriefId);
    if (!buyerWorkspaceId) {
      return { ok: false, reason: "BRIEF_NOT_FOUND" };
    }
    if (buyerWorkspaceId !== input.buyerWorkspaceId) {
      return { ok: false, reason: "BRIEF_FORBIDDEN" };
    }

    // Step 2: Brief-recommendation boundary (P1-001).
    const recommendations = this.briefRecommendations.get(input.projectBriefId);
    if (!recommendations || !recommendations.has(input.serviceOfferingId)) {
      return { ok: false, reason: "OFFERING_NOT_IN_BRIEF" };
    }

    // Step 3: Offering eligibility chain.
    const offering = this.offeringEligibility.get(input.serviceOfferingId);
    if (!offering) {
      return { ok: false, reason: "OFFERING_INELIGIBLE" };
    }
    if (offering.status !== "Active") {
      return { ok: false, reason: "OFFERING_INELIGIBLE" };
    }
    if (offering.workspaceStatus !== "Active") {
      return { ok: false, reason: "OFFERING_INELIGIBLE" };
    }
    if (!offering.workspaceHasSellerCapability) {
      return { ok: false, reason: "OFFERING_INELIGIBLE" };
    }
    if (offering.profileStatus !== "Published") {
      return { ok: false, reason: "OFFERING_INELIGIBLE" };
    }

    // Step 4: Persist with Pending duplicate guard.
    for (const existing of this.requests.values()) {
      if (
        existing.status === "Pending" &&
        existing.buyerWorkspaceId === input.buyerWorkspaceId &&
        existing.sellerWorkspaceId === offering.sellerWorkspaceId &&
        existing.serviceOfferingId === input.serviceOfferingId &&
        existing.projectBriefId === input.projectBriefId
      ) {
        return { ok: false, reason: "ALREADY_PENDING" };
      }
    }
    const row: PersistedProjectRequest = {
      id: `pr-${randomUUID()}`,
      buyerWorkspaceId: input.buyerWorkspaceId,
      sellerWorkspaceId: offering.sellerWorkspaceId,
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
    return Promise.resolve({ ok: true, value: row });
  }

  /**
   * Backwards-compatible escape hatch for tests that pre-date the
   * atomic revalidation boundary. New tests MUST use
   * {@link createProjectRequestWithRevalidation} so the boundary is
   * actually exercised. Retained only to keep older fixtures
   * compiling until they are migrated.
   *
   * @deprecated Use createProjectRequestWithRevalidation.
   */
  async createProjectRequest(input: {
    readonly buyerWorkspaceId: string;
    readonly sellerWorkspaceId: string;
    readonly serviceOfferingId: string;
    readonly projectBriefId: string;
    readonly createdByUserId: string;
  }): Promise<PersistedProjectRequest> {
    for (const existing of this.requests.values()) {
      if (
        existing.status === "Pending" &&
        existing.buyerWorkspaceId === input.buyerWorkspaceId &&
        existing.sellerWorkspaceId === input.sellerWorkspaceId &&
        existing.serviceOfferingId === input.serviceOfferingId &&
        existing.projectBriefId === input.projectBriefId
      ) {
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
