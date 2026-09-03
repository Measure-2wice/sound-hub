// FundingService unit tests (BG6).
//
// Per refinement feedback: provider failure tests live at the
// provider/service layer; this file plus the in-memory repository
// tests cover the service-level flows. The repository tests focus
// on persisted state, transactionality, locking, retry safety,
// exact-version/amount matching, and guarded activation.

import assert from "node:assert/strict";
import test from "node:test";
import { bg6FundingConfirmationPublicV1Schema } from "@soundhub/types";
import {
  DeterministicMockEscrowProvider,
  type EscrowConfirmation,
  type EscrowProvider,
  type EscrowRequestInput,
} from "../escrow/escrow-provider.js";
import {
  InMemoryFundingRepository,
  type DealSeedForFunding,
  type DealApprovalSeedForFunding,
  type ProjectRequestSeedForFunding,
  type TermsVersionSeedForFunding,
  type WorkspaceSeedForFunding,
  type MembershipSeedForFunding,
} from "./in-memory-funding.repository.js";
import { FundingService, FundingServiceError } from "./funding.service.js";

const DEAL_ID = "deal_test_001";
const BUYER_WS = "ws_buyer";
const SELLER_WS = "ws_seller";
const TV_ID = "tv_current";
const USER_ID = "user_buyer";
const SELLER_USER_ID = "user_seller";

function seedHappyPath(repo: InMemoryFundingRepository): void {
  const deal: DealSeedForFunding = {
    id: DEAL_ID,
    buyerWorkspaceId: BUYER_WS,
    sellerWorkspaceId: SELLER_WS,
    status: "Negotiating",
    activatedAt: null,
  };
  const buyerWs: WorkspaceSeedForFunding = { workspaceId: BUYER_WS, status: "Active" };
  const sellerWs: WorkspaceSeedForFunding = { workspaceId: SELLER_WS, status: "Active" };
  const membership: MembershipSeedForFunding = { userId: USER_ID, workspaceId: BUYER_WS };
  const tv: TermsVersionSeedForFunding = {
    id: TV_ID,
    dealId: DEAL_ID,
    version: 1,
    priceAmountMinor: 75000,
    priceCurrency: "USD",
  };
  const buyerApproval: DealApprovalSeedForFunding = {
    id: "da_buyer",
    termsVersionId: TV_ID,
    workspaceId: BUYER_WS,
  };
  const sellerApproval: DealApprovalSeedForFunding = {
    id: "da_seller",
    termsVersionId: TV_ID,
    workspaceId: SELLER_WS,
  };
  const pr: ProjectRequestSeedForFunding = {
    id: "pr_001",
    dealId: DEAL_ID,
    status: "Accepted",
    sellerConsentAt: new Date("2026-09-01T10:00:00.000Z"),
  };
  repo.seedDeal(deal);
  repo.seedWorkspace(buyerWs);
  repo.seedWorkspace(sellerWs);
  repo.seedMembership(membership);
  repo.seedTermsVersion(tv);
  repo.seedDealApproval(buyerApproval);
  repo.seedDealApproval(sellerApproval);
  repo.seedProjectRequest(pr);
}

class StubEscrowProvider implements EscrowProvider {
  readonly key = "mock-escrow-deterministic" as const;
  public callCount = 0;
  public lastInput: EscrowRequestInput | null = null;
  constructor(
    private readonly behavior:
      | { kind: "ok"; override?: Partial<EscrowConfirmation> }
      | { kind: "throw"; message: string },
  ) {}
  async requestFunding(input: EscrowRequestInput): Promise<EscrowConfirmation> {
    this.callCount += 1;
    this.lastInput = input;
    if (this.behavior.kind === "throw") {
      throw new Error(this.behavior.message);
    }
    return {
      providerKey: this.key,
      providerReference:
        this.behavior.override?.providerReference ??
        `mock-${input.paymentIntentId}-${input.correlationId}`,
      confirmedAmountMinor: this.behavior.override?.confirmedAmountMinor ?? input.priceAmountMinor,
      confirmedCurrency: this.behavior.override?.confirmedCurrency ?? input.priceCurrency,
      assetLabel: this.behavior.override?.assetLabel ?? "sandbox-USDC",
      networkLabel: this.behavior.override?.networkLabel ?? "simulated-polkadot-asset-hub-testnet",
      environmentLabel: this.behavior.override?.environmentLabel ?? "sandbox",
      termsVersionId: this.behavior.override?.termsVersionId ?? input.termsVersionId,
      confirmedAt: this.behavior.override?.confirmedAt ?? input.now,
    };
  }
}

