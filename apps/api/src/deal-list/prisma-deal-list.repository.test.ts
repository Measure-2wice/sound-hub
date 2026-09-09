/* eslint-disable @typescript-eslint/no-floating-promises */
// PrismaDealListRepository integration tests (ticket #74).
//
// Background: ticket #74 acceptance criteria require the Deal list to:
//   - return the Deals of the EXACT acting Workspace (buyer or seller
//     side), newest first
//   - carry human-readable display context (offering title, both
//     Workspace names)
//   - derive state inputs from the CURRENT TermsVersion only
//   - FAIL CLOSED when membership is revoked
//   - fail closed for a Suspended Workspace and an unknown Workspace
//   - never surface another Workspace's Deals
//
// The critical case is the revoked member. Authorization and the
// private read share ONE transaction: the adapter FOR UPDATE-locks the
// Workspace row and the EXACT (user, workspace) membership row before
// any Deal row is read, so a revocation cannot interleave between an
// authorization check and the query. This test proves a revoked former
// member receives a rejection AND zero Deal rows.
//
// These tests run against the disposable PostgreSQL target via
// `pnpm db:test:reset`. They assert observable persisted outcomes only
// — no source-pattern checks and no assertions on private ORM call
// ordering.

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { PrismaClient } from "@soundhub/db";
import { createPrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaDealListRepository } from "./prisma-deal-list.repository.js";
import { evaluateDealListReadAuthority } from "./deal-list-authorization-policy.js";
import type {
  ListDealsUseCase,
  ListDealsUseCaseOutcome,
  ListDealsUseCaseTools,
} from "./deal-list.repository.js";

let prisma: PrismaClient;
let repo: PrismaDealListRepository;

const BUYER_USER_ID = "user-dl-buyer";
const SELLER_USER_ID = "user-dl-seller";
const OUTSIDER_USER_ID = "user-dl-outsider";
const BUYER_WORKSPACE_ID = "ws-dl-buyer";
const SELLER_WORKSPACE_ID = "ws-dl-seller";
const OUTSIDER_WORKSPACE_ID = "ws-dl-outsider";
const OFFERING_ID = "of-dl-1";
const BRIEF_ID = "brief-dl-1";
const DEAL_ID = "deal-dl-1";
const OLDER_DEAL_ID = "deal-dl-0";

const BUYER_WORKSPACE_NAME = "DL Test Buyer";
const SELLER_WORKSPACE_NAME = "DL Test Seller";
const OFFERING_TITLE = "DL test offering";

/**
 * The production use case: evaluate the locked snapshot through the
 * application-owned policy. Using the real evaluator (rather than an
 * always-accept stub) is what makes these tests evidence about
 * authorization rather than only about SQL.
 */
function makeListUseCase(): ListDealsUseCase {
  return (ctx, tools: ListDealsUseCaseTools): ListDealsUseCaseOutcome => {
    const verdict = evaluateDealListReadAuthority(ctx.snapshot);
    if (!verdict.ok) return tools.reject(verdict.reason);
    return tools.accept();
  };
}

