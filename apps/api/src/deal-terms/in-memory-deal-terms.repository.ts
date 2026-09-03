// In-memory DealTermsRepository for unit tests.
//
// Background: the DealTerms service tests run without a database. The
// in-memory adapter mirrors the Prisma adapter's contract surface so
// tests can substitute it without changing the service or route code.
//
// The Prisma adapter is the canonical implementation; this is for unit
// tests only.
//
// --- Guarantee parity (deliberately conservative) ---
//
// The in-memory adapter simulates per-test synchronization with a
// single-flight mutex so concurrent unit tests do not see stale
// authority facts. It does NOT replicate PostgreSQL's MVCC snapshots,
// serializable isolation, or row-level locking semantics. Any
// interleaving test that depends on real concurrency MUST run against
// the Prisma adapter; the in-memory adapter is only sufficient for
// the service-level policy tests that exercise a single transaction
// at a time.

import { randomUUID } from "node:crypto";
import type { DealStatusV1, DealPublicV1, ProjectRequestPublicV1 } from "@soundhub/types";
import type {
  DealTermsRepository,
  DealViewSnapshot,
  DraftTermsResult,
  DraftTermsTransactionInput,
  DraftTermsUseCase,
  DraftTermsUseCaseOutcome,
  DraftTermsUseCaseTools,
  FindDealViewResult,
  FindDealViewTransactionInput,
  FindDealViewUseCase,
  FindDealViewUseCaseOutcome,
  FindDealViewUseCaseTools,
  PersistedDealApproval,
  PersistedDealSummary,
  PersistedTermsVersion,
  RecordApprovalResult,
  RecordApprovalTransactionInput,
  RecordApprovalUseCase,
  RecordApprovalUseCaseOutcome,
  RecordApprovalUseCaseTools,
} from "./deal-terms.repository.js";
import type {
  ApprovalAuthoritySnapshot,
  DraftingAuthoritySnapshot,
} from "./deal-terms-authorization-policy.js";

// ---------- Test seams ----------

export interface DealApproverSeed {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly grantedAt: Date;
}

export interface DealSeed {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly projectRequestId: string;
  readonly status: DealStatusV1;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}

export interface WorkspaceSeed {
  readonly workspaceId: string;
  readonly status: "Active" | "Suspended";
}

export interface MembershipSeed {
  readonly userId: string;
  readonly workspaceId: string;
}

export class InMemoryDealTermsRepository implements DealTermsRepository {
  private readonly deals = new Map<string, DealSeed>();
  private readonly workspaces = new Map<string, WorkspaceSeed>();
  private readonly memberships = new Map<string, MembershipSeed>();
  private readonly dealApprovers = new Map<string, DealApproverSeed>();
  private readonly termsVersions = new Map<string, PersistedTermsVersion>();
  private readonly dealApprovals = new Map<string, PersistedDealApproval>();
  /** Single-flight mutex so a single in-memory test cannot interleave
   *  authority mutations with a running use case. NOT a real-MVCC
   *  guarantee — see the header comment. */
  private inflight = false;

  seedDeal(seed: DealSeed): void {
    this.deals.set(seed.id, seed);
  }

  removeDeal(dealId: string): void {
    this.deals.delete(dealId);
  }

  seedWorkspace(seed: WorkspaceSeed): void {
    this.workspaces.set(seed.workspaceId, seed);
  }

  seedMembership(seed: MembershipSeed): void {
    this.memberships.set(this.membershipKey(seed.userId, seed.workspaceId), seed);
  }

  removeMembership(userId: string, workspaceId: string): void {
    this.memberships.delete(this.membershipKey(userId, workspaceId));
  }

  suspendWorkspace(workspaceId: string): void {
    const existing = this.workspaces.get(workspaceId);
    if (existing) this.workspaces.set(workspaceId, { ...existing, status: "Suspended" });
  }

  seedDealApprover(seed: DealApproverSeed): void {
    this.dealApprovers.set(seed.id, seed);
  }

  removeDealApprover(dealApproverId: string): void {
    this.dealApprovers.delete(dealApproverId);
  }

