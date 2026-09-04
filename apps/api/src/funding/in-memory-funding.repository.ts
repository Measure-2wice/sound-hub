// In-memory FundingRepository for unit tests.
//
// Background: the FundingService tests run without a database. The
// in-memory adapter mirrors the Prisma adapter's contract surface so
// tests can substitute it without changing the service or route code.
//
// The Prisma adapter is the canonical implementation; this is for
// unit tests only.
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
import type { DealStatusV1 } from "@soundhub/types";
import type {
  ActivationAuthoritySnapshot,
  PreauthAuthoritySnapshot,
} from "./funding-authorization-policy.js";
import type {
  FindOrCreatePaymentIntentInput,
  FindOrCreatePaymentIntentResult,
  FindPreauthInput,
  FindPreauthResult,
  FundDealFailureReason,
  FundDealResult,
  FundDealTransactionInput,
  FundDealUseCase,
  FundDealUseCaseOutcome,
  FundDealUseCaseTools,
  FundingRepository,
  PersistedDealSummaryForFunding,
  PersistedPaymentIntent,
  PersistedTermsVersionForFunding,
  RecordPaymentIntentFailureInput,
  RecordPaymentIntentFailureResult,
} from "./funding.repository.js";

// ---------- Test seams ----------

export interface DealSeedForFunding {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly status: DealStatusV1;
  readonly activatedAt: Date | null;
}

export interface WorkspaceSeedForFunding {
  readonly workspaceId: string;
  readonly status: "Active" | "Suspended";
}

export interface MembershipSeedForFunding {
  readonly userId: string;
  readonly workspaceId: string;
}

export interface TermsVersionSeedForFunding {
  readonly id: string;
  readonly dealId: string;
  readonly version: number;
  readonly priceAmountMinor: number;
  readonly priceCurrency: string;
}

export interface DealApprovalSeedForFunding {
  readonly id: string;
  readonly termsVersionId: string;
  readonly workspaceId: string;
}

export interface ProjectRequestSeedForFunding {
  readonly id: string;
  readonly dealId: string;
  readonly status: "Pending" | "Accepted" | "Declined";
  readonly sellerConsentAt: Date | null;
}

/**
 * Buyer-capability seed. Mirrors the closed `MarketplaceCapability`
 * table; in-memory tests set this explicitly per Workspace.
 */
export interface WorkspaceCapabilitySeedForFunding {
  readonly workspaceId: string;
  readonly capability: "Buyer" | "Seller";
}

export class InMemoryFundingRepository implements FundingRepository {
  private readonly deals = new Map<string, DealSeedForFunding>();
  private readonly workspaces = new Map<string, WorkspaceSeedForFunding>();
  private readonly memberships = new Map<string, MembershipSeedForFunding>();
  private readonly termsVersions = new Map<string, TermsVersionSeedForFunding>();
  private readonly dealApprovals = new Map<string, DealApprovalSeedForFunding>();
  private readonly projectRequests = new Map<string, ProjectRequestSeedForFunding>();
  private readonly workspaceCapabilities = new Map<string, WorkspaceCapabilitySeedForFunding>();
  private readonly paymentIntents = new Map<string, PersistedPaymentIntent>();
  /** Single-flight mutex so a single in-memory test cannot interleave
   *  authority mutations with a running use case. NOT a real-MVCC
   *  guarantee — see the header comment. */
  private inflight = false;

  // ---------- Seed helpers ----------

  seedDeal(seed: DealSeedForFunding): void {
    this.deals.set(seed.id, seed);
  }

  seedWorkspace(seed: WorkspaceSeedForFunding): void {
    this.workspaces.set(seed.workspaceId, seed);
  }

  seedMembership(seed: MembershipSeedForFunding): void {
    this.memberships.set(this.membershipKey(seed.userId, seed.workspaceId), seed);
  }

  removeMembership(userId: string, workspaceId: string): void {
    this.memberships.delete(this.membershipKey(userId, workspaceId));
  }

  seedTermsVersion(seed: TermsVersionSeedForFunding): void {
    this.termsVersions.set(seed.id, seed);
  }

  seedDealApproval(seed: DealApprovalSeedForFunding): void {
    this.dealApprovals.set(seed.id, seed);
  }

  removeDealApproval(id: string): void {
    this.dealApprovals.delete(id);
  }

  seedProjectRequest(seed: ProjectRequestSeedForFunding): void {
    this.projectRequests.set(seed.id, seed);
  }

  removeProjectRequest(id: string): void {
    this.projectRequests.delete(id);
  }

