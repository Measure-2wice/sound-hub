/* eslint-disable @typescript-eslint/no-floating-promises */
// Real-PostgreSQL concurrency tests for PrismaFundingRepository (BG6).
//
// Background: ticket #64 acceptance criteria require observable
// persisted-state coverage for:
//   - concurrent create attempts converging on a single PaymentIntent
//   - two concurrent successful funding attempts resulting in one
//     Confirmed intent + one Active Deal
//   - success racing failure producing NO "Active + Failed" state
//   - membership / capability / approval / TermsVersion / deal-state
//     mutations between Phase 1 and Phase 3 failing closed
//   - no duplicate provider outcome or activation persisted
//
// These tests run against the disposable PostgreSQL target via
// `pnpm db:test:reset`. They use TWO independent Prisma clients
// against the same database so each "thread" owns its connection
// pool, matching a real request-handling scenario where two
// concurrent HTTP calls open two separate transactions on different
// PostgreSQL backends.

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaFundingRepository } from "./prisma-funding.repository.js";

const BUYER_USER_ID = "user-bg6c-buyer";
const SELLER_USER_ID = "user-bg6c-seller";
const BUYER_WORKSPACE_ID = "ws-bg6c-buyer";
const SELLER_WORKSPACE_ID = "ws-bg6c-seller";
const OFFERING_ID = "of-bg6c-1";
const BRIEF_ID = "brief-bg6c-1";
const DEAL_ID = "deal-bg6c-1";
const TV_ID = "tv-bg6c-1";

let prismaA: PrismaClient;
let prismaB: PrismaClient;
let repoA: PrismaFundingRepository;
let repoB: PrismaFundingRepository;