  findDealApprover(workspaceId: string, userId: string): DealApproverSeed | null {
    for (const candidate of this.dealApprovers.values()) {
      if (candidate.workspaceId === workspaceId && candidate.userId === userId) {
        return candidate;
      }
    }
    return null;
  }

  // ---------- Transactions ----------

  draftTermsInTransaction(
    input: DraftTermsTransactionInput,
    useCase: DraftTermsUseCase,
  ): Promise<DraftTermsResult> {
    // The in-memory adapter runs synchronously; the contract returns
    // a Promise so callers don't have to branch on adapter type.
    if (this.inflight) {
      return Promise.reject(
        new Error(
          "In-memory DealTermsRepository already has an inflight transaction; " +
            "the in-memory adapter does not serialize concurrent transactions.",
        ),
      );
    }
    this.inflight = true;
    try {
      const deal = this.deals.get(input.dealId);
      if (!deal) {
        return Promise.resolve({ ok: false, reason: "DEAL_NOT_FOUND" });
      }
      // P1-002: lock the EXACT commanded (actingUserAccountId,
      // actingWorkspaceId) tuple, not the first qualifying
      // membership. Membership in a different Workspace is irrelevant.
      const actingWs = this.workspaces.get(input.actingWorkspaceId);
      const isMember =
        actingWs !== undefined &&
        this.memberships.has(
          this.membershipKey(input.actingUserAccountId, input.actingWorkspaceId),
        );

      const snapshot: DraftingAuthoritySnapshot = {
        dealId: input.dealId,
        dealStatus: deal.status,
        buyerWorkspaceId: deal.buyerWorkspaceId,
        sellerWorkspaceId: deal.sellerWorkspaceId,
        actingWorkspaceId: input.actingWorkspaceId,
        actingWorkspaceStatus: actingWs?.status ?? "Suspended",
        actingUserIsMember: isMember,
      };

      const tools: DraftTermsUseCaseTools = {
        reject: (reason): DraftTermsUseCaseOutcome => ({ kind: "reject", reason }),
        persistDraft: (persistInput): DraftTermsUseCaseOutcome => ({
          kind: "persistDraft",
          input: persistInput,
        }),
      };
      const outcome = useCase({ draftingAuthority: snapshot }, tools);
      if (outcome.kind === "reject") {
        return Promise.resolve({ ok: false, reason: outcome.reason });
      }

      // Compute next version under the in-memory mutex.
      const existingVersions = [...this.termsVersions.values()].filter(
        (row) => row.dealId === input.dealId,
      );
      const nextVersion =
        existingVersions.length === 0
          ? 1
          : Math.max(...existingVersions.map((row) => row.version)) + 1;

      const row: PersistedTermsVersion = {
        id: `tv-${randomUUID()}`,
        dealId: outcome.input.dealId,
        version: nextVersion,
        scope: outcome.input.proposedTerms.scope,
        deliverablesJson: outcome.input.proposedTerms.deliverables,
        scheduleJson: outcome.input.proposedTerms.schedule,
        priceAmountMinor: outcome.input.proposedTerms.price.amountMinor,
        priceCurrency: outcome.input.proposedTerms.price.currency,
        revisionAllowance: outcome.input.proposedTerms.revisionAllowance,
        rightsSummary: outcome.input.proposedTerms.rightsSummary,
        fundingDeadlineAt: outcome.input.proposedTerms.fundingDeadlineAt
          ? new Date(outcome.input.proposedTerms.fundingDeadlineAt)
          : null,
        aiProvider: outcome.input.aiProvider,
        aiModelId: outcome.input.aiModelId,
        aiFallbackUsed: outcome.input.aiFallbackUsed,
        draftedByUserId: outcome.input.draftedByUserId,
        draftedAt: outcome.input.now,
        createdAt: new Date(),
      };
      this.termsVersions.set(row.id, row);
      return Promise.resolve({ ok: true, value: row });
    } finally {
      this.inflight = false;
    }
  }