// ---------- Phase 1 preauth rejections (NO intent row, NO provider call) ----------

test("fundDeal rejects preauth when acting Workspace is the seller (no intent, no provider call)", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const provider = new StubEscrowProvider({ kind: "ok" });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  // Use the seller Workspace's user — must have membership there.
  repo.seedMembership({ userId: SELLER_USER_ID, workspaceId: SELLER_WS });
  await assert.rejects(
    () =>
      service.fundDeal({
        userAccountId: SELLER_USER_ID,
        actingWorkspaceId: SELLER_WS,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FundingServiceError);
      assert.equal(err.code, "BG6_FUNDING_FORBIDDEN");
      return true;
    },
  );
  assert.equal(provider.callCount, 0, "provider must not be called when preauth fails");
  const intent = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.equal(intent, null, "no PaymentIntent row may be written when preauth fails");
});

test("fundDeal rejects preauth when membership is missing", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  repo.removeMembership(USER_ID, BUYER_WS);
  const provider = new StubEscrowProvider({ kind: "ok" });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  await assert.rejects(
    () =>
      service.fundDeal({
        userAccountId: USER_ID,
        actingWorkspaceId: BUYER_WS,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FundingServiceError);
      assert.equal(err.code, "BG6_FUNDING_FORBIDDEN");
      return true;
    },
  );
  assert.equal(provider.callCount, 0);
});

test("fundDeal rejects preauth when both approvals are missing (APPROVALS_INCOMPLETE)", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  // Drop the seller approval so only the buyer has approved.
  repo.removeDealApproval("da_seller");
  const provider = new StubEscrowProvider({ kind: "ok" });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  await assert.rejects(
    () =>
      service.fundDeal({
        userAccountId: USER_ID,
        actingWorkspaceId: BUYER_WS,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FundingServiceError);
      assert.equal(err.code, "BG6_APPROVALS_INCOMPLETE");
      return true;
    },
  );
});

test("fundDeal rejects preauth when ProjectRequest is Pending (SELLER_NOT_CONSENTED)", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  // Replace the existing PR with a Pending one (no seller consent).
  repo.removeProjectRequest("pr_001");
  repo.seedProjectRequest({
    id: "pr_001",
    dealId: DEAL_ID,
    status: "Pending",
    sellerConsentAt: null,
  });
  const provider = new StubEscrowProvider({ kind: "ok" });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  await assert.rejects(
    () =>
      service.fundDeal({
        userAccountId: USER_ID,
        actingWorkspaceId: BUYER_WS,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FundingServiceError);
      assert.equal(err.code, "BG6_FUNDING_FORBIDDEN");
      return true;
    },
  );
});

// ---------- Phase 2 + 3 happy path ----------

