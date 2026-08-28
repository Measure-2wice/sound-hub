// In-memory ProjectRequestRepository for unit tests.
//
// Background: the ProjectRequest service tests run without a
// database. The in-memory adapter mirrors the Prisma adapter's
// contract surface so tests can substitute it without changing the
// service or route code.
//
// The Prisma adapter is the canonical implementation; this is for
// unit tests only.
//
// --- Guarantee parity (deliberately conservative) ---
//
// The in-memory adapter simulates PostgreSQL row locks with a
// per-test mutex so concurrent unit tests do not see stale
// authority facts. It does NOT replicate PostgreSQL's MVCC
// snapshots, serializable isolation, or row-level locking
// semantics. Any interleaving test that depends on real concurrency
// MUST run against the Prisma adapter (see
// `prisma-project-request.repository.test.ts`); the in-memory
// adapter is only sufficient for the service-level policy tests
// that exercise a single transaction at a time.

import { randomUUID } from "node:crypto";
import type {
  AcceptProjectRequestResult,
  CreateProjectRequestResult,
  CreateProjectRequestTransactionInput,
  CreateProjectRequestUseCase,
  CreateProjectRequestUseCaseTools,
  CreateUseCaseOutcome,
  DecideResult,
  PersistedDeal,
  PersistedProjectRequest,
  ProjectRequestRepository,
  RespondProjectRequestTransactionInput,
  RespondProjectRequestUseCase,
  RespondProjectRequestUseCaseTools,
  RespondUseCaseOutcome,
} from "./project-request.repository.js";
import type {
  BriefRecommendationsSnapshot,
  BuyerAuthoritySnapshot,
  SellerAuthoritySnapshot,
  SellerEligibilitySnapshot,
} from "./project-request-authorization-policy.js";
import type { ProjectRequestStatusV1 } from "@soundhub/types";

export interface WorkspaceSnapshotSeed {
  readonly workspaceId: string;
  readonly status: "Active" | "Suspended";
  readonly ownerUserId: string;
  readonly buyerCapability: boolean;
  readonly sellerCapability: boolean;
}

export interface MembershipSnapshotSeed {
  readonly userId: string;
  readonly workspaceId: string;
}

export interface SellerProfileSnapshotSeed {
  readonly workspaceId: string;
  readonly status: "Draft" | "Published" | "Suspended";
}

export interface ServiceOfferingSnapshotSeed {
  readonly id: string;
  readonly sellerWorkspaceId: string;
  readonly status: "Active" | "Draft" | "Paused" | "Archived";
}

export interface ProjectBriefSnapshotSeed {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly recommendedOfferingIds: readonly string[];
}

export class InMemoryProjectRequestRepository implements ProjectRequestRepository {
  private readonly requests = new Map<string, PersistedProjectRequest>();
  private readonly deals = new Map<string, PersistedDeal>();
  private readonly workspaces = new Map<string, WorkspaceSnapshotSeed>();
  private readonly memberships = new Map<string, MembershipSnapshotSeed>();
  private readonly sellerProfiles = new Map<string, SellerProfileSnapshotSeed>();
  private readonly offerings = new Map<string, ServiceOfferingSnapshotSeed>();
  private readonly briefs = new Map<string, ProjectBriefSnapshotSeed>();
  /** Single-flight mutex so a single in-memory test cannot interleave
   *  authority mutations with a running use case. This is NOT a
   *  guarantee that real concurrency cannot occur — only a guarantee
   *  that a single test cannot observe a state mid-mutation. The
   *  Prisma adapter is the only authoritative interleaving surface. */
  private inflight = false;

  constructor() {
    this.workspaces = new Map();
    this.memberships = new Map();
    this.sellerProfiles = new Map();
    this.offerings = new Map();
    this.briefs = new Map();
  }

  // ---------- test seams ----------

  seedWorkspace(input: WorkspaceSnapshotSeed): void {
    this.workspaces.set(input.workspaceId, input);
  }

  seedMembership(input: MembershipSnapshotSeed): void {
    this.memberships.set(this.membershipKey(input.userId, input.workspaceId), input);
  }

  removeMembership(userId: string, workspaceId: string): void {
    this.memberships.delete(this.membershipKey(userId, workspaceId));
  }

