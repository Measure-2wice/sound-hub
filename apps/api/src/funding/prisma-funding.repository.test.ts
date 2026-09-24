/* eslint-disable @typescript-eslint/no-floating-promises */
// PrismaFundingRepository integration tests (BG6).
//
// Background: ticket #64 acceptance criteria require the BG6
// repository to:
//   - persist durable PaymentIntent rows with providerState =
//     "Created" at find-or-create time (Phase 2 deterministic
//     convergence via parent TermsVersion FOR UPDATE-lock + P2002
//     second-defense)
//   - retry-safe transitions Created → Confirmed, Failed → Confirmed,
//     Failed → Failed on the SAME (dealId, termsVersionId) row
//   - guard the activation UPDATE with `WHERE status = 'Negotiating'
//     RETURNING id` so concurrent activations collapse to one
//   - persist the sanitized failureReasonCode while keeping the raw
//     failureDetail server-only
//   - reject Phase-3 calls when exact-match (amount/currency/
//     termsVersionId) fails
//
// These tests run against the disposable PostgreSQL target via
// `pnpm db:test:reset`. They assert observable persisted outcomes
// only — no source-pattern checks, no assertions on private ORM
// call ordering, no test-only hooks added to the production
// repository.

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { PrismaClient } from "@soundhub/db";
import { createPrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaFundingRepository } from "./prisma-funding.repository.js";
import type { FundDealUseCase } from "./funding.repository.js";

let prisma: PrismaClient;
let repo: PrismaFundingRepository;

const BUYER_USER_ID = "user-bg6-buyer";
const SELLER_USER_ID = "user-bg6-seller";
const BUYER_WORKSPACE_ID = "ws-bg6-buyer";
const SELLER_WORKSPACE_ID = "ws-bg6-seller";
const OFFERING_ID = "of-bg6-1";
const BRIEF_ID = "brief-bg6-1";
const DEAL_ID = "deal-bg6-1";
const TV_ID = "tv-bg6-1";
const TV_VERSION = 1;

interface Fx {
  buyerUserId: string;
  sellerUserId: string;
  buyerWorkspaceId: string;
  sellerWorkspaceId: string;
  serviceOfferingId: string;
  briefId: string;
  dealId: string;
  termsVersionId: string;
}

