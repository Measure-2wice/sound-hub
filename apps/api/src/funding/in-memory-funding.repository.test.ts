// In-memory FundingRepository contract tests.
//
// The repository tests focus on persisted state, transactionality,
// locking, retry safety, exact-version/amount matching, and guarded
// activation (per refinement feedback). The in-memory adapter is
// limited to single-flight concurrency; real concurrency tests live
// in prisma-funding.repository.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryFundingRepository,
  type DealSeedForFunding,
  type TermsVersionSeedForFunding,
  type DealApprovalSeedForFunding,
  type ProjectRequestSeedForFunding,
  type WorkspaceSeedForFunding,
  type MembershipSeedForFunding,
} from "./in-memory-funding.repository.js";
import type { FundDealUseCase } from "./funding.repository.js";

const DEAL_ID = "deal_test_001";
const BUYER_WS = "ws_buyer";
const SELLER_WS = "ws_seller";
const TV_ID = "tv_current";
const USER_ID = "user_buyer";

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

test("findPreauthSnapshot returns DEAL_NOT_FOUND for unknown deal", async () => {
  const repo = new InMemoryFundingRepository();
  const result = await repo.findPreauthSnapshot({
    dealId: "missing",
    actingWorkspaceId: BUYER_WS,
    actingUserAccountId: USER_ID,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "DEAL_NOT_FOUND");
});

test("findPreauthSnapshot returns the assembled snapshot on the happy path", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const result = await repo.findPreauthSnapshot({
    dealId: DEAL_ID,
    actingWorkspaceId: BUYER_WS,
    actingUserAccountId: USER_ID,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.dealStatus, "Negotiating");
  assert.equal(result.value.currentTermsVersionId, TV_ID);
  assert.equal(result.value.buyerApprovalExists, true);
  assert.equal(result.value.sellerApprovalExists, true);
  assert.equal(result.value.projectRequestStatus, "Accepted");
  assert.equal(result.currentTermsVersion.id, TV_ID);
  assert.equal(result.currentTermsVersion.priceAmountMinor, 75000);
  assert.equal(result.currentTermsVersion.priceCurrency, "USD");
});

test("findPreauthSnapshot reports NOT_A_MEMBER when membership is missing", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  // Drop membership AFTER seeding.
  repo.removeMembership(USER_ID, BUYER_WS);
  const result = await repo.findPreauthSnapshot({
    dealId: DEAL_ID,
    actingWorkspaceId: BUYER_WS,
    actingUserAccountId: USER_ID,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.actingUserIsMember, false);
});

test("findOrCreatePaymentIntentInTransaction converges retries on the SAME row", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const a = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-polkadot-asset-hub-testnet",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WS,
    createdByUserId: USER_ID,
    correlationId: "00000000-0000-4000-8000-000000000001",
  });
  const b = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-polkadot-asset-hub-testnet",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WS,
    createdByUserId: USER_ID,
    correlationId: "00000000-0000-4000-8000-000000000002",
  });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.value.id, b.value.id, "retries must converge on the SAME row");
  assert.equal(a.value.correlationId, "00000000-0000-4000-8000-000000000001");
});

test("recordPaymentIntentFailureInTransaction transitions Created → Failed with sanitized code", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const created = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-polkadot-asset-hub-testnet",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WS,
    createdByUserId: USER_ID,
    correlationId: "corr_001",
  });
  if (!created.ok) throw new Error("seed failed");
  await repo.recordPaymentIntentFailureInTransaction({
    paymentIntentId: created.value.id,
    failureReasonCode: "EscrowProviderUnavailable",
    failureDetail: "ECONNRESET (server-only)",
  });
  const reread = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(reread);
  assert.equal(reread.providerState, "Failed");
  assert.equal(reread.failureReasonCode, "EscrowProviderUnavailable");
  assert.equal(reread.failureDetail, "ECONNRESET (server-only)");
});

test("recordPaymentIntentFailureInTransaction on a Failed intent updates the latest attempt's fields", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const created = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-polkadot-asset-hub-testnet",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WS,
    createdByUserId: USER_ID,
    correlationId: "corr_001",
  });
  if (!created.ok) throw new Error("seed failed");
  await repo.recordPaymentIntentFailureInTransaction({
    paymentIntentId: created.value.id,
    failureReasonCode: "EscrowProviderUnavailable",
    failureDetail: "first",
  });
  await repo.recordPaymentIntentFailureInTransaction({
    paymentIntentId: created.value.id,
    failureReasonCode: "EscrowConfirmationAmountMismatch",
    failureDetail: "second",
  });
  const reread = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(reread);
  assert.equal(reread.providerState, "Failed");
  assert.equal(reread.failureReasonCode, "EscrowConfirmationAmountMismatch");
  assert.equal(reread.failureDetail, "second");
  // Same row — still one intent for the (dealId, termsVersionId) tuple.
  assert.equal(reread.id, created.value.id);
});

test("fundDealInTransaction transitions the Deal to Active on the happy path", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  // Seed a Confirmed intent (the service would normally reach this
  // state after Phase 2 + provider success).
  const created = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-polkadot-asset-hub-testnet",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WS,
    createdByUserId: USER_ID,
    correlationId: "corr_001",
  });
  if (!created.ok) throw new Error("seed failed");
  // Manually flip the intent to Confirmed so fundDealInTransaction
  // accepts it (the in-memory test bypasses the provider call).
  repo.seedPaymentIntent({
    ...created.value,
    providerState: "Confirmed",
    providerReference: "mock_pi-corr_001",
    confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
    acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
  });
  const accept: FundDealUseCase = (ctx, tools) => {
    // Use case simply persists — the in-memory test confirms the
    // repository wired the snapshot rows correctly.
    return tools.persistFundingConfirmationAndActivate({
      paymentIntentId: ctx.paymentIntentId,
      providerReference: "mock_pi-corr_001",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
    });
  };
  const result = await repo.fundDealInTransaction(
    {
      dealId: DEAL_ID,
      paymentIntentId: created.value.id,
      providerReference: "mock_pi-corr_001",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
      actingWorkspaceId: BUYER_WS,
      actingUserAccountId: USER_ID,
    },
    accept,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.deal.status, "Active");
  assert.ok(result.value.deal.activatedAt);
  assert.equal(result.value.paymentIntent.providerState, "Confirmed");
});

test("fundDealInTransaction rejects with DEAL_ALREADY_ACTIVE when already Active", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  repo.seedDeal({
    id: DEAL_ID,
    buyerWorkspaceId: BUYER_WS,
    sellerWorkspaceId: SELLER_WS,
    status: "Active",
    activatedAt: new Date("2026-09-01T12:00:00.000Z"),
  });
  const created = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-polkadot-asset-hub-testnet",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WS,
    createdByUserId: USER_ID,
    correlationId: "corr_001",
  });
  if (!created.ok) throw new Error("seed failed");
  repo.seedPaymentIntent({
    ...created.value,
    providerState: "Confirmed",
    providerReference: "mock_pi-corr_001",
    confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
    acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
  });
  const accept: FundDealUseCase = (ctx, tools) =>
    tools.persistFundingConfirmationAndActivate({
      paymentIntentId: ctx.paymentIntentId,
      providerReference: "mock_pi-corr_001",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
    });
  const result = await repo.fundDealInTransaction(
    {
      dealId: DEAL_ID,
      paymentIntentId: created.value.id,
      providerReference: "mock_pi-corr_001",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
      actingWorkspaceId: BUYER_WS,
      actingUserAccountId: USER_ID,
    },
    accept,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "DEAL_ALREADY_ACTIVE");
});