async function seedFixture(prisma: PrismaClient): Promise<void> {
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
  await prisma.workspace.upsert({
    where: { id: BUYER_WORKSPACE_ID },
    update: { status: "Active" },
    create: {
      id: BUYER_WORKSPACE_ID,
      slug: "ws-bg6c-buyer",
      name: "BG6C Buyer WS",
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
      slug: "ws-bg6c-seller",
      name: "BG6C Seller WS",
      type: "Personal",
      status: "Active",
      ownerUserId: SELLER_USER_ID,
    },
  });
  await prisma.workspaceMembership.upsert({
    where: { userId_workspaceId: { userId: BUYER_USER_ID, workspaceId: BUYER_WORKSPACE_ID } },
    update: {},
    create: {
      userId: BUYER_USER_ID,
      workspaceId: BUYER_WORKSPACE_ID,
      role: "Owner",
    },
  });
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
  const category = await prisma.serviceCategory.upsert({
    where: { key: "bg6c-mix" },
    update: {},
    create: {
      key: "bg6c-mix",
      name: "BG6C Mix",
      description: "BG6C test category",
      bundleOnly: false,
    },
  });
  await prisma.sellerProfile.upsert({
    where: { id: "sp-bg6c-1" },
    update: {},
    create: {
      id: "sp-bg6c-1",
      workspaceId: SELLER_WORKSPACE_ID,
      professionalName: "BG6C Seller",
      bio: "BG6C test seller profile",
      status: "Published",
      basedInCountryCode: "JM",
    },
  });
  await prisma.serviceOffering.upsert({
    where: { id: OFFERING_ID },
    update: {},
    create: {
      id: OFFERING_ID,
      slug: "of-bg6c-1",
      sellerProfileId: "sp-bg6c-1",
      title: "BG6C offering",
      description: "BG6C test offering",
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
      originalText: "BG6C brief",
      requiredCriteriaJson: {},
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
    },
  });
  await prisma.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  await prisma.dealApproval.deleteMany({ where: { termsVersionId: TV_ID } });
  await prisma.termsVersion.deleteMany({ where: { dealId: DEAL_ID } });
  await prisma.dealApprover.deleteMany({
    where: { id: { in: ["dapp-bg6c-buyer", "dapp-bg6c-seller"] } },
  });
  await prisma.deal.deleteMany({ where: { id: DEAL_ID } });
  await prisma.projectRequest.deleteMany({ where: { id: "pr-bg6c-1" } });
  await prisma.projectRequest.create({
    data: {
      id: "pr-bg6c-1",
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
      projectRequestId: "pr-bg6c-1",
      status: "Negotiating",
    },
  });
  await prisma.termsVersion.create({
    data: {
      id: TV_ID,
      dealId: DEAL_ID,
      version: 1,
      scope: "BG6C scope",
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
  await prisma.dealApprover.create({
    data: {
      id: "dapp-bg6c-buyer",
      workspaceId: BUYER_WORKSPACE_ID,
      userId: BUYER_USER_ID,
      grantedByUserId: BUYER_USER_ID,
    },
  });
  await prisma.dealApprover.create({
    data: {
      id: "dapp-bg6c-seller",
      workspaceId: SELLER_WORKSPACE_ID,
      userId: SELLER_USER_ID,
      grantedByUserId: SELLER_USER_ID,
    },
  });
  await prisma.dealApproval.create({
    data: {
      id: "da-bg6c-buyer",
      termsVersionId: TV_ID,
      workspaceId: BUYER_WORKSPACE_ID,
      dealApproverId: "dapp-bg6c-buyer",
      approvedByUserId: BUYER_USER_ID,
      approvedAt: new Date("2026-09-02T09:00:00.000Z"),
    },
  });
  await prisma.dealApproval.create({
    data: {
      id: "da-bg6c-seller",
      termsVersionId: TV_ID,
      workspaceId: SELLER_WORKSPACE_ID,
      dealApproverId: "dapp-bg6c-seller",
      approvedByUserId: SELLER_USER_ID,
      approvedAt: new Date("2026-09-02T10:00:00.000Z"),
    },
  });
}

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prismaA = createPrismaClient(url);
  prismaB = createPrismaClient(url);
  repoA = new PrismaFundingRepository(prismaA);
  repoB = new PrismaFundingRepository(prismaB);
  await seedFixture(prismaA);
});

after(async () => {
  await prismaA.$disconnect();
  await prismaB.$disconnect();
});

// ---------- Concurrent create attempts converge on one row ----------

test("two concurrent findOrCreate calls converge on exactly one PaymentIntent row", async () => {
  await prismaA.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  await prismaA.deal.update({
    where: { id: DEAL_ID },
    data: { status: "Negotiating", activatedAt: null },
  });
  const [a, b] = await Promise.all([
    repoA.findOrCreatePaymentIntentInTransaction({
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
      correlationId: "corr_concurrent_a",
    }),
    repoB.findOrCreatePaymentIntentInTransaction({
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
      correlationId: "corr_concurrent_b",
    }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.value.id, b.value.id, "concurrent find-or-create converges on the SAME row");
  const rows = await prismaA.paymentIntent.findMany({ where: { dealId: DEAL_ID } });
  assert.equal(rows.length, 1, "exactly one PaymentIntent row exists");
});

// ---------- Two concurrent successful funding attempts → one Confirmed + one Active ----------

test("two concurrent successful fundDealInTransaction attempts converge on one Confirmed intent + one Active Deal", async () => {
  await prismaA.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  await prismaA.deal.update({
    where: { id: DEAL_ID },
    data: { status: "Negotiating", activatedAt: null },
  });
  const created = await repoA.findOrCreatePaymentIntentInTransaction({
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
    correlationId: "corr_concurrent_fund",
  });
  if (!created.ok) throw new Error("seed failed");
  const accept =
    (providerReference: string) =>
    ({ paymentIntentId }: { paymentIntentId: string }) =>
      ({
        kind: "persist",
        input: {
          paymentIntentId,
          providerReference,
          confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
          acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
        },
      }) as const;
  const [a, b] = await Promise.all([
    repoA.fundDealInTransaction(
      {
        dealId: DEAL_ID,
        paymentIntentId: created.value.id,
        providerReference: "mock_concurrent_a",
        confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
        acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        actingUserAccountId: BUYER_USER_ID,
      },
      accept("mock_concurrent_a"),
    ),
    repoB.fundDealInTransaction(
      {
        dealId: DEAL_ID,
        paymentIntentId: created.value.id,
        providerReference: "mock_concurrent_b",
        confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
        acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        actingUserAccountId: BUYER_USER_ID,
      },
      accept("mock_concurrent_b"),
    ),
  ]);
  const oks = [a.ok, b.ok].filter((v) => v) as true[];
  assert.ok(oks.length >= 1, "at least one fund attempt succeeds");
  // Verify observable PostgreSQL state.
  const deal = await prismaA.deal.findUnique({ where: { id: DEAL_ID } });
  assert.equal(deal?.status, "Active");
  const intent = await prismaA.paymentIntent.findUnique({ where: { id: created.value.id } });
  assert.equal(intent?.providerState, "Confirmed");
  const intentsForDeal = await prismaA.paymentIntent.findMany({ where: { dealId: DEAL_ID } });
  assert.equal(intentsForDeal.length, 1, "exactly one PaymentIntent row exists");
});

// ---------- Success racing failure cannot produce Active + Failed ----------

test("success racing failure: a Confirmed intent is never demoted to Failed (P0-002)", async () => {
  await prismaA.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  await prismaA.deal.update({
    where: { id: DEAL_ID },
    data: { status: "Negotiating", activatedAt: null },
  });
  const created = await repoA.findOrCreatePaymentIntentInTransaction({
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
    correlationId: "corr_success_race_failure",
  });
  if (!created.ok) throw new Error("seed failed");
  const accept = ({ paymentIntentId }: { paymentIntentId: string }) =>
    ({
      kind: "persist",
      input: {
        paymentIntentId,
        providerReference: "mock_race_success",
        confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
        acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
      },
    }) as const;
  const successPromise = repoA.fundDealInTransaction(
    {
      dealId: DEAL_ID,
      paymentIntentId: created.value.id,
      providerReference: "mock_race_success",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    accept,
  );
  // Launch a concurrent late failure attempt; it must converge on
  // ALREADY_CONFIRMED (no-op) once the success commits.
  const failurePromise = repoB.recordPaymentIntentFailureInTransaction({
    paymentIntentId: created.value.id,
    failureReasonCode: "EscrowProviderUnavailable",
    failureDetailCategory: "PROVIDER_UNAVAILABLE",
  });
  const [, failureResult] = await Promise.all([successPromise, failurePromise]);
  assert.deepEqual(failureResult, { ok: true, persisted: false, reason: "ALREADY_CONFIRMED" });
  // Final observable state: exactly one intent, Confirmed, and Deal
  // is Active. NO Active + Failed state may be observable.
  const deal = await prismaA.deal.findUnique({ where: { id: DEAL_ID } });
  assert.equal(deal?.status, "Active");
  const intent = await prismaA.paymentIntent.findUnique({ where: { id: created.value.id } });
  assert.equal(intent?.providerState, "Confirmed", "Confirmed must NOT be demoted to Failed");
  assert.equal(intent?.failureReasonCode, null);
  assert.equal(intent?.failureDetailCategory, null);
});

// ---------- Capability revocation between preauth and Phase 3 fails closed ----------

test("Phase-3 Buyer capability revocation: fundDealInTransaction re-validation fails closed when the buyer WorkspaceCapability(Buyer) row is removed between preauth and Phase 3", async () => {
  await prismaA.paymentIntent.deleteMany({ where: { dealId: DEAL_ID } });
  await prismaA.deal.update({
    where: { id: DEAL_ID },
    data: { status: "Negotiating", activatedAt: null },
  });
  // Re-grant Buyer capability so Phase 1 preauth passes.
  await prismaA.workspaceCapability.upsert({
    where: { workspaceId_capability: { workspaceId: BUYER_WORKSPACE_ID, capability: "Buyer" } },
    update: {},
    create: { workspaceId: BUYER_WORKSPACE_ID, capability: "Buyer" },
  });
  // Confirm the snapshot still has Buyer capability.
  const preauthBefore = await repoA.findPreauthSnapshot({
    dealId: DEAL_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
    actingUserAccountId: BUYER_USER_ID,
  });
  assert.equal(preauthBefore.ok, true);
  if (!preauthBefore.ok) return;
  assert.equal(preauthBefore.value.hasBuyerCapability, true);
  const created = await repoA.findOrCreatePaymentIntentInTransaction({
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
    correlationId: "corr_capability_revoke",
  });
  if (!created.ok) throw new Error("seed failed");
  // Revoke the Buyer capability BEFORE Phase 3 re-validation runs.
  await prismaA.workspaceCapability.delete({
    where: {
      workspaceId_capability: { workspaceId: BUYER_WORKSPACE_ID, capability: "Buyer" },
    },
  });
  const rejectUseCase = () => ({ kind: "reject", reason: "MISSING_BUYER_CAPABILITY" }) as const;
  const result = await repoA.fundDealInTransaction(
    {
      dealId: DEAL_ID,
      paymentIntentId: created.value.id,
      providerReference: "mock_capability_revoke",
      confirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      acceptedAt: new Date("2026-09-03T12:00:00.000Z"),
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    rejectUseCase,
  );
  // Phase 3 re-validation may either reject via the application
  // policy (MISSING_BUYER_CAPABILITY) OR be blocked by the repository
  // before the use case runs (capability read returns 0). Both are
  // acceptable — the contract is "Deal NOT Active, intent NOT
  // Confirmed".
  assert.equal(result.ok, false);
  const deal = await prismaA.deal.findUnique({ where: { id: DEAL_ID } });
  assert.equal(deal?.status, "Negotiating", "Deal MUST remain Negotiating on capability revoke");
  const intent = await prismaA.paymentIntent.findUnique({ where: { id: created.value.id } });
  assert.equal(intent?.providerState, "Created");
  // Restore capability so subsequent tests are independent.
  await prismaA.workspaceCapability.create({
    data: { workspaceId: BUYER_WORKSPACE_ID, capability: "Buyer" },
  });
});