async function seedFixture(prisma: PrismaClient): Promise<Fx> {
  // Users
  await prisma.userAccount.upsert({
    where: { id: BUYER_USER_ID },
    update: {},
    create: { id: BUYER_USER_ID, email: `${BUYER_USER_ID}@example.test` },
  });
  await prisma.userAccount.upsert({
    where: { id: SELLER_USER_ID },
    update: {},
    create: { id: SELLER_USER_ID, email: `${SELLER_USER_ID}@example.test` },
  });
  // Workspaces
  await prisma.workspace.upsert({
    where: { id: BUYER_WORKSPACE_ID },
    update: { status: "Active" },
    create: {
      id: BUYER_WORKSPACE_ID,
      slug: "ws-bg6-buyer",
      name: "BG6 Buyer WS",
      type: "Personal",
      status: "Active",
      ownerUserId: BUYER_USER_ID,
    },
  });
  await prisma.workspace.upsert({
    where: { id: SELLER_WORKSPACE_ID },
    update: { status: "Active" },
    create: {
      id: SELLER_WORKSPACE_ID,
      slug: "ws-bg6-seller",
      name: "BG6 Seller WS",
      type: "Personal",
      status: "Active",
      ownerUserId: SELLER_USER_ID,
    },
  });
  // Membership
  await prisma.workspaceMembership.upsert({
    where: { userId_workspaceId: { userId: BUYER_USER_ID, workspaceId: BUYER_WORKSPACE_ID } },
    update: {},
    create: {
      userId: BUYER_USER_ID,
      workspaceId: BUYER_WORKSPACE_ID,
      role: "Owner",
    },
  });
  // Capabilities
  await prisma.workspaceCapability.upsert({
    where: { workspaceId_capability: { workspaceId: BUYER_WORKSPACE_ID, capability: "Buyer" } },
    update: {},
    create: { workspaceId: BUYER_WORKSPACE_ID, capability: "Buyer" },
  });
  await prisma.workspaceCapability.upsert({
    where: { workspaceId_capability: { workspaceId: SELLER_WORKSPACE_ID, capability: "Seller" } },
    update: {},
    create: { workspaceId: SELLER_WORKSPACE_ID, capability: "Seller" },
  });
  // Minimal offering + brief so the Deal FKs resolve.
  const category = await prisma.serviceCategory.upsert({
    where: { key: "bg6-mix" },
    update: {},
    create: {
      key: "bg6-mix",
      name: "BG6 Mix",
      description: "BG6 test category",
      bundleOnly: false,
    },
  });
  await prisma.sellerProfile.upsert({
    where: { id: "sp-bg6-1" },
    update: {},
    create: {
      id: "sp-bg6-1",
      workspaceId: SELLER_WORKSPACE_ID,
      professionalName: "BG6 Seller",
      bio: "BG6 test seller profile",
      status: "Published",
      basedInCountryCode: "JM",
    },
  });
  await prisma.serviceOffering.upsert({
    where: { id: OFFERING_ID },
    update: {},
    create: {
      id: OFFERING_ID,
      slug: "of-bg6-1",
      sellerProfileId: "sp-bg6-1",
      title: "BG6 offering",
      description: "BG6 test offering",
      status: "Active",
      serviceMode: "Remote",
      primaryCategoryId: category.id,
    },
  });
  await prisma.projectBrief.upsert({
    where: { id: BRIEF_ID },
    update: {},
    create: {
      id: BRIEF_ID,
      buyerWorkspaceId: BUYER_WORKSPACE_ID,
      createdByUserId: BUYER_USER_ID,
      originalText: "BG6 brief",
      requiredCriteriaJson: {},
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
    },
  });
  // Clean Deal + child rows for repeatable runs. Order matters
  // because of FK constraints (RESTRICT).
  await prisma.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  await prisma.dealApproval.deleteMany({ where: { termsVersionId: TV_ID } });
  await prisma.termsVersion.deleteMany({ where: { dealId: DEAL_ID } });
  await prisma.dealApprover.deleteMany({
    where: { id: { in: ["dapp-bg6-buyer", "dapp-bg6-seller"] } },
  });
  await prisma.deal.deleteMany({ where: { id: DEAL_ID } });
  await prisma.projectRequest.deleteMany({ where: { id: "pr-bg6-1" } });
  // Create ProjectRequest FIRST (Deal FK), then Deal + TermsVersion + both DealApprovals.
  await prisma.projectRequest.create({
    data: {
      id: "pr-bg6-1",
      buyerWorkspaceId: BUYER_WORKSPACE_ID,
      sellerWorkspaceId: SELLER_WORKSPACE_ID,
      serviceOfferingId: OFFERING_ID,
      projectBriefId: BRIEF_ID,
      createdByUserId: BUYER_USER_ID,
      status: "Accepted",
      sellerConsentAt: new Date("2026-09-01T10:00:00.000Z"),
    },
  });
  await prisma.deal.create({
    data: {
      id: DEAL_ID,
      buyerWorkspaceId: BUYER_WORKSPACE_ID,
      sellerWorkspaceId: SELLER_WORKSPACE_ID,
      serviceOfferingId: OFFERING_ID,
      projectBriefId: BRIEF_ID,
      projectRequestId: "pr-bg6-1",
      status: "Negotiating",
    },
  });
  await prisma.termsVersion.create({
    data: {
      id: TV_ID,
      dealId: DEAL_ID,
      version: TV_VERSION,
      scope: "BG6 scope",
      deliverablesJson: [{ title: "Mix", description: "Mix-ready master" }],
      scheduleJson: { startDate: "2026-09-01", endDate: "2026-09-22", deliveryDays: 21 },
      priceAmountMinor: 75000,
      priceCurrency: "USD",
      revisionAllowance: 1,
      rightsSummary: "Non-exclusive worldwide rights",
      aiProvider: "deterministic-fallback",
      aiFallbackUsed: true,
      draftedAt: new Date("2026-09-01T09:00:00.000Z"),
    },
  });
  // DealApprover authorization rows must exist before any
  // DealApproval row references them.
  await prisma.dealApprover.create({
    data: {
      id: "dapp-bg6-buyer",
      workspaceId: BUYER_WORKSPACE_ID,
      userId: BUYER_USER_ID,
      grantedByUserId: BUYER_USER_ID,
    },
  });
  await prisma.dealApprover.create({
    data: {
      id: "dapp-bg6-seller",
      workspaceId: SELLER_WORKSPACE_ID,
      userId: SELLER_USER_ID,
      grantedByUserId: SELLER_USER_ID,
    },
  });
  await prisma.dealApproval.create({
    data: {
      id: "da-bg6-buyer",
      termsVersionId: TV_ID,
      workspaceId: BUYER_WORKSPACE_ID,
      dealApproverId: "dapp-bg6-buyer",
      approvedByUserId: BUYER_USER_ID,
      approvedAt: new Date("2026-09-02T09:00:00.000Z"),
    },
  });
  await prisma.dealApproval.create({
    data: {
      id: "da-bg6-seller",
      termsVersionId: TV_ID,
      workspaceId: SELLER_WORKSPACE_ID,
      dealApproverId: "dapp-bg6-seller",
      approvedByUserId: SELLER_USER_ID,
      approvedAt: new Date("2026-09-02T10:00:00.000Z"),
    },
  });
  return {
    buyerUserId: BUYER_USER_ID,
    sellerUserId: SELLER_USER_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    serviceOfferingId: OFFERING_ID,
    briefId: BRIEF_ID,
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
  };
}

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prisma = createPrismaClient(url);
  repo = new PrismaFundingRepository(prisma);
  await seedFixture(prisma);
});