async function loadFixture(): Promise<void> {
  const category = await prisma.serviceCategory.upsert({
    where: { key: "music-production" },
    create: {
      key: "music-production",
      name: "Music Production",
      description: "Deal-list test category",
      bundleOnly: false,
    },
    update: {},
  });

  const buyer = await prisma.userAccount.upsert({
    where: { id: BUYER_USER_ID },
    create: { id: BUYER_USER_ID, email: "dl-buyer@example.com" },
    update: {},
  });
  const seller = await prisma.userAccount.upsert({
    where: { id: SELLER_USER_ID },
    create: { id: SELLER_USER_ID, email: "dl-seller@example.com" },
    update: {},
  });
  const outsider = await prisma.userAccount.upsert({
    where: { id: OUTSIDER_USER_ID },
    create: { id: OUTSIDER_USER_ID, email: "dl-outsider@example.com" },
    update: {},
  });

  const buyerWorkspace = await prisma.workspace.upsert({
    where: { id: BUYER_WORKSPACE_ID },
    create: {
      id: BUYER_WORKSPACE_ID,
      slug: "dl-test-buyer",
      name: BUYER_WORKSPACE_NAME,
      type: "Personal",
      status: "Active",
      ownerUserId: buyer.id,
    },
    update: { status: "Active", name: BUYER_WORKSPACE_NAME },
  });
  const sellerWorkspace = await prisma.workspace.upsert({
    where: { id: SELLER_WORKSPACE_ID },
    create: {
      id: SELLER_WORKSPACE_ID,
      slug: "dl-test-seller",
      name: SELLER_WORKSPACE_NAME,
      type: "Personal",
      status: "Active",
      ownerUserId: seller.id,
    },
    update: { status: "Active", name: SELLER_WORKSPACE_NAME },
  });
  await prisma.workspace.upsert({
    where: { id: OUTSIDER_WORKSPACE_ID },
    create: {
      id: OUTSIDER_WORKSPACE_ID,
      slug: "dl-test-outsider",
      name: "DL Test Outsider",
      type: "Personal",
      status: "Active",
      ownerUserId: outsider.id,
    },
    update: { status: "Active" },
  });

  // Each human is a member of exactly their OWN Workspace. This
  // matters: the outsider must never see the private Deal, and the
  // buyer must not be a member of the seller Workspace.
  await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: { userId: buyer.id, workspaceId: buyerWorkspace.id },
    },
    create: { userId: buyer.id, workspaceId: buyerWorkspace.id, role: "Owner" },
    update: { role: "Owner" },
  });
  await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: { userId: seller.id, workspaceId: sellerWorkspace.id },
    },
    create: { userId: seller.id, workspaceId: sellerWorkspace.id, role: "Owner" },
    update: { role: "Owner" },
  });
  await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: { userId: outsider.id, workspaceId: OUTSIDER_WORKSPACE_ID },
    },
    create: { userId: outsider.id, workspaceId: OUTSIDER_WORKSPACE_ID, role: "Owner" },
    update: { role: "Owner" },
  });

  const sellerProfile = await prisma.sellerProfile.upsert({
    where: { workspaceId: sellerWorkspace.id },
    create: {
      workspaceId: sellerWorkspace.id,
      professionalName: SELLER_WORKSPACE_NAME,
      bio: "Deal-list test seller",
      status: "Published",
      basedInCountryCode: "US",
    },
    update: { status: "Published" },
  });
  const offering = await prisma.serviceOffering.upsert({
    where: { slug: "dl-test-offering" },
    create: {
      id: OFFERING_ID,
      slug: "dl-test-offering",
      sellerProfileId: sellerProfile.id,
      title: OFFERING_TITLE,
      description: "Deal-list test offering description",
      status: "Active",
      serviceMode: "Remote",
      primaryCategoryId: category.id,
      genreTags: [],
    },
    update: { status: "Active", title: OFFERING_TITLE },
  });
  const brief = await prisma.projectBrief.upsert({
    where: { id: BRIEF_ID },
    create: {
      id: BRIEF_ID,
      buyerWorkspaceId: buyerWorkspace.id,
      createdByUserId: buyer.id,
      originalText: "Deal-list test brief",
      requiredCriteriaJson: {},
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
    },
    update: {},
  });

  // Reset Deal-scoped rows in FK-safe order.
  await resetDeals();

  for (const [dealId, createdAt] of [
    [OLDER_DEAL_ID, new Date("2026-01-01T00:00:00Z")],
    [DEAL_ID, new Date("2026-02-01T00:00:00Z")],
  ] as const) {
    const projectRequest = await prisma.projectRequest.upsert({
      where: { id: `pr-dl-${dealId}` },
      create: {
        id: `pr-dl-${dealId}`,
        buyerWorkspaceId: buyerWorkspace.id,
        sellerWorkspaceId: sellerWorkspace.id,
        serviceOfferingId: offering.id,
        projectBriefId: brief.id,
        createdByUserId: buyer.id,
        status: "Accepted",
        sellerConsentAt: new Date("2026-01-01T00:00:00Z"),
        sellerDecisionByUserId: seller.id,
      },
      update: { status: "Accepted" },
    });
    await prisma.deal.create({
      data: {
        id: dealId,
        buyerWorkspaceId: buyerWorkspace.id,
        sellerWorkspaceId: sellerWorkspace.id,
        serviceOfferingId: offering.id,
        projectBriefId: brief.id,
        projectRequestId: projectRequest.id,
        status: "Negotiating",
        createdAt,
      },
    });
  }
}

async function resetDeals(): Promise<void> {
  const dealIds = [DEAL_ID, OLDER_DEAL_ID];
  await prisma.paymentIntent.deleteMany({ where: { dealId: { in: dealIds } } });
  await prisma.dealApproval.deleteMany({
    where: { termsVersion: { dealId: { in: dealIds } } },
  });
  await prisma.dealApprover.deleteMany({
    where: { workspaceId: { in: [BUYER_WORKSPACE_ID, SELLER_WORKSPACE_ID] } },
  });
  await prisma.termsVersion.deleteMany({ where: { dealId: { in: dealIds } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
}

/** Restore the buyer's membership after a revocation test. */
async function restoreBuyerMembership(): Promise<void> {
  await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: {
        userId: BUYER_USER_ID,
        workspaceId: BUYER_WORKSPACE_ID,
      },
    },
    create: {
      userId: BUYER_USER_ID,
      workspaceId: BUYER_WORKSPACE_ID,
      role: "Owner",
    },
    update: { role: "Owner" },
  });
}