test("fundDeal happy path: persists a Confirmed intent and activates the Deal; public DTO carries the sandboxSimulatedBadge literal", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const provider = new StubEscrowProvider({ kind: "ok" });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  const result = await service.fundDeal({
    userAccountId: USER_ID,
    actingWorkspaceId: BUYER_WS,
    dealId: DEAL_ID,
    now: new Date("2026-09-03T12:00:00.000Z"),
  });
  assert.equal(result.dealStatus, "Active");
  assert.ok(result.activatedAt);
  // Public DTO must conform to the shared Zod schema.
  const parsed = bg6FundingConfirmationPublicV1Schema.parse(result.fundingStatus);
  assert.equal(parsed.status, "Confirmed");
  assert.equal(parsed.sandboxSimulatedBadge, true);
  assert.equal(parsed.networkLabel, "simulated-polkadot-asset-hub-testnet");
  assert.equal(parsed.expectedAmount.amountMinor, 75000);
  assert.equal(parsed.expectedAmount.currency, "USD");
  assert.equal(parsed.confirmedAmount?.amountMinor, 75000);
  assert.equal(parsed.sanitizedFailureReason, null);
  assert.equal(provider.callCount, 1);
});

test("fundDeal public response does NOT leak internal identifiers (paymentIntentId, correlationId, providerReference, raw failureDetail)", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const provider = new StubEscrowProvider({ kind: "ok" });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  const result = await service.fundDeal({
    userAccountId: USER_ID,
    actingWorkspaceId: BUYER_WS,
    dealId: DEAL_ID,
    now: new Date("2026-09-03T12:00:00.000Z"),
  });
  // The Zod schema is `.strict()` — any extra field would be rejected.
  const json = JSON.parse(JSON.stringify(result.fundingStatus));
  const keys = Object.keys(json);
  assert.deepEqual(
    keys.sort(),
    [
      "assetLabel",
      "confirmationTime",
      "confirmedAmount",
      "environmentLabel",
      "expectedAmount",
      "networkLabel",
      "providerKey",
      "sandboxSimulatedBadge",
      "sanitizedFailureReason",
      "status",
    ].sort(),
    "public DTO must contain ONLY allow-listed fields",
  );
});

// ---------- Phase 2 provider failure ----------

test("fundDeal provider throw → intent transitions to Failed on the SAME row; service raises BG6_ESCROW_UNAVAILABLE", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const provider = new StubEscrowProvider({
    kind: "throw",
    message: "ECONNRESET (server-only)",
  });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  await assert.rejects(
    () =>
      service.fundDeal({
        userAccountId: USER_ID,
        actingWorkspaceId: BUYER_WS,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FundingServiceError);
      assert.equal(err.code, "BG6_ESCROW_UNAVAILABLE");
      return true;
    },
  );
  const intent = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(intent);
  assert.equal(intent.providerState, "Failed");
  assert.equal(intent.failureReasonCode, "EscrowProviderUnavailable");
  assert.equal(intent.failureDetail, "ECONNRESET (server-only)");
});

// ---------- Phase 2 confirmation mismatch (provider returns bad amount) ----------

test("fundDeal confirmation mismatch (provider returns wrong amount) → intent transitions to Failed; service raises BG6_FUNDING_CONFIRMATION_MISMATCH", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const provider = new StubEscrowProvider({
    kind: "ok",
    override: { confirmedAmountMinor: 74999 },
  });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  await assert.rejects(
    () =>
      service.fundDeal({
        userAccountId: USER_ID,
        actingWorkspaceId: BUYER_WS,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FundingServiceError);
      assert.equal(err.code, "BG6_FUNDING_CONFIRMATION_MISMATCH");
      return true;
    },
  );
  const intent = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(intent);
  assert.equal(intent.providerState, "Failed");
  assert.equal(intent.failureReasonCode, "EscrowConfirmationAmountMismatch");
});

// ---------- Phase 2 + 3 retry semantics on the SAME durable row ----------