  recordApprovalInTransaction(
    input: RecordApprovalTransactionInput,
    useCase: RecordApprovalUseCase,
  ): Promise<RecordApprovalResult> {
    if (this.inflight) {
      return Promise.reject(
        new Error(
          "In-memory DealTermsRepository already has an inflight transaction; " +
            "the in-memory adapter does not serialize concurrent transactions.",
        ),
      );
    }
    this.inflight = true;
    try {
      const tv = this.termsVersions.get(input.termsVersionId);
      if (!tv) {
        return Promise.resolve({
          ok: false,
          reason: "TERMS_VERSION_NOT_FOUND",
        });
      }
      // P1-003: enforce that the TermsVersion belongs to the commanded
      // Deal. The Deal is loaded from the TermsVersion so that the
      // contract stays single-source-of-truth for the TV→Deal link.
      const deal = this.deals.get(tv.dealId);
      if (!deal) {
        return Promise.resolve({ ok: false, reason: "DEAL_NOT_FOUND" });
      }
      if (deal.id !== input.dealId) {
        // Cross-Deal mismatch — collapse to TERMS_VERSION_NOT_FOUND so
        // the safe envelope does not leak the cross-Deal existence.
        return Promise.resolve({
          ok: false,
          reason: "TERMS_VERSION_NOT_FOUND",
        });
      }
      // Compute current version (MAX) under the mutex.
      const dealVersions = [...this.termsVersions.values()].filter((row) => row.dealId === deal.id);
      const currentVersionId =
        dealVersions.length === 0
          ? null
          : (dealVersions.reduce(
              (acc, row) => (acc === null || row.version > acc.version ? row : acc),
              dealVersions[0] ?? null,
            )?.id ?? null);

      const actingWs = this.workspaces.get(input.actingWorkspaceId);
      if (!actingWs) {
        return Promise.resolve({
          ok: false,
          reason: "APPROVAL_FORBIDDEN",
        });
      }
      let dealApproverId: string | null = null;
      let dealApproverExists = false;
      for (const da of this.dealApprovers.values()) {
        if (da.workspaceId === input.actingWorkspaceId && da.userId === input.userAccountId) {
          dealApproverExists = true;
          dealApproverId = da.id;
          break;
        }
      }

      const snapshot: ApprovalAuthoritySnapshot = {
        dealId: deal.id,
        dealStatus: deal.status,
        termsVersionId: input.termsVersionId,
        termsVersionDealId: tv.dealId,
        currentTermsVersionId: currentVersionId,
        buyerWorkspaceId: deal.buyerWorkspaceId,
        sellerWorkspaceId: deal.sellerWorkspaceId,
        actingWorkspaceId: input.actingWorkspaceId,
        actingWorkspaceStatus: actingWs.status,
        actingUserIsMember: this.memberships.has(
          this.membershipKey(input.userAccountId, input.actingWorkspaceId),
        ),
        userAccountId: input.userAccountId,
        dealApproverExists,
        dealApproverId,
      };

      const tools: RecordApprovalUseCaseTools = {
        reject: (reason): RecordApprovalUseCaseOutcome => ({ kind: "reject", reason }),
        persistApproval: (persistInput): RecordApprovalUseCaseOutcome => ({
          kind: "persistApproval",
          input: persistInput,
        }),
      };
      const outcome = useCase({ approvalAuthority: snapshot }, tools);
      if (outcome.kind === "reject") {
        return Promise.resolve({ ok: false, reason: outcome.reason });
      }

      // Duplicate guard (mirrors the unique index on
      // (termsVersionId, workspaceId)).
      for (const existing of this.dealApprovals.values()) {
        if (
          existing.termsVersionId === outcome.input.termsVersionId &&
          existing.workspaceId === outcome.input.workspaceId
        ) {
          return Promise.resolve({
            ok: false,
            reason: "APPROVAL_ALREADY_RECORDED",
          });
        }
      }

      const row: PersistedDealApproval = {
        id: `da-${randomUUID()}`,
        termsVersionId: outcome.input.termsVersionId,
        workspaceId: outcome.input.workspaceId,
        dealApproverId: outcome.input.dealApproverId,
        approvedByUserId: outcome.input.approvedByUserId,
        approvedAt: outcome.input.now,
      };
      this.dealApprovals.set(row.id, row);
      return Promise.resolve({ ok: true, value: row });
    } finally {
      this.inflight = false;
    }
  }

  // ---------- Reads ----------