  /**
   * Seed a WorkspaceCapability row (e.g. Buyer, Seller). The Buyer
   * capability is the authoritative grant for the funding command;
   * membership, ownership, and Deal party identity are NOT
   * substitutes. See ticket #64 P0-001.
   */
  seedWorkspaceCapability(seed: WorkspaceCapabilitySeedForFunding): void {
    this.workspaceCapabilities.set(this.capabilityKey(seed.workspaceId, seed.capability), seed);
  }

  removeWorkspaceCapability(workspaceId: string, capability: "Buyer" | "Seller"): void {
    this.workspaceCapabilities.delete(this.capabilityKey(workspaceId, capability));
  }

  seedPaymentIntent(seed: PersistedPaymentIntent): void {
    this.paymentIntents.set(seed.id, seed);
  }

  // ---------- Reads ----------

  // eslint-disable-next-line @typescript-eslint/require-await -- adapter signature
  async findPreauthSnapshot(input: FindPreauthInput): Promise<FindPreauthResult> {
    const deal = this.deals.get(input.dealId);
    if (!deal) {
      return { ok: false, reason: "DEAL_NOT_FOUND" };
    }
    // Find current TermsVersion (MAX(version)).
    const dealVersions = [...this.termsVersions.values()]
      .filter((row) => row.dealId === input.dealId)
      .sort((a, b) => b.version - a.version);
    const current = dealVersions[0];
    if (!current) {
      return { ok: false, reason: "CURRENT_TERMS_VERSION_NOT_FOUND" };
    }
    // Find the originating ProjectRequest — single row per Deal in BG4.
    let projectRequest: ProjectRequestSeedForFunding | null = null;
    for (const pr of this.projectRequests.values()) {
      if (pr.dealId === input.dealId) {
        projectRequest = pr;
        break;
      }
    }
    if (!projectRequest) {
      return { ok: false, reason: "PROJECT_REQUEST_NOT_FOUND" };
    }
    const actingWs = this.workspaces.get(input.actingWorkspaceId);
    const isMember =
      actingWs !== undefined &&
      this.memberships.has(this.membershipKey(input.actingUserAccountId, input.actingWorkspaceId));
    // Read the buyer WorkspaceCapability(Buyer) row. The in-memory
    // adapter consults the same closed workspaceCapabilities map the
    // Prisma adapter queries; membership / ownership / Deal party
    // identity are NOT substitutes. See ticket #64 P0-001.
    const hasBuyerCapability = this.workspaceCapabilities.has(
      this.capabilityKey(deal.buyerWorkspaceId, "Buyer"),
    );
    let buyerApproval = false;
    let sellerApproval = false;
    for (const approval of this.dealApprovals.values()) {
      if (approval.termsVersionId !== current.id) continue;
      if (approval.workspaceId === deal.buyerWorkspaceId) buyerApproval = true;
      else if (approval.workspaceId === deal.sellerWorkspaceId) sellerApproval = true;
    }
    const snapshot: PreauthAuthoritySnapshot = {
      dealId: deal.id,
      dealStatus: deal.status,
      buyerWorkspaceId: deal.buyerWorkspaceId,
      sellerWorkspaceId: deal.sellerWorkspaceId,
      actingWorkspaceId: input.actingWorkspaceId,
      actingWorkspaceStatus: actingWs?.status ?? "Suspended",
      actingUserIsMember: isMember,
      hasBuyerCapability,
      currentTermsVersionId: current.id,
      currentTermsVersionDealId: current.dealId,
      projectRequestStatus: projectRequest.status,
      projectRequestSellerConsentAt: projectRequest.sellerConsentAt,
      buyerApprovalExists: buyerApproval,
      sellerApprovalExists: sellerApproval,
    };
    return {
      ok: true,
      value: snapshot,
      currentTermsVersion: {
        id: current.id,
        version: current.version,
        priceAmountMinor: current.priceAmountMinor,
        priceCurrency: current.priceCurrency,
      },
    };
  }

  // ---------- findOrCreatePaymentIntentInTransaction ----------
  //
  // Mirrors the Prisma adapter's deterministic convergence: every
  // concurrent caller for the same (dealId, termsVersionId) runs
  // through the single-flight mutex (the in-memory equivalent of
  // locking the parent TermsVersion row), then converges on the
  // first row found or creates one.