after(async () => {
  await prisma.$disconnect();
});

// ---------- findOrCreatePaymentIntentInTransaction ----------

test("findOrCreatePaymentIntentInTransaction inserts a row with providerState = Created and the supplied correlationId", async () => {
  // Clean any prior intent for the deal.
  await prisma.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  const result = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    createdByUserId: BUYER_USER_ID,
    correlationId: "corr_bg6_happy",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.providerState, "Created");
  assert.equal(result.value.correlationId, "corr_bg6_happy");
  assert.equal(result.value.expectedAmountMinor, 75000);
});

test("findOrCreatePaymentIntentInTransaction converges retries on the SAME row", async () => {
  await prisma.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  const a = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    createdByUserId: BUYER_USER_ID,
    correlationId: "corr_first",
  });
  const b = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    createdByUserId: BUYER_USER_ID,
    // Different correlationId — must STILL converge on the SAME row.
    correlationId: "corr_second",
  });
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.value.id, b.value.id);
  assert.equal(
    a.value.correlationId,
    "corr_first",
    "first write wins; the second correlationId is discarded",
  );
});

test("findOrCreatePaymentIntentInTransaction returns TERMS_VERSION_NOT_FOUND for an unknown TV", async () => {
  const result = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: "tv-does-not-exist",
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    createdByUserId: BUYER_USER_ID,
    correlationId: "corr_unknown",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "TERMS_VERSION_NOT_FOUND");
});

// ---------- recordPaymentIntentFailureInTransaction ----------

test("recordPaymentIntentFailureInTransition transitions Created → Failed with sanitized code + closed category; raw detail is NOT persisted (P1-004)", async () => {
  await prisma.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  const created = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    createdByUserId: BUYER_USER_ID,
    correlationId: "corr_failure",
  });
  if (!created.ok) throw new Error("seed failed");
  const result = await repo.recordPaymentIntentFailureInTransaction({
    paymentIntentId: created.value.id,
    failureReasonCode: "EscrowProviderUnavailable",
    failureDetailCategory: "PROVIDER_UNAVAILABLE",
  });
  assert.deepEqual(result, { ok: true, persisted: true });
  const reread = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(reread);
  assert.equal(reread.providerState, "Failed");
  assert.equal(reread.failureReasonCode, "EscrowProviderUnavailable");
  assert.equal(reread.failureDetailCategory, "PROVIDER_UNAVAILABLE");
});

test("recordPaymentIntentFailureInTransaction is a no-op when the intent is already Confirmed (P0-002 demotion guard)", async () => {
  await prisma.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  const created = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    createdByUserId: BUYER_USER_ID,
    correlationId: "corr_confirmed",
  });
  if (!created.ok) throw new Error("seed failed");
  // Mark the intent Confirmed.
  await prisma.paymentIntent.update({
    where: { id: created.value.id },
    data: {
      providerState: "Confirmed",
      providerReference: "mock_pi-corr_confirmed",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
    },
  });
  // Attempt a late concurrent failure — must be a no-op.
  const result = await repo.recordPaymentIntentFailureInTransaction({
    paymentIntentId: created.value.id,
    failureReasonCode: "EscrowProviderUnavailable",
    failureDetailCategory: "PROVIDER_UNAVAILABLE",
  });
  assert.deepEqual(result, { ok: true, persisted: false, reason: "ALREADY_CONFIRMED" });
  const reread = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(reread);
  assert.equal(reread.providerState, "Confirmed", "Confirmed intent must NOT be demoted to Failed");
  assert.equal(reread.failureReasonCode, null);
  assert.equal(reread.failureDetailCategory, null);
});