  seedSellerProfile(input: SellerProfileSnapshotSeed): void {
    this.sellerProfiles.set(input.workspaceId, input);
  }

  seedServiceOffering(input: ServiceOfferingSnapshotSeed): void {
    this.offerings.set(input.id, input);
  }

  seedProjectBrief(input: ProjectBriefSnapshotSeed): void {
    this.briefs.set(input.id, input);
  }

  removeProjectBrief(id: string): void {
    this.briefs.delete(id);
  }

  // ---------- create ----------

  async createProjectRequestInTransaction(
    input: CreateProjectRequestTransactionInput,
    useCase: CreateProjectRequestUseCase,
  ): Promise<CreateProjectRequestResult> {
    if (this.inflight) {
      throw new Error(
        "In-memory ProjectRequestRepository already has an inflight transaction; " +
          "the in-memory adapter does not serialize concurrent transactions.",
      );
    }
    this.inflight = true;
    try {
      // Build the snapshots from the in-memory state.
      const buyerAuthority = this.snapshotBuyerAuthority(input);
      const sellerEligibility = this.snapshotSellerEligibility(input);
      const briefRecommendations = this.snapshotBriefRecommendations(input);

      const tools: CreateProjectRequestUseCaseTools = {
        reject: (reason): CreateUseCaseOutcome => ({ kind: "reject", reason }),
        persist: (persistInput): CreateUseCaseOutcome => ({ kind: "persist", input: persistInput }),
      };
      const outcome = useCase({ buyerAuthority, sellerEligibility, briefRecommendations }, tools);

      if (outcome.kind === "reject") {
        return { ok: false, reason: outcome.reason };
      }

      // Pending uniqueness guard (mirrors the partial unique
      // index).
      for (const existing of this.requests.values()) {
        if (
          existing.status === "Pending" &&
          existing.buyerWorkspaceId === outcome.input.buyerWorkspaceId &&
          existing.sellerWorkspaceId === outcome.input.sellerWorkspaceId &&
          existing.serviceOfferingId === outcome.input.serviceOfferingId &&
          existing.projectBriefId === outcome.input.projectBriefId
        ) {
          return { ok: false, reason: "ALREADY_PENDING" };
        }
      }

      const row: PersistedProjectRequest = {
        id: `pr-${randomUUID()}`,
        buyerWorkspaceId: outcome.input.buyerWorkspaceId,
        sellerWorkspaceId: outcome.input.sellerWorkspaceId,
        serviceOfferingId: outcome.input.serviceOfferingId,
        projectBriefId: outcome.input.projectBriefId,
        createdByUserId: outcome.input.userAccountId,
        status: "Pending",
        sellerDecisionAt: null,
        sellerDecisionByUserId: null,
        sellerConsentAt: null,
        createdAt: new Date(),
      };
      this.requests.set(row.id, row);
      return Promise.resolve({ ok: true, value: row });
    } finally {
      this.inflight = false;
    }
  }

  // ---------- respond (accept / decline) ----------