  async findOrCreatePaymentIntentInTransaction(
    input: FindOrCreatePaymentIntentInput,
  ): Promise<FindOrCreatePaymentIntentResult> {
    if (this.inflight) {
      return Promise.reject(
        new Error(
          "In-memory FundingRepository already has an inflight transaction; " +
            "the in-memory adapter does not serialize concurrent transactions.",
        ),
      );
    }
    this.inflight = true;
    try {
      const tv = this.termsVersions.get(input.termsVersionId);
      if (!tv) {
        return { ok: false, reason: "TERMS_VERSION_NOT_FOUND" };
      }
      // Convergence: re-read by (dealId, termsVersionId) inside the lock.
      const existing = [...this.paymentIntents.values()].find(
        (row) => row.dealId === input.dealId && row.termsVersionId === input.termsVersionId,
      );
      if (existing) {
        return { ok: true, value: existing };
      }
      const now = new Date();
      const row: PersistedPaymentIntent = {
        id: `pi-${randomUUID()}`,
        dealId: input.dealId,
        termsVersionId: input.termsVersionId,
        actingWorkspaceId: input.actingWorkspaceId,
        createdByUserId: input.createdByUserId,
        expectedAmountMinor: input.expectedAmountMinor,
        expectedCurrency: input.expectedCurrency,
        assetLabel: input.assetLabel,
        networkLabel: input.networkLabel,
        providerKey: input.providerKey,
        environmentLabel: input.environmentLabel,
        correlationId: input.correlationId,
        providerReference: null,
        confirmedAt: null,
        acceptedAt: null,
        failureReasonCode: null,
        failureDetailCategory: null,
        providerState: "Created",
        createdAt: now,
        updatedAt: now,
      };
      this.paymentIntents.set(row.id, row);
      return { ok: true, value: row };
    } finally {
      this.inflight = false;
    }
  }

  // ---------- recordPaymentIntentFailureInTransaction ----------
  //
  // Guarded: a Confirmed intent is NOT demoted. The in-memory adapter
  // checks the current providerState atomically (single-threaded JS)
  // and returns `ALREADY_CONFIRMED` when the row is already Confirmed.
  // The service uses that return to converge on the existing success
  // path. See ticket #64 P0-002.
  // eslint-disable-next-line @typescript-eslint/require-await -- adapter signature
  async recordPaymentIntentFailureInTransaction(
    input: RecordPaymentIntentFailureInput,
  ): Promise<RecordPaymentIntentFailureResult> {
    const intent = this.paymentIntents.get(input.paymentIntentId);
    if (!intent) return { ok: true, persisted: false, reason: "ALREADY_CONFIRMED" };
    if (intent.providerState === "Confirmed") {
      return { ok: true, persisted: false, reason: "ALREADY_CONFIRMED" };
    }
    this.paymentIntents.set(intent.id, {
      ...intent,
      providerState: "Failed",
      failureReasonCode: input.failureReasonCode,
      failureDetailCategory: input.failureDetailCategory,
      updatedAt: new Date(),
    });
    return { ok: true, persisted: true };
  }

  // ---------- fundDealInTransaction ----------