// ---------- fundDealInTransaction ----------

test("fundDealInTransaction activates the Deal and transitions the intent to Confirmed on the happy path", async () => {
  await prisma.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  // Reset Deal state in case a prior test left it Active.
  await prisma.deal.update({
    where: { id: DEAL_ID },
    data: { status: "Negotiating", activatedAt: null },
  });
  const created = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    createdByUserId: BUYER_USER_ID,
    correlationId: "corr_fund",
  });
  if (!created.ok) throw new Error("seed failed");
  // Mark Confirmed (the service does this after a provider call).
  await prisma.paymentIntent.update({
    where: { id: created.value.id },
    data: {
      providerState: "Confirmed",
      providerReference: "mock_pi-corr_fund",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
    },
  });
  const accept: FundDealUseCase = (ctx, tools) =>
    tools.persistFundingConfirmationAndActivate({
      paymentIntentId: ctx.paymentIntentId,
      providerReference: "mock_pi-corr_fund",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
    });
  const result = await repo.fundDealInTransaction(
    {
      dealId: DEAL_ID,
      paymentIntentId: created.value.id,
      providerReference: "mock_pi-corr_fund",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    accept,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.deal.status, "Active");
  assert.ok(result.value.deal.activatedAt);
  assert.equal(result.value.paymentIntent.providerState, "Confirmed");
  assert.equal(result.value.paymentIntent.failureReasonCode, null);
  assert.equal(result.value.paymentIntent.failureDetailCategory, null);
});

test("fundDealInTransaction rejects with DEAL_ALREADY_ACTIVE when the guarded UPDATE matches 0 rows", async () => {
  await prisma.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  await prisma.deal.update({
    where: { id: DEAL_ID },
    data: { status: "Active", activatedAt: new Date("2026-09-02T11:00:00.000Z") },
  });
  const created = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    createdByUserId: BUYER_USER_ID,
    correlationId: "corr_double",
  });
  if (!created.ok) throw new Error("seed failed");
  await prisma.paymentIntent.update({
    where: { id: created.value.id },
    data: {
      providerState: "Confirmed",
      providerReference: "mock_pi-corr_double",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
    },
  });
  const accept: FundDealUseCase = (ctx, tools) =>
    tools.persistFundingConfirmationAndActivate({
      paymentIntentId: ctx.paymentIntentId,
      providerReference: "mock_pi-corr_double",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
    });
  const result = await repo.fundDealInTransaction(
    {
      dealId: DEAL_ID,
      paymentIntentId: created.value.id,
      providerReference: "mock_pi-corr_double",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    accept,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "DEAL_ALREADY_ACTIVE");
});

test("fundDealInTransaction persists Confirmed fields + activates the Deal even when the intent starts in Created state", async () => {
  await prisma.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  await prisma.deal.update({
    where: { id: DEAL_ID },
    data: { status: "Negotiating", activatedAt: null },
  });
  const created = await repo.findOrCreatePaymentIntentInTransaction({
    dealId: DEAL_ID,
    termsVersionId: TV_ID,
    expectedAmountMinor: 75000,
    expectedCurrency: "USD",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    providerKey: "mock-escrow-deterministic",
    environmentLabel: "sandbox",
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    createdByUserId: BUYER_USER_ID,
    correlationId: "corr_created_then_confirmed",
  });
  if (!created.ok) throw new Error("seed failed");
  // Phase 3 transitions Created → Confirmed atomically with the
  // guarded activation UPDATE.
  const accept: FundDealUseCase = (ctx, tools) =>
    tools.persistFundingConfirmationAndActivate({
      paymentIntentId: ctx.paymentIntentId,
      providerReference: "mock_pi-x",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
    });
  const result = await repo.fundDealInTransaction(
    {
      dealId: DEAL_ID,
      paymentIntentId: created.value.id,
      providerReference: "mock_pi-x",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    accept,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.deal.status, "Active");
  assert.equal(result.value.paymentIntent.providerState, "Confirmed");
});
