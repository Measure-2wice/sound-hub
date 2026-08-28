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
//   - createProjectRequestWithRevalidation enforces buyer authority
//     (P1-001), brief-ownership, brief-recommendation, and
//     offering-eligibility boundaries in one logical operation.
//     Test fixtures seed `seedBuyerAuthorization` /
//     `seedOfferingEligibility` / `seedBrief` so the adapter can
//     answer the relevant checks without a database.
//   - acceptProjectRequest / declineProjectRequest atomically
//     transition Pending→Accepted/Declined via guarded semantics
//     and revalidate seller authority inside the same operation
//     (P1-002).

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

export interface OfferingEligibilityInput {
  readonly id: string;
  readonly status: "Active" | "Draft" | "Paused" | "Archived";
  readonly sellerWorkspaceId: string;
  readonly workspaceStatus: "Active" | "Suspended";
  readonly workspaceHasSellerCapability: boolean;
  readonly profileStatus: "Draft" | "Published" | "Suspended";
}

interface BuyerAuthorizationSnapshot {
  readonly status: "Active" | "Suspended";
  readonly members: Set<string>;
  readonly capabilities: Set<"Buyer" | "Seller">;
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
  /** workspaceId → buyer authority snapshot. */
  private readonly buyerAuthorizations = new Map<string, BuyerAuthorizationSnapshot>();
  /** projectRequestId → seller authority snapshot. */
  private readonly sellerAuthorizations = new Map<string, BuyerAuthorizationSnapshot>();

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

  /**
   * Test seam: register the buyer Workspace's current authority
   * snapshot (status + members + capabilities). The repository's
   * P1-001 buyer-authority check uses this map exactly the way the
   * Prisma adapter uses the live WorkspaceMembership +
   * WorkspaceCapability rows.
   */
  seedBuyerAuthorization(input: {
    readonly workspaceId: string;
    readonly status: "Active" | "Suspended";
    readonly memberIds: readonly string[];
    readonly capabilities: readonly ("Buyer" | "Seller")[];
  }): void {
    this.buyerAuthorizations.set(input.workspaceId, {
      status: input.status,
      members: new Set(input.memberIds),
      capabilities: new Set(input.capabilities),
    });
  }

  /**
   * Test seam: register the seller Workspace's current authority
   * snapshot for the seller-side decision checks (P1-002).
   */
  seedSellerAuthorization(input: {
    readonly workspaceId: string;
    readonly status: "Active" | "Suspended";
    readonly memberIds: readonly string[];
    readonly capabilities: readonly ("Buyer" | "Seller")[];
  }): void {
    this.sellerAuthorizations.set(input.workspaceId, {
      status: input.status,
      members: new Set(input.memberIds),
      capabilities: new Set(input.capabilities),
    });
  }

  async createProjectRequestWithRevalidation(
    input: CreateProjectRequestRevalidatedInput,
  ): Promise<CreateProjectRequestResult> {
    // Step 1: Buyer authority (P1-001). The repository re-checks
    // workspace status, current membership, and the Buyer capability
    // inside the same operation as the brief / eligibility /
    // INSERT, so a revoke between an upstream authorize call and
    // this call cannot slip through.
    if (!this.buyerAuthorizations.has(input.buyerWorkspaceId)) {
      return { ok: false, reason: "BUYER_NOT_AUTHORIZED" };
    }
    const authorization = this.buyerAuthorizations.get(input.buyerWorkspaceId)!;
    if (authorization.status !== "Active") {
      return { ok: false, reason: "BUYER_NOT_AUTHORIZED" };
    }
    if (!authorization.members.has(input.userAccountId)) {
      return { ok: false, reason: "BUYER_NOT_AUTHORIZED" };
    }
    if (!authorization.capabilities.has("Buyer")) {
      return { ok: false, reason: "BUYER_NOT_AUTHORIZED" };
    }

    // Step 2: Brief existence + ownership.
    const buyerWorkspaceId = this.briefOwnership.get(input.projectBriefId);
    if (!buyerWorkspaceId) {
      return { ok: false, reason: "BRIEF_NOT_FOUND" };
    }
    if (buyerWorkspaceId !== input.buyerWorkspaceId) {
      return { ok: false, reason: "BRIEF_FORBIDDEN" };
    }

    // Step 3: Brief-recommendation boundary (P1-001).
    const recommendations = this.briefRecommendations.get(input.projectBriefId);
    if (!recommendations || !recommendations.has(input.serviceOfferingId)) {
      return { ok: false, reason: "OFFERING_NOT_IN_BRIEF" };
    }

    // Step 4: Offering eligibility chain.
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

    // Step 5: Persist with Pending duplicate guard.
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
      createdByUserId: input.userAccountId,
      status: "Pending",
      sellerDecisionAt: null,
      sellerDecisionByUserId: null,
      sellerConsentAt: null,
      createdAt: new Date(),
    };
    this.requests.set(row.id, row);
    return Promise.resolve({ ok: true, value: row });
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
    // P1-002: revalidate the seller Workspace authority inside the
    // same operation as the guarded Pending→Accepted transition.
    // Mirrors the Prisma adapter's pre-check.
    const sellerAuth = this.sellerAuthorizations.get(input.actingWorkspaceId);
    if (!sellerAuth || sellerAuth.status !== "Active") {
      return Promise.resolve({ ok: false, reason: "SELLER_NOT_AUTHORIZED" });
    }
    if (!sellerAuth.members.has(input.userAccountId)) {
      return Promise.resolve({ ok: false, reason: "SELLER_NOT_AUTHORIZED" });
    }
    if (!sellerAuth.capabilities.has("Seller")) {
      return Promise.resolve({ ok: false, reason: "SELLER_NOT_AUTHORIZED" });
    }

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
    // P1-002: revalidate the seller Workspace authority inside the
    // same operation as the guarded Pending→Declined transition.
    const sellerAuth = this.sellerAuthorizations.get(input.actingWorkspaceId);
    if (!sellerAuth || sellerAuth.status !== "Active") {
      return Promise.resolve({ ok: false, reason: "SELLER_NOT_AUTHORIZED" });
    }
    if (!sellerAuth.members.has(input.userAccountId)) {
      return Promise.resolve({ ok: false, reason: "SELLER_NOT_AUTHORIZED" });
    }
    if (!sellerAuth.capabilities.has("Seller")) {
      return Promise.resolve({ ok: false, reason: "SELLER_NOT_AUTHORIZED" });
    }

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