  async fundDealInTransaction(
    input: FundDealTransactionInput,
    useCase: FundDealUseCase,
  ): Promise<FundDealResult> {
    if (this.inflight) {
      return Promise.reject(
        new Error(
          "In-memory FundingRepository already has an inflight transaction; " +
            "the in-memory adapter does not serialize concurrent transactions.",
        ),
      );
    }
    this.inflight = true;
    try {
      // Mirror Prisma adapter: assemble the snapshot rows from the
      // locked state, hand to use case, persist on accept.
      const deal = this.deals.get(input.dealId);
      if (!deal) return { ok: false, reason: "DEAL_NOT_FOUND" };
      const intent = this.paymentIntents.get(input.paymentIntentId);
      if (!intent) return { ok: false, reason: "PAYMENT_INTENT_NOT_FOUND" };
      const tv = this.termsVersions.get(intent.termsVersionId);
      if (!tv) return { ok: false, reason: "TERMS_VERSION_NOT_FOUND" };
      if (tv.dealId !== deal.id) {
        return { ok: false, reason: "TERMS_VERSION_NOT_FOUND" };
      }
      const dealVersions = [...this.termsVersions.values()]
        .filter((row) => row.dealId === deal.id)
        .sort((a, b) => b.version - a.version);
      const current = dealVersions[0];
      if (!current || current.id !== intent.termsVersionId) {
        return { ok: false, reason: "TERMS_VERSION_NOT_CURRENT" };
      }
      let projectRequest: ProjectRequestSeedForFunding | null = null;
      for (const pr of this.projectRequests.values()) {
        if (pr.dealId === deal.id) {
          projectRequest = pr;
          break;
        }
      }
      const actingWs = this.workspaces.get(input.actingWorkspaceId);
      const isMember =
        actingWs !== undefined &&
        this.memberships.has(
          this.membershipKey(input.actingUserAccountId, input.actingWorkspaceId),
        );
      const hasBuyerCapability = this.workspaceCapabilities.has(
        this.capabilityKey(deal.buyerWorkspaceId, "Buyer"),
      );
      let buyerApproval = false;
      let sellerApproval = false;
      for (const approval of this.dealApprovals.values()) {
        if (approval.termsVersionId !== current.id) continue;
        if (approval.workspaceId === deal.buyerWorkspaceId) buyerApproval = true;
        else if (approval.workspaceId === deal.sellerWorkspaceId) sellerApproval = true;
      }
      const preauthSnapshot: PreauthAuthoritySnapshot = {
        dealId: deal.id,
        dealStatus: deal.status,
        buyerWorkspaceId: deal.buyerWorkspaceId,
        sellerWorkspaceId: deal.sellerWorkspaceId,
        actingWorkspaceId: input.actingWorkspaceId,
        actingWorkspaceStatus: actingWs?.status ?? "Suspended",
        actingUserIsMember: isMember,
        hasBuyerCapability,
        currentTermsVersionId: current.id,
        currentTermsVersionDealId: current.dealId,
        projectRequestStatus: projectRequest?.status ?? null,
        projectRequestSellerConsentAt: projectRequest?.sellerConsentAt ?? null,
        buyerApprovalExists: buyerApproval,
        sellerApprovalExists: sellerApproval,
      };
      const activationSnapshot: ActivationAuthoritySnapshot = {
        projectRequestSellerConsentAt: projectRequest?.sellerConsentAt ?? null,
        buyerApprovalExists: buyerApproval,
        sellerApprovalExists: sellerApproval,
        fundingConfirmedAmountMinor: intent.expectedAmountMinor,
        fundingConfirmedCurrency: intent.expectedCurrency,
        fundingTermsVersionId: intent.termsVersionId,
        currentTermsVersionId: current.id,
        currentTermsVersionAmountMinor: current.priceAmountMinor,
        currentTermsVersionCurrency: current.priceCurrency,
      };
      const tools: FundDealUseCaseTools = {
        reject: (reason: FundDealFailureReason): FundDealUseCaseOutcome => ({
          kind: "reject",
          reason,
        }),
        persistFundingConfirmationAndActivate: (persistInput): FundDealUseCaseOutcome => ({
          kind: "persist",
          input: persistInput,
        }),
      };
      const outcome = useCase(
        {
          preauth: preauthSnapshot,
          activation: activationSnapshot,
          paymentIntentId: intent.id,
        },
        tools,
      );
      if (outcome.kind === "reject") {
        return { ok: false, reason: outcome.reason };
      }
      // Guarded activation UPDATE.
      if (deal.status !== "Negotiating") {
        return { ok: false, reason: "DEAL_ALREADY_ACTIVE" };
      }
      const activatedAt = outcome.input.acceptedAt;
      this.deals.set(deal.id, { ...deal, status: "Active", activatedAt });
      // Persist the confirmed fields on the intent.
      this.paymentIntents.set(intent.id, {
        ...intent,
        providerReference: outcome.input.providerReference,
        confirmedAt: outcome.input.confirmedAt,
        acceptedAt: outcome.input.acceptedAt,
        providerState: "Confirmed",
        failureReasonCode: null,
        failureDetailCategory: null,
        updatedAt: new Date(),
      });
      const summary: PersistedDealSummaryForFunding = {
        id: deal.id,
        buyerWorkspaceId: deal.buyerWorkspaceId,
        sellerWorkspaceId: deal.sellerWorkspaceId,
        status: "Active",
        activatedAt,
      };
      const updatedIntent = this.paymentIntents.get(intent.id)!;
      return { ok: true, value: { paymentIntent: updatedIntent, deal: summary } };
    } finally {
      this.inflight = false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- adapter signature
  async findCurrentPaymentIntent(dealId: string): Promise<PersistedPaymentIntent | null> {
    const candidates = [...this.paymentIntents.values()]
      .filter((row) => row.dealId === dealId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return candidates[0] ?? null;
  }

  // ---------- helpers ----------

  private membershipKey(userId: string, workspaceId: string): string {
    return `${userId}|${workspaceId}`;
  }

  private capabilityKey(workspaceId: string, capability: "Buyer" | "Seller"): string {
    return `${workspaceId}|${capability}`;
  }
}

// Marker: helpers for tests.
export type { PersistedPaymentIntent, PersistedTermsVersionForFunding };