  findDealViewInTransaction(
    input: FindDealViewTransactionInput,
    useCase: FindDealViewUseCase,
  ): Promise<FindDealViewResult> {
    // Single-flight mutex: every read inside a transaction also runs
    // synchronously against the in-memory state. The in-memory
    // adapter does NOT replicate PostgreSQL MVCC; the service layer
    // is the only arbiter of authority.
    if (this.inflight) {
      return Promise.reject(
        new Error(
          "In-memory DealTermsRepository already has an inflight transaction; " +
            "the in-memory adapter does not serialize concurrent transactions.",
        ),
      );
    }
    this.inflight = true;
    try {
      const deal = this.deals.get(input.dealId);
      const actingWs = this.workspaces.get(input.actingWorkspaceId);
      const isMember =
        actingWs !== undefined &&
        this.memberships.has(
          this.membershipKey(input.actingUserAccountId, input.actingWorkspaceId),
        );

      const snapshot = {
        dealId: input.dealId,
        dealExists: deal !== undefined,
        dealStatus: deal?.status ?? null,
        buyerWorkspaceId: deal?.buyerWorkspaceId ?? null,
        sellerWorkspaceId: deal?.sellerWorkspaceId ?? null,
        actingWorkspaceId: input.actingWorkspaceId,
        actingWorkspaceStatus: actingWs?.status ?? null,
        actingUserIsMember: isMember,
      };
      const tools: FindDealViewUseCaseTools = {
        reject: (reason): FindDealViewUseCaseOutcome => ({ kind: "reject", reason }),
        accept: (): FindDealViewUseCaseOutcome => ({ kind: "accept" }),
      };
      const outcome = useCase({ snapshot }, tools);
      if (outcome.kind === "reject") {
        return Promise.resolve({ ok: false, reason: outcome.reason });
      }
      // outcome.kind === "accept" — the locked snapshot is
      // authorized; assemble the view from in-memory state.
      const versions = [...this.termsVersions.values()]
        .filter((row) => row.dealId === input.dealId)
        .sort((a, b) => b.version - a.version);
      const current = versions[0] ?? null;
      const approvals = current
        ? [...this.dealApprovals.values()].filter((row) => row.termsVersionId === current.id)
        : [];
      const view: DealViewSnapshot = {
        deal: dealSummaryToPersisted(deal as DealSeed),
        projectRequest: null,
        currentTermsVersion: current,
        currentApprovals: approvals,
      };
      return Promise.resolve({ ok: true, value: view });
    } finally {
      this.inflight = false;
    }
  }

  findDealView(dealId: string): Promise<DealViewSnapshot | null> {
    const deal = this.deals.get(dealId);
    if (!deal) return Promise.resolve(null);
    const versions = [...this.termsVersions.values()]
      .filter((row) => row.dealId === dealId)
      .sort((a, b) => b.version - a.version);
    const current = versions[0] ?? null;
    const approvals = current
      ? [...this.dealApprovals.values()].filter((row) => row.termsVersionId === current.id)
      : [];
    return Promise.resolve({
      deal: dealSummaryToPersisted(deal),
      projectRequest: null,
      currentTermsVersion: current,
      currentApprovals: approvals,
    });
  }

  findDealSummary(dealId: string): Promise<PersistedDealSummary | null> {
    const deal = this.deals.get(dealId);
    if (!deal) return Promise.resolve(null);
    return Promise.resolve(dealSummaryToPersisted(deal));
  }

  // ---------- helpers ----------

  private membershipKey(userId: string, workspaceId: string): string {
    return `${userId}|${workspaceId}`;
  }
}

function dealSummaryToPersisted(seed: DealSeed): PersistedDealSummary {
  return {
    id: seed.id,
    buyerWorkspaceId: seed.buyerWorkspaceId,
    sellerWorkspaceId: seed.sellerWorkspaceId,
    serviceOfferingId: seed.serviceOfferingId,
    projectBriefId: seed.projectBriefId,
    projectRequestId: seed.projectRequestId,
    status: seed.status,
    activatedAt: seed.activatedAt,
    createdAt: seed.createdAt,
  };
}

// Marker: re-exports that mirror the Prisma adapter's contract
// surface; tests import them from this module.
export type { DealPublicV1, ProjectRequestPublicV1 };