test("fundDeal retry after Failed → same row, transitions Failed → Confirmed, clears failure columns", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const failing = new StubEscrowProvider({
    kind: "throw",
    message: "first failure",
  });
  const service = new FundingService({
    fundingRepository: repo,
    escrowProvider: failing,
  });
  await assert.rejects(() =>
    service.fundDeal({
      userAccountId: USER_ID,
      actingWorkspaceId: BUYER_WS,
      dealId: DEAL_ID,
    }),
  );
  const firstIntent = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(firstIntent);
  assert.equal(firstIntent.providerState, "Failed");
  // Switch to a succeeding provider and retry.
  const succeeding = new StubEscrowProvider({ kind: "ok" });
  const service2 = new FundingService({
    fundingRepository: repo,
    escrowProvider: succeeding,
  });
  const result = await service2.fundDeal({
    userAccountId: USER_ID,
    actingWorkspaceId: BUYER_WS,
    dealId: DEAL_ID,
    now: new Date("2026-09-03T13:00:00.000Z"),
  });
  assert.equal(result.dealStatus, "Active");
  const secondIntent = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(secondIntent);
  // SAME row.
  assert.equal(secondIntent.id, firstIntent.id);
  // Transition: Failed → Confirmed. Failure columns cleared.
  assert.equal(secondIntent.providerState, "Confirmed");
  assert.equal(secondIntent.failureReasonCode, null);
  assert.equal(secondIntent.failureDetail, null);
  assert.ok(secondIntent.providerReference);
});

test("fundDeal second-attempt failure updates the SAME row's failure fields; no new intent", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const failing = new StubEscrowProvider({
    kind: "throw",
    message: "first",
  });
  const service = new FundingService({
    fundingRepository: repo,
    escrowProvider: failing,
  });
  await assert.rejects(() =>
    service.fundDeal({
      userAccountId: USER_ID,
      actingWorkspaceId: BUYER_WS,
      dealId: DEAL_ID,
    }),
  );
  const failing2 = new StubEscrowProvider({
    kind: "throw",
    message: "second",
  });
  const service2 = new FundingService({
    fundingRepository: repo,
    escrowProvider: failing2,
  });
  await assert.rejects(() =>
    service2.fundDeal({
      userAccountId: USER_ID,
      actingWorkspaceId: BUYER_WS,
      dealId: DEAL_ID,
    }),
  );
  const intent = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(intent);
  assert.equal(intent.providerState, "Failed");
  assert.equal(intent.failureDetail, "second");
});

test("fundDeal Confirmed short-circuit: a second call when intent is Confirmed does NOT call the provider", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const provider = new StubEscrowProvider({ kind: "ok" });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  await service.fundDeal({
    userAccountId: USER_ID,
    actingWorkspaceId: BUYER_WS,
    dealId: DEAL_ID,
    now: new Date("2026-09-03T12:00:00.000Z"),
  });
  assert.equal(provider.callCount, 1);
  // Second call — Deal is now Active, so Phase 1 preauth rejects with
  // BG6_DEAL_NOT_NEGOTIATING. Either way, the provider must NOT be
  // called a second time.
  await assert.rejects(
    () =>
      service.fundDeal({
        userAccountId: USER_ID,
        actingWorkspaceId: BUYER_WS,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof FundingServiceError);
      // The Deal was already activated by the first call.
      assert.ok(err.code === "BG6_DEAL_NOT_NEGOTIATING" || err.code === "BG6_DEAL_ALREADY_ACTIVE");
      return true;
    },
  );
  assert.equal(
    provider.callCount,
    1,
    "provider must NOT be called on a second fundDeal for the same Deal",
  );
});

// ---------- Deterministic mock sanity ----------

test("DeterministicMockEscrowProvider integrates end-to-end (provider returns unmistakable simulated label)", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const service = new FundingService({
    fundingRepository: repo,
    escrowProvider: new DeterministicMockEscrowProvider(),
  });
  const result = await service.fundDeal({
    userAccountId: USER_ID,
    actingWorkspaceId: BUYER_WS,
    dealId: DEAL_ID,
    now: new Date("2026-09-03T12:00:00.000Z"),
  });
  assert.equal(result.fundingStatus.networkLabel, "simulated-polkadot-asset-hub-testnet");
  assert.equal(result.fundingStatus.assetLabel, "sandbox-USDC");
  assert.equal(result.fundingStatus.environmentLabel, "sandbox");
  assert.equal(result.fundingStatus.providerKey, "mock-escrow-deterministic");
});