async function setBuyerWorkspaceStatus(status: "Active" | "Suspended"): Promise<void> {
  await prisma.workspace.update({
    where: { id: BUYER_WORKSPACE_ID },
    data: { status },
  });
}

before(async () => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prisma = createPrismaClient(url);
  repo = new PrismaDealListRepository(prisma);
  await loadFixture();
});

after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------- happy path

test("returns the acting buyer Workspace's Deals, newest first", async () => {
  const result = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    makeListUseCase(),
  );

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.map((row) => row.id),
    [DEAL_ID, OLDER_DEAL_ID],
  );
});

test("the seller side sees the same Deals through their own Workspace", async () => {
  const result = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      actingUserAccountId: SELLER_USER_ID,
    },
    makeListUseCase(),
  );

  assert.ok(result.ok);
  assert.deepEqual(
    result.value.map((row) => row.id),
    [DEAL_ID, OLDER_DEAL_ID],
  );
});

test("rows carry the joined human-readable display context", async () => {
  const result = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    makeListUseCase(),
  );

  assert.ok(result.ok);
  const row = result.value.find((candidate) => candidate.id === DEAL_ID);
  assert.ok(row);
  assert.equal(row.serviceOfferingTitle, OFFERING_TITLE);
  assert.equal(row.buyerWorkspaceName, BUYER_WORKSPACE_NAME);
  assert.equal(row.sellerWorkspaceName, SELLER_WORKSPACE_NAME);
});

// ------------------------------------------------------------ derived inputs

test("loads only the CURRENT TermsVersion and its approvals", async () => {
  // Two versions: a superseded v1 that the buyer approved, and a
  // current v2 that nobody has approved. The stale approval must not
  // reach the derived state.
  const v1 = await prisma.termsVersion.create({
    data: {
      dealId: DEAL_ID,
      version: 1,
      scope: "v1 scope",
      deliverablesJson: [],
      scheduleJson: {},
      priceAmountMinor: 50000,
      priceCurrency: "USD",
      revisionAllowance: 1,
      rightsSummary: "v1 rights",
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
      draftedByUserId: BUYER_USER_ID,
      draftedAt: new Date("2026-02-02T00:00:00Z"),
    },
  });
  const approver = await prisma.dealApprover.create({
    data: {
      workspaceId: BUYER_WORKSPACE_ID,
      userId: BUYER_USER_ID,
      grantedByUserId: BUYER_USER_ID,
    },
  });
  await prisma.dealApproval.create({
    data: {
      termsVersionId: v1.id,
      workspaceId: BUYER_WORKSPACE_ID,
      dealApproverId: approver.id,
      approvedByUserId: BUYER_USER_ID,
      approvedAt: new Date("2026-02-03T00:00:00Z"),
    },
  });
  const v2 = await prisma.termsVersion.create({
    data: {
      dealId: DEAL_ID,
      version: 2,
      scope: "v2 scope",
      deliverablesJson: [],
      scheduleJson: {},
      priceAmountMinor: 60000,
      priceCurrency: "USD",
      revisionAllowance: 1,
      rightsSummary: "v2 rights",
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
      draftedByUserId: BUYER_USER_ID,
      draftedAt: new Date("2026-02-04T00:00:00Z"),
    },
  });

  const result = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    makeListUseCase(),
  );

  assert.ok(result.ok);
  const row = result.value.find((candidate) => candidate.id === DEAL_ID);
  assert.ok(row);
  assert.equal(row.currentTermsVersionId, v2.id);
  assert.equal(row.currentTermsVersionNumber, 2);
  assert.deepEqual(
    row.currentApprovalWorkspaceIds,
    [],
    "an approval against the superseded version must not be loaded",
  );
});