  async respondToProjectRequestInTransaction(
    input: RespondProjectRequestTransactionInput,
    useCase: RespondProjectRequestUseCase,
  ): Promise<DecideResult<AcceptProjectRequestResult | PersistedProjectRequest>> {
    if (this.inflight) {
      throw new Error(
        "In-memory ProjectRequestRepository already has an inflight transaction; " +
          "the in-memory adapter does not serialize concurrent transactions.",
      );
    }
    this.inflight = true;
    try {
      const existing = this.requests.get(input.projectRequestId);
      if (!existing) return Promise.resolve({ ok: false, reason: "NOT_FOUND" });

      const sellerAuthority = this.snapshotSellerAuthority(input, existing.sellerWorkspaceId);

      const tools: RespondProjectRequestUseCaseTools = {
        reject: (reason): RespondUseCaseOutcome => ({ kind: "reject", reason }),
        accept: (acceptInput): RespondUseCaseOutcome => ({ kind: "accept", input: acceptInput }),
        decline: (declineInput): RespondUseCaseOutcome => ({
          kind: "decline",
          input: declineInput,
        }),
      };
      const outcome = useCase({ sellerAuthority, projectRequest: existing }, tools);

      if (outcome.kind === "reject") {
        return { ok: false, reason: outcome.reason };
      }

      if (existing.status !== "Pending") {
        return Promise.resolve({ ok: false, reason: "ALREADY_RESPONDED" });
      }

      if (outcome.kind === "accept") {
        // Unique Deal invariant (mirrors the deals.projectRequestId index).
        for (const deal of this.deals.values()) {
          if (deal.projectRequestId === existing.id) {
            return Promise.resolve({ ok: false, reason: "ALREADY_RESPONDED" });
          }
        }
        const updated: PersistedProjectRequest = {
          ...existing,
          status: "Accepted",
          sellerDecisionAt: outcome.input.now,
          sellerDecisionByUserId: outcome.input.sellerDecisionByUserId,
          sellerConsentAt: outcome.input.now,
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

      // Decline branch.
      const updated: PersistedProjectRequest = {
        ...existing,
        status: "Declined",
        sellerDecisionAt: outcome.input.now,
        sellerDecisionByUserId: outcome.input.sellerDecisionByUserId,
        sellerConsentAt: null,
      };
      this.requests.set(updated.id, updated);
      return Promise.resolve({ ok: true, value: updated });
    } finally {
      this.inflight = false;
    }
  }

  // ---------- reads ----------

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

  // ---------- snapshot helpers ----------

  private membershipKey(userId: string, workspaceId: string): string {
    return `${userId}|${workspaceId}`;
  }

  private snapshotBuyerAuthority(
    input: CreateProjectRequestTransactionInput,
  ): BuyerAuthoritySnapshot {
    const ws = this.workspaces.get(input.buyerWorkspaceId);
    return {
      userAccountId: input.userAccountId,
      buyerWorkspaceId: input.buyerWorkspaceId,
      workspaceStatus: ws?.status ?? "Suspended",
      isMember: this.memberships.has(
        this.membershipKey(input.userAccountId, input.buyerWorkspaceId),
      ),
      hasBuyerCapability: ws?.buyerCapability ?? false,
    };
  }

  private snapshotSellerEligibility(
    input: CreateProjectRequestTransactionInput,
  ): SellerEligibilitySnapshot {
    const offering = this.offerings.get(input.serviceOfferingId);
    if (!offering) {
      return {
        serviceOfferingId: input.serviceOfferingId,
        sellerWorkspaceId: null,
        offeringStatus: null,
        workspaceStatus: null,
        workspaceHasSellerCapability: null,
        profileStatus: null,
      };
    }
    const ws = this.workspaces.get(offering.sellerWorkspaceId);
    const profile = this.sellerProfiles.get(offering.sellerWorkspaceId);
    return {
      serviceOfferingId: input.serviceOfferingId,
      sellerWorkspaceId: offering.sellerWorkspaceId,
      offeringStatus: offering.status,
      workspaceStatus: ws?.status ?? null,
      workspaceHasSellerCapability: ws?.sellerCapability ?? null,
      profileStatus: profile?.status ?? null,
    };
  }

  private snapshotBriefRecommendations(
    input: CreateProjectRequestTransactionInput,
  ): BriefRecommendationsSnapshot {
    const brief = this.briefs.get(input.projectBriefId);
    if (!brief) {
      return {
        projectBriefId: input.projectBriefId,
        buyerWorkspaceId: null,
        exists: false,
        offeringIds: [],
      };
    }
    return {
      projectBriefId: brief.id,
      buyerWorkspaceId: brief.buyerWorkspaceId,
      exists: true,
      offeringIds: [...brief.recommendedOfferingIds],
    };
  }

  private snapshotSellerAuthority(
    input: RespondProjectRequestTransactionInput,
    projectRequestSellerWorkspaceId: string,
  ): SellerAuthoritySnapshot {
    const ws = this.workspaces.get(projectRequestSellerWorkspaceId);
    return {
      userAccountId: input.userAccountId,
      actingWorkspaceId: input.actingWorkspaceId,
      projectRequestSellerWorkspaceId,
      workspaceStatus: ws?.status ?? "Suspended",
      isMember: this.memberships.has(
        this.membershipKey(input.userAccountId, input.actingWorkspaceId),
      ),
      hasSellerCapability: ws?.sellerCapability ?? false,
    };
  }
}