test("loads only the PaymentIntent pinned to the current TermsVersion", async () => {
  const versions = await prisma.termsVersion.findMany({
    where: { dealId: DEAL_ID },
    orderBy: { version: "desc" },
  });
  const current = versions[0];
  const stale = versions[1];
  assert.ok(current && stale, "fixture must have a current and a superseded version");

  // A stale intent against the superseded version is durable but
  // activation-insufficient; it must not drive the displayed state.
  await prisma.paymentIntent.create({
    data: {
      dealId: DEAL_ID,
      termsVersionId: stale.id,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      createdByUserId: BUYER_USER_ID,
      expectedAmountMinor: 50000,
      expectedCurrency: "USD",
      assetLabel: "sandbox-USDC",
      networkLabel: "simulated-network",
      providerKey: "mock-escrow-deterministic",
      environmentLabel: "sandbox",
      correlationId: "corr-dl-stale",
      providerState: "Confirmed",
    },
  });

  const beforeCurrentIntent = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    makeListUseCase(),
  );
  assert.ok(beforeCurrentIntent.ok);
  assert.equal(
    beforeCurrentIntent.value.find((row) => row.id === DEAL_ID)?.currentPaymentIntentState,
    null,
    "a stale intent must not be reported as the current funding state",
  );

  await prisma.paymentIntent.create({
    data: {
      dealId: DEAL_ID,
      termsVersionId: current.id,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      createdByUserId: BUYER_USER_ID,
      expectedAmountMinor: 60000,
      expectedCurrency: "USD",
      assetLabel: "sandbox-USDC",
      networkLabel: "simulated-network",
      providerKey: "mock-escrow-deterministic",
      environmentLabel: "sandbox",
      correlationId: "corr-dl-current",
      providerState: "Created",
    },
  });

  const afterCurrentIntent = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    makeListUseCase(),
  );
  assert.ok(afterCurrentIntent.ok);
  assert.equal(
    afterCurrentIntent.value.find((row) => row.id === DEAL_ID)?.currentPaymentIntentState,
    "Created",
  );
});

// ------------------------------------------------------------ authorization

test("a revoked member cannot read the Deal list — rejection and ZERO rows", async () => {
  // Prove the member can read first, so the revocation is the only
  // thing that changes.
  const authorized = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    makeListUseCase(),
  );
  assert.ok(authorized.ok);
  assert.ok(authorized.value.length > 0);

  // Revocation deletes the membership row (there is no revokedAt).
  await prisma.workspaceMembership.delete({
    where: {
      userId_workspaceId: {
        userId: BUYER_USER_ID,
        workspaceId: BUYER_WORKSPACE_ID,
      },
    },
  });

  try {
    const revoked = await repo.listDealsForWorkspaceInTransaction(
      {
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        actingUserAccountId: BUYER_USER_ID,
      },
      makeListUseCase(),
    );

    assert.equal(revoked.ok, false, "a revoked member must be rejected");
    assert.equal(revoked.ok === false ? revoked.reason : null, "DEAL_LIST_FORBIDDEN");
    // The rejection shape carries no rows at all: the private read
    // never runs on this path.
    assert.equal("value" in revoked, false, "a rejected read must return no Deal rows");
  } finally {
    await restoreBuyerMembership();
  }
});

test("a Suspended Workspace cannot read the Deal list", async () => {
  await setBuyerWorkspaceStatus("Suspended");
  try {
    const result = await repo.listDealsForWorkspaceInTransaction(
      {
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        actingUserAccountId: BUYER_USER_ID,
      },
      makeListUseCase(),
    );
    assert.equal(result.ok, false);
    assert.equal("value" in result, false);
  } finally {
    await setBuyerWorkspaceStatus("Active");
  }
});

test("a non-member of the commanded Workspace is rejected", async () => {
  const result = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: BUYER_WORKSPACE_ID,
      actingUserAccountId: OUTSIDER_USER_ID,
    },
    makeListUseCase(),
  );
  assert.equal(result.ok, false);
  assert.equal("value" in result, false);
});

test("an unknown acting Workspace is rejected", async () => {
  const result = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: "ws-does-not-exist",
      actingUserAccountId: BUYER_USER_ID,
    },
    makeListUseCase(),
  );
  assert.equal(result.ok, false);
});

test("an outsider acting for their OWN Workspace discovers no private Deals", async () => {
  // Authorized (they are a current member of an Active Workspace) but
  // a party to nothing: the scoped read must match zero rows.
  const result = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: OUTSIDER_WORKSPACE_ID,
      actingUserAccountId: OUTSIDER_USER_ID,
    },
    makeListUseCase(),
  );

  assert.ok(result.ok);
  assert.deepEqual(result.value, []);
});

test("membership in one Workspace does not grant reads of another", async () => {
  // The buyer is a member of the buyer Workspace only. Commanding the
  // seller Workspace must fail even though the buyer IS a party to
  // the Deals through their own side.
  const result = await repo.listDealsForWorkspaceInTransaction(
    {
      actingWorkspaceId: SELLER_WORKSPACE_ID,
      actingUserAccountId: BUYER_USER_ID,
    },
    makeListUseCase(),
  );
  assert.equal(result.ok, false);
  assert.equal("value" in result, false);
});
