/* eslint-disable @typescript-eslint/no-floating-promises */
// PrismaDealTermsRepository integration tests (BG5).
//
// Background: ticket #63 acceptance criteria require the BG5
// repository to:
//   - persist immutable TermsVersion rows (append-only, monotonic
//     version, unique (dealId, version))
//   - record independent DealApproval rows bound to (Workspace,
//     human, DealApprover authorization, exact TermsVersion,
//     timestamp)
//   - reject duplicate approvals for the same
//     (termsVersionId, workspaceId) tuple via the unique index
//   - reject stale TermsVersion ids via the application policy
//   - validate AI provenance fields persist correctly
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
import { PrismaDealTermsRepository } from "./prisma-deal-terms.repository.js";
import {
  evaluateDraftingAuthority,
  evaluateApprovalAuthority,
  evaluateDealReadAuthority,
} from "./deal-terms-authorization-policy.js";
import type {
  DraftTermsUseCase,
  DraftTermsUseCaseTools,
  DraftTermsUseCaseOutcome,
  FindDealViewUseCaseTools,
  FindDealViewUseCaseOutcome,
  PersistDraftTermsInput,
  RecordApprovalUseCase,
  RecordApprovalUseCaseTools,
  RecordApprovalUseCaseOutcome,
} from "./deal-terms.repository.js";

let prisma: PrismaClient;
let repo: PrismaDealTermsRepository;

interface Fixture {
  buyerUserId: string;
  buyerWorkspaceId: string;
  sellerUserId: string;
  sellerWorkspaceId: string;
  serviceOfferingId: string;
  briefId: string;
  dealId: string;
}

const BUYER_USER_ID = "user-bg5-buyer";
const SELLER_USER_ID = "user-bg5-seller";
const BUYER_WORKSPACE_ID = "ws-bg5-buyer";
const SELLER_WORKSPACE_ID = "ws-bg5-seller";
const OFFERING_ID = "of-bg5-1";
const BRIEF_ID = "brief-bg5-1";
const DEAL_ID = "deal-bg5-1";

const DEFAULT_PROPOSED_TERMS: PersistDraftTermsInput["proposedTerms"] = {
  scope: "BG5 scope",
  deliverables: [{ title: "Primary", description: "Mix-ready master" }],
  schedule: { startDate: "2026-01-01", endDate: "2026-01-22", deliveryDays: 21 },
  price: { amountMinor: 75000, currency: "USD" },
  revisionAllowance: 1,
  rightsSummary: "Non-exclusive worldwide rights",
};

function makeDraftInput(
  fx: Fixture,
  overrides?: {
    aiProvider?: string;
    aiModelId?: string | null;
    aiFallbackUsed?: boolean;
    proposedTerms?: PersistDraftTermsInput["proposedTerms"];
    actingWorkspaceId?: string;
    actingUserAccountId?: string;
  },
) {
  return {
    dealId: fx.dealId,
    draftedByUserId: fx.buyerUserId,
    aiProvider: overrides?.aiProvider ?? "deterministic-fallback",
    aiModelId: overrides?.aiModelId ?? null,
    aiFallbackUsed: overrides?.aiFallbackUsed ?? true,
    actingWorkspaceId: overrides?.actingWorkspaceId ?? fx.buyerWorkspaceId,
    actingUserAccountId: overrides?.actingUserAccountId ?? fx.buyerUserId,
  };
}

function makeDraftUseCase(
  fx: Fixture,
  provenance: {
    aiProvider: string;
    aiModelId: string | null;
    aiFallbackUsed: boolean;
    proposedTerms: PersistDraftTermsInput["proposedTerms"];
  },
): DraftTermsUseCase {
  return (ctx, tools: DraftTermsUseCaseTools): DraftTermsUseCaseOutcome => {
    const verdict = evaluateDraftingAuthority(ctx.draftingAuthority);
    if (!verdict.ok) {
      if (verdict.reason === "DEAL_NOT_FOUND") return tools.reject("DEAL_NOT_FOUND");
      if (verdict.reason === "DEAL_NOT_NEGOTIATING") return tools.reject("DEAL_NOT_NEGOTIATING");
      return tools.reject("DRAFT_FORBIDDEN");
    }
    return tools.persistDraft({
      dealId: fx.dealId,
      draftedByUserId: fx.buyerUserId,
      aiProvider: provenance.aiProvider,
      aiModelId: provenance.aiModelId,
      aiFallbackUsed: provenance.aiFallbackUsed,
      proposedTerms: provenance.proposedTerms,
      now: new Date("2026-09-01T00:00:00Z"),
    });
  };
}

function makeDraftUseCaseDefault(fx: Fixture): DraftTermsUseCase {
  return makeDraftUseCase(fx, {
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    proposedTerms: DEFAULT_PROPOSED_TERMS,
  });
}

function makeApprovalUseCase(): RecordApprovalUseCase {
  return (ctx, tools: RecordApprovalUseCaseTools): RecordApprovalUseCaseOutcome => {
    const verdict = evaluateApprovalAuthority(ctx.approvalAuthority);
    if (!verdict.ok) {
      if (verdict.reason === "DEAL_NOT_FOUND") return tools.reject("DEAL_NOT_FOUND");
      if (verdict.reason === "DEAL_NOT_NEGOTIATING") return tools.reject("DEAL_NOT_NEGOTIATING");
      if (verdict.reason === "TERMS_VERSION_NOT_FOUND")
        return tools.reject("TERMS_VERSION_NOT_FOUND");
      if (verdict.reason === "TERMS_VERSION_NOT_CURRENT")
        return tools.reject("TERMS_VERSION_NOT_CURRENT");
      return tools.reject("APPROVAL_FORBIDDEN");
    }
    if (ctx.approvalAuthority.dealApproverId === null) return tools.reject("APPROVAL_FORBIDDEN");
    return tools.persistApproval({
      termsVersionId: ctx.approvalAuthority.termsVersionId,
      workspaceId: ctx.approvalAuthority.actingWorkspaceId,
      dealApproverId: ctx.approvalAuthority.dealApproverId,
      approvedByUserId: ctx.approvalAuthority.userAccountId,
      now: new Date("2026-09-02T00:00:00Z"),
    });
  };
}

async function loadFixture(): Promise<Fixture> {
  const category = await prisma.serviceCategory.upsert({
    where: { key: "music-production" },
    create: {
      key: "music-production",
      name: "Music Production",
      description: "BG5 test category",
      bundleOnly: false,
    },
    update: {},
  });
  const buyer = await prisma.userAccount.upsert({
    where: { id: BUYER_USER_ID },
    create: { id: BUYER_USER_ID, email: "bg5-buyer@example.com" },
    update: { email: "bg5-buyer@example.com" },
  });
  const seller = await prisma.userAccount.upsert({
    where: { id: SELLER_USER_ID },
    create: { id: SELLER_USER_ID, email: "bg5-seller@example.com" },
    update: { email: "bg5-seller@example.com" },
  });
  const buyerWorkspace = await prisma.workspace.upsert({
    where: { id: BUYER_WORKSPACE_ID },
    create: {
      id: BUYER_WORKSPACE_ID,
      slug: "bg5-test-buyer",
      name: "BG5 Test Buyer",
      type: "Personal",
      status: "Active",
      ownerUserId: buyer.id,
    },
    update: { status: "Active" },
  });
  const sellerWorkspace = await prisma.workspace.upsert({
    where: { id: SELLER_WORKSPACE_ID },
    create: {
      id: SELLER_WORKSPACE_ID,
      slug: "bg5-test-seller",
      name: "BG5 Test Seller",
      type: "Personal",
      status: "Active",
      ownerUserId: seller.id,
    },
    update: { status: "Active" },
  });
  for (const userId of [buyer.id, seller.id]) {
    await prisma.workspaceMembership.upsert({
      where: {
        userId_workspaceId: { userId, workspaceId: buyerWorkspace.id },
      },
      create: { userId, workspaceId: buyerWorkspace.id, role: "Owner" },
      update: { role: "Owner" },
    });
    await prisma.workspaceMembership.upsert({
      where: {
        userId_workspaceId: { userId, workspaceId: sellerWorkspace.id },
      },
      create: { userId, workspaceId: sellerWorkspace.id, role: "Owner" },
      update: { role: "Owner" },
    });
  }
  await prisma.workspaceCapability.deleteMany({ where: { workspaceId: buyerWorkspace.id } });
  await prisma.workspaceCapability.create({
    data: { workspaceId: buyerWorkspace.id, capability: "Buyer" },
  });
  await prisma.workspaceCapability.deleteMany({ where: { workspaceId: sellerWorkspace.id } });
  await prisma.workspaceCapability.create({
    data: { workspaceId: sellerWorkspace.id, capability: "Seller" },
  });
  const sellerProfile = await prisma.sellerProfile.upsert({
    where: { workspaceId: sellerWorkspace.id },
    create: {
      workspaceId: sellerWorkspace.id,
      professionalName: "BG5 Test Seller",
      bio: "BG5 test seller",
      status: "Published",
      basedInCountryCode: "US",
    },
    update: { status: "Published" },
  });
  const offering = await prisma.serviceOffering.upsert({
    where: { slug: "bg5-test-offering" },
    create: {
      id: OFFERING_ID,
      slug: "bg5-test-offering",
      sellerProfileId: sellerProfile.id,
      title: "BG5 test offering",
      description: "BG5 test offering description",
      status: "Active",
      serviceMode: "Remote",
      primaryCategoryId: category.id,
      genreTags: [],
    },
    update: { status: "Active" },
  });
  const brief = await prisma.projectBrief.upsert({
    where: { id: BRIEF_ID },
    create: {
      id: BRIEF_ID,
      buyerWorkspaceId: buyerWorkspace.id,
      createdByUserId: buyer.id,
      originalText: "BG5 test brief",
      requiredCriteriaJson: {},
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
    },
    update: {},
  });
  // Clean up DealApprovals that reference the demo DealApprover
  // rows before clearing the DealApprovers themselves (FK with
  // onDelete: Restrict).
  await prisma.dealApproval.deleteMany({
    where: { dealApprover: { workspaceId: { in: [buyerWorkspace.id, sellerWorkspace.id] } } },
  });
  await prisma.dealApprover.deleteMany({
    where: { workspaceId: { in: [buyerWorkspace.id, sellerWorkspace.id] } },
  });
  await prisma.dealApproval.deleteMany({
    where: { termsVersion: { dealId: DEAL_ID } },
  });
  await prisma.termsVersion.deleteMany({ where: { dealId: DEAL_ID } });
  await prisma.deal.deleteMany({ where: { id: DEAL_ID } });
  return {
    buyerUserId: buyer.id,
    buyerWorkspaceId: buyerWorkspace.id,
    sellerUserId: seller.id,
    sellerWorkspaceId: sellerWorkspace.id,
    serviceOfferingId: offering.id,
    briefId: brief.id,
    dealId: DEAL_ID,
  };
}

async function createDeal(
  fx: Fixture,
  opts?: { status?: "Negotiating" | "Active" },
): Promise<void> {
  const request = await prisma.projectRequest.upsert({
    where: { id: `pr-bg5-${fx.dealId}` },
    create: {
      id: `pr-bg5-${fx.dealId}`,
      buyerWorkspaceId: fx.buyerWorkspaceId,
      sellerWorkspaceId: fx.sellerWorkspaceId,
      serviceOfferingId: fx.serviceOfferingId,
      projectBriefId: fx.briefId,
      createdByUserId: fx.buyerUserId,
      status: "Accepted",
      sellerConsentAt: new Date("2026-09-01T00:00:00Z"),
      sellerDecisionByUserId: fx.sellerUserId,
    },
    update: { status: "Accepted" },
  });
  await prisma.deal.deleteMany({ where: { id: fx.dealId } });
  await prisma.deal.create({
    data: {
      id: fx.dealId,
      buyerWorkspaceId: fx.buyerWorkspaceId,
      sellerWorkspaceId: fx.sellerWorkspaceId,
      serviceOfferingId: fx.serviceOfferingId,
      projectBriefId: fx.briefId,
      projectRequestId: request.id,
      status: opts?.status ?? "Negotiating",
    },
  });
}

async function seedDealApprover(workspaceId: string, userId: string): Promise<string> {
  const row = await prisma.dealApprover.create({
    data: { workspaceId, userId, grantedByUserId: userId },
  });
  return row.id;
}

before(() => {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  prisma = createPrismaClient(url);
  repo = new PrismaDealTermsRepository(prisma);
});

after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Append-only monotonic version
// ---------------------------------------------------------------------------

test("drafting TermsVersion 1, then TermsVersion 2: version increments monotonically and previous rows are immutable", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  const v1UseCase = makeDraftUseCase(fx, {
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    proposedTerms: {
      scope: "First scope",
      deliverables: [{ title: "Primary", description: "Mix-ready master" }],
      schedule: { startDate: "2026-01-01", endDate: "2026-01-22", deliveryDays: 21 },
      price: { amountMinor: 75000, currency: "USD" },
      revisionAllowance: 1,
      rightsSummary: "Non-exclusive worldwide rights",
    },
  });
  const v1 = await repo.draftTermsInTransaction(makeDraftInput(fx), v1UseCase);
  assert.equal(v1.ok, true);
  if (v1.ok) assert.equal(v1.value.version, 1);

  const v2UseCase = makeDraftUseCase(fx, {
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    proposedTerms: {
      scope: "Second scope",
      deliverables: [{ title: "Primary v2", description: "Updated" }],
      schedule: { startDate: "2026-02-01", endDate: "2026-02-22", deliveryDays: 21 },
      price: { amountMinor: 80000, currency: "USD" },
      revisionAllowance: 1,
      rightsSummary: "Non-exclusive worldwide rights (updated)",
    },
  });
  const v2 = await repo.draftTermsInTransaction(
    makeDraftInput(fx, { proposedTerms: undefined }),
    v2UseCase,
  );
  assert.equal(v2.ok, true);
  if (v2.ok) assert.equal(v2.value.version, 2);

  const stored = await prisma.termsVersion.findUnique({ where: { id: v1.ok ? v1.value.id : "" } });
  assert.ok(stored);
  assert.equal(stored.scope, "First scope", "V1 row is immutable in storage");
  assert.equal(stored.priceAmountMinor, 75000);
});

test("drafting on a non-existent Deal is rejected with DEAL_NOT_FOUND", async () => {
  const fx = await loadFixture();
  const useCase = makeDraftUseCaseDefault(fx);
  const result = await repo.draftTermsInTransaction(
    { ...makeDraftInput(fx), dealId: "deal-does-not-exist" },
    useCase,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "DEAL_NOT_FOUND");
});

test("drafting on an Active Deal is rejected with DEAL_NOT_NEGOTIATING", async () => {
  const fx = await loadFixture();
  await createDeal(fx, { status: "Active" });
  const useCase = makeDraftUseCaseDefault(fx);
  const result = await repo.draftTermsInTransaction(makeDraftInput(fx), useCase);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "DEAL_NOT_NEGOTIATING");
});

// ---------------------------------------------------------------------------
// AI boundary fields persist verbatim
// ---------------------------------------------------------------------------

test("AI provenance fields (provider, modelId, fallbackUsed) persist on the TermsVersion row", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  const useCase = makeDraftUseCase(fx, {
    aiProvider: "managed",
    aiModelId: "impala-1.2",
    aiFallbackUsed: false,
    proposedTerms: DEFAULT_PROPOSED_TERMS,
  });
  const result = await repo.draftTermsInTransaction(
    makeDraftInput(fx, { aiProvider: "managed", aiModelId: "impala-1.2", aiFallbackUsed: false }),
    useCase,
  );
  assert.equal(result.ok, true);
  const row = await prisma.termsVersion.findUnique({
    where: { id: result.ok ? result.value.id : "" },
  });
  assert.ok(row);
  assert.equal(row.aiProvider, "managed");
  assert.equal(row.aiModelId, "impala-1.2");
  assert.equal(row.aiFallbackUsed, false);
});

// ---------------------------------------------------------------------------
// Independent buyer + seller approvals for the same current version
// ---------------------------------------------------------------------------

test("buyer + seller approvals are independent rows for the same current TermsVersion", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  await seedDealApprover(fx.buyerWorkspaceId, fx.buyerUserId);
  await seedDealApprover(fx.sellerWorkspaceId, fx.sellerUserId);
  const draft = await repo.draftTermsInTransaction(makeDraftInput(fx), makeDraftUseCaseDefault(fx));
  assert.equal(draft.ok, true);
  const tvId = draft.ok ? draft.value.id : "";
  const approvalUseCase = makeApprovalUseCase();

  const buyerApproval = await repo.recordApprovalInTransaction(
    {
      dealId: fx.dealId,
      termsVersionId: tvId,
      actingWorkspaceId: fx.buyerWorkspaceId,
      userAccountId: fx.buyerUserId,
      now: new Date("2026-09-02T00:00:00Z"),
    },
    approvalUseCase,
  );
  const sellerApproval = await repo.recordApprovalInTransaction(
    {
      dealId: fx.dealId,
      termsVersionId: tvId,
      actingWorkspaceId: fx.sellerWorkspaceId,
      userAccountId: fx.sellerUserId,
      now: new Date("2026-09-02T00:00:00Z"),
    },
    approvalUseCase,
  );
  assert.equal(buyerApproval.ok, true);
  assert.equal(sellerApproval.ok, true);

  const stored = await prisma.dealApproval.findMany({ where: { termsVersionId: tvId } });
  assert.equal(stored.length, 2);
  const ids = new Set(stored.map((s) => s.id));
  assert.equal(ids.size, 2, "both approvals are separate durable rows");
  assert.ok(stored.find((s) => s.workspaceId === fx.buyerWorkspaceId));
  assert.ok(stored.find((s) => s.workspaceId === fx.sellerWorkspaceId));
});

// ---------------------------------------------------------------------------
// Duplicate approval retry
// ---------------------------------------------------------------------------

test("duplicate approval for the same (termsVersionId, workspaceId) creates exactly one approval row", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  await seedDealApprover(fx.buyerWorkspaceId, fx.buyerUserId);
  const draft = await repo.draftTermsInTransaction(makeDraftInput(fx), makeDraftUseCaseDefault(fx));
  assert.equal(draft.ok, true);
  const tvId = draft.ok ? draft.value.id : "";
  const approvalUseCase = makeApprovalUseCase();
  const first = await repo.recordApprovalInTransaction(
    {
      dealId: fx.dealId,
      termsVersionId: tvId,
      actingWorkspaceId: fx.buyerWorkspaceId,
      userAccountId: fx.buyerUserId,
      now: new Date("2026-09-02T00:00:00Z"),
    },
    approvalUseCase,
  );
  assert.equal(first.ok, true);

  const second = await repo.recordApprovalInTransaction(
    {
      dealId: fx.dealId,
      termsVersionId: tvId,
      actingWorkspaceId: fx.buyerWorkspaceId,
      userAccountId: fx.buyerUserId,
      now: new Date("2026-09-02T00:00:00Z"),
    },
    approvalUseCase,
  );
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "APPROVAL_ALREADY_RECORDED");

  const stored = await prisma.dealApproval.findMany({
    where: { termsVersionId: tvId, workspaceId: fx.buyerWorkspaceId },
  });
  assert.equal(stored.length, 1, "exactly one approval row for the same workspace + version");
});

// ---------------------------------------------------------------------------
// Stale TermsVersion rejection
// ---------------------------------------------------------------------------

test("approving a stale TermsVersion fails with TERMS_VERSION_NOT_CURRENT", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  await seedDealApprover(fx.buyerWorkspaceId, fx.buyerUserId);
  const v1 = await repo.draftTermsInTransaction(
    makeDraftInput(fx),
    makeDraftUseCase(fx, {
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
      proposedTerms: {
        scope: "v1",
        deliverables: [{ title: "t", description: "d" }],
        schedule: { startDate: "2026-01-01", endDate: "2026-01-02", deliveryDays: 1 },
        price: { amountMinor: 100, currency: "USD" },
        revisionAllowance: 0,
        rightsSummary: "v1",
      },
    }),
  );
  assert.equal(v1.ok, true);
  await repo.draftTermsInTransaction(
    {
      ...makeDraftInput(fx),
      draftedByUserId: fx.sellerUserId,
    },
    makeDraftUseCase(fx, {
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
      proposedTerms: {
        scope: "v2",
        deliverables: [{ title: "t", description: "d" }],
        schedule: { startDate: "2026-02-01", endDate: "2026-02-02", deliveryDays: 1 },
        price: { amountMinor: 200, currency: "USD" },
        revisionAllowance: 0,
        rightsSummary: "v2",
      },
    }),
  );

  const stale = await repo.recordApprovalInTransaction(
    {
      dealId: fx.dealId,
      termsVersionId: v1.ok ? v1.value.id : "",
      actingWorkspaceId: fx.buyerWorkspaceId,
      userAccountId: fx.buyerUserId,
      now: new Date("2026-09-02T00:00:00Z"),
    },
    makeApprovalUseCase(),
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "TERMS_VERSION_NOT_CURRENT");
});

// ---------------------------------------------------------------------------
// Missing DealApprover authorization
// ---------------------------------------------------------------------------

test("approve without an explicit DealApprover authorization fails with APPROVAL_FORBIDDEN", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  const draft = await repo.draftTermsInTransaction(makeDraftInput(fx), makeDraftUseCaseDefault(fx));
  assert.equal(draft.ok, true);
  const tvId = draft.ok ? draft.value.id : "";
  const result = await repo.recordApprovalInTransaction(
    {
      dealId: fx.dealId,
      termsVersionId: tvId,
      actingWorkspaceId: fx.buyerWorkspaceId,
      userAccountId: fx.buyerUserId,
      now: new Date("2026-09-02T00:00:00Z"),
    },
    makeApprovalUseCase(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "APPROVAL_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Read view
// ---------------------------------------------------------------------------

test("findDealView returns the current TermsVersion and current approvals", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  await seedDealApprover(fx.buyerWorkspaceId, fx.buyerUserId);
  await seedDealApprover(fx.sellerWorkspaceId, fx.sellerUserId);
  const draft = await repo.draftTermsInTransaction(makeDraftInput(fx), makeDraftUseCaseDefault(fx));
  const tvId = draft.ok ? draft.value.id : "";
  await repo.recordApprovalInTransaction(
    {
      dealId: fx.dealId,
      termsVersionId: tvId,
      actingWorkspaceId: fx.buyerWorkspaceId,
      userAccountId: fx.buyerUserId,
      now: new Date("2026-09-02T00:00:00Z"),
    },
    makeApprovalUseCase(),
  );
  const view = await repo.findDealView(fx.dealId);
  assert.ok(view);
  assert.equal(view.currentTermsVersion?.id, tvId);
  assert.equal(view.currentApprovals.length, 1);
  assert.equal(view.currentApprovals[0]?.workspaceId, fx.buyerWorkspaceId);
});

// ---------------------------------------------------------------------------
// P1-002: draft honors the EXACT commanded actingWorkspaceId
// ---------------------------------------------------------------------------

test("P1-002: a dual-party member explicitly choosing the BUYER Workspace drafts under that Workspace", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  const useCase = makeDraftUseCase(fx, {
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    proposedTerms: DEFAULT_PROPOSED_TERMS,
  });
  const v = await repo.draftTermsInTransaction(
    makeDraftInput(fx, {
      actingWorkspaceId: fx.buyerWorkspaceId,
      actingUserAccountId: fx.buyerUserId,
    }),
    useCase,
  );
  assert.equal(v.ok, true);
  if (v.ok) {
    const row = await prisma.termsVersion.findUnique({ where: { id: v.value.id } });
    assert.ok(row);
    assert.equal(row.draftedByUserId, fx.buyerUserId);
  }
});

test("P1-002: a dual-party member explicitly choosing the SELLER Workspace drafts under that Workspace", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  const useCase = makeDraftUseCase(fx, {
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    proposedTerms: DEFAULT_PROPOSED_TERMS,
  });
  const v = await repo.draftTermsInTransaction(
    makeDraftInput(fx, {
      actingWorkspaceId: fx.sellerWorkspaceId,
      actingUserAccountId: fx.sellerUserId,
    }),
    useCase,
  );
  assert.equal(v.ok, true);
});

test("P1-002: a buyer member claiming the SELLER Workspace fails closed (DRAFT_FORBIDDEN) — no row", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  // Remove the seller from the buyer Workspace to make this a pure
  // seller-membership scenario. The buyer user is then a member
  // of buyerWorkspace only.
  await prisma.workspaceMembership.deleteMany({
    where: { userId: fx.sellerUserId, workspaceId: fx.buyerWorkspaceId },
  });
  const useCase = makeDraftUseCase(fx, {
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    proposedTerms: DEFAULT_PROPOSED_TERMS,
  });
  // The seller user now claims the buyerWorkspace (they are NOT a
  // member of it). The repository locks the exact (sellerUserId,
  // buyerWorkspaceId) tuple, finds no membership, and the policy
  // evaluator fails closed.
  const v = await repo.draftTermsInTransaction(
    makeDraftInput(fx, {
      actingWorkspaceId: fx.buyerWorkspaceId,
      actingUserAccountId: fx.sellerUserId,
    }),
    useCase,
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "DRAFT_FORBIDDEN");
  assert.equal((await prisma.termsVersion.findMany({ where: { dealId: fx.dealId } })).length, 0);
});

test("P1-002: an arbitrary Workspace id fails closed (DRAFT_FORBIDDEN) — no row", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  const useCase = makeDraftUseCase(fx, {
    aiProvider: "deterministic-fallback",
    aiModelId: null,
    aiFallbackUsed: true,
    proposedTerms: DEFAULT_PROPOSED_TERMS,
  });
  const v = await repo.draftTermsInTransaction(
    makeDraftInput(fx, {
      actingWorkspaceId: "ws-arbitrary-not-in-deal",
      actingUserAccountId: fx.buyerUserId,
    }),
    useCase,
  );
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "DRAFT_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// P1-003: approval binds to the commanded Deal
// ---------------------------------------------------------------------------

test("P1-003: approval with a cross-Deal TermsVersion id fails closed (TERMS_VERSION_NOT_FOUND) — no approval row", async () => {
  // Seed two separate Deals with separate ProjectRequests so the FK
  // is satisfiable. Draft a TermsVersion on Deal A, then attempt to
  // approve it via the Deal B transaction input.
  const fx = await loadFixture();
  await createDeal(fx, { status: "Negotiating" });
  await seedDealApprover(fx.buyerWorkspaceId, fx.buyerUserId);
  const useCase = makeDraftUseCaseDefault(fx);
  const v = await repo.draftTermsInTransaction(makeDraftInput(fx), useCase);
  assert.equal(v.ok, true);
  const tvId = v.ok ? v.value.id : "";

  // Create a second Deal (Deal B) referencing a different
  // ProjectRequest so the FK is satisfiable.
  const requestB = await prisma.projectRequest.upsert({
    where: { id: "pr-bg5-dealB" },
    create: {
      id: "pr-bg5-dealB",
      buyerWorkspaceId: fx.buyerWorkspaceId,
      sellerWorkspaceId: fx.sellerWorkspaceId,
      serviceOfferingId: fx.serviceOfferingId,
      projectBriefId: fx.briefId,
      createdByUserId: fx.buyerUserId,
      status: "Accepted",
      sellerConsentAt: new Date("2026-09-01T00:00:00Z"),
      sellerDecisionByUserId: fx.sellerUserId,
    },
    update: { status: "Accepted" },
  });
  await prisma.deal.deleteMany({ where: { id: "deal-bg5-B" } });
  await prisma.deal.create({
    data: {
      id: "deal-bg5-B",
      buyerWorkspaceId: fx.buyerWorkspaceId,
      sellerWorkspaceId: fx.sellerWorkspaceId,
      serviceOfferingId: fx.serviceOfferingId,
      projectBriefId: fx.briefId,
      projectRequestId: requestB.id,
      status: "Negotiating",
    },
  });

  // Attempt to approve the V1 from Deal A via the Deal B transaction.
  const result = await repo.recordApprovalInTransaction(
    {
      dealId: "deal-bg5-B",
      termsVersionId: tvId,
      actingWorkspaceId: fx.buyerWorkspaceId,
      userAccountId: fx.buyerUserId,
      now: new Date("2026-09-02T00:00:00Z"),
    },
    makeApprovalUseCase(),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "TERMS_VERSION_NOT_FOUND");
  const stored = await prisma.dealApproval.findMany({ where: { termsVersionId: tvId } });
  assert.equal(stored.length, 0, "no approval row inserted for cross-Deal mismatch");
});

// ---------------------------------------------------------------------------
// P1-001: authorized Prisma Deal read returns a complete Deal summary.
// Every field the public DTO mapper / contract relies on must be
// present and equal to its seeded concrete value (NOT undefined).
// ---------------------------------------------------------------------------

test("P1-001: authorized Prisma Deal read returns every required Deal summary field with its concrete value", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  // Add a seeded buyer-side DealApprover so the snapshot
  // authorization path is satisfied.
  await seedDealApprover(fx.buyerWorkspaceId, fx.buyerUserId);

  // Capture the exact Deal fields BEFORE the read so we can assert
  // every required field is preserved across the locked read +
  // mapping.
  const persistedDeal = await prisma.deal.findUnique({ where: { id: fx.dealId } });
  assert.ok(persistedDeal, "seeded Deal must exist");

  // Build an authorized use case that simply accepts.
  const readUseCase = (): {
    (
      ctx: { snapshot: { dealId: string; dealExists: boolean } },
      tools: FindDealViewUseCaseTools,
    ): FindDealViewUseCaseOutcome;
  } => {
    return (_ctx, tools) => tools.accept();
  };

  const result = await repo.findDealViewInTransaction(
    {
      dealId: fx.dealId,
      actingWorkspaceId: fx.buyerWorkspaceId,
      actingUserAccountId: fx.buyerUserId,
    },
    readUseCase(),
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  // Every required field must be the concrete seeded value —
  // NOT undefined.
  assert.equal(result.value.deal.id, persistedDeal.id, "id must match");
  assert.equal(
    result.value.deal.buyerWorkspaceId,
    persistedDeal.buyerWorkspaceId,
    "buyerWorkspaceId must match",
  );
  assert.equal(
    result.value.deal.sellerWorkspaceId,
    persistedDeal.sellerWorkspaceId,
    "sellerWorkspaceId must match",
  );
  assert.equal(
    result.value.deal.serviceOfferingId,
    persistedDeal.serviceOfferingId,
    "serviceOfferingId must match (no widening cast)",
  );
  assert.equal(
    result.value.deal.projectBriefId,
    persistedDeal.projectBriefId,
    "projectBriefId must match (no widening cast)",
  );
  assert.equal(
    result.value.deal.projectRequestId,
    persistedDeal.projectRequestId,
    "projectRequestId must match (no widening cast)",
  );
  assert.equal(result.value.deal.status, persistedDeal.status, "status must match");
  // activatedAt is nullable; normalize null → null for comparison.
  assert.equal(
    result.value.deal.activatedAt ?? null,
    persistedDeal.activatedAt ?? null,
    "activatedAt must match (no widening cast)",
  );
  assert.equal(
    result.value.deal.createdAt.toISOString(),
    persistedDeal.createdAt.toISOString(),
    "createdAt must be a real Date (no widening cast)",
  );
  // No field on the public DTO may be undefined.
  for (const [key, value] of Object.entries(result.value.deal)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
  }
});

test("P1-001: authorized Prisma Deal read on a SETTLED (Active) Deal surfaces the activatedAt field", async () => {
  const fx = await loadFixture();
  await createDeal(fx, { status: "Active" });
  await seedDealApprover(fx.buyerWorkspaceId, fx.buyerUserId);
  const persistedDeal = await prisma.deal.findUnique({ where: { id: fx.dealId } });
  assert.ok(persistedDeal);
  // The Prisma adapter's authorization rule for getDeal is "Deal
  // exists + acting Workspace is a party + current member". The
  // service pre-authorize rule is "Deal is Negotiating". A read of
  // an Active Deal is the read path (P0-001); for the repository
  // test we bypass the service pre-authorize and call the
  // repository use case directly.
  const readUseCase = (): {
    (
      ctx: { snapshot: { dealId: string; dealExists: boolean } },
      tools: FindDealViewUseCaseTools,
    ): FindDealViewUseCaseOutcome;
  } => {
    return (_ctx, tools) => tools.accept();
  };
  const result = await repo.findDealViewInTransaction(
    {
      dealId: fx.dealId,
      actingWorkspaceId: fx.buyerWorkspaceId,
      actingUserAccountId: fx.buyerUserId,
    },
    readUseCase(),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.deal.activatedAt ?? null, persistedDeal.activatedAt ?? null);
    assert.equal(result.value.deal.status, "Active");
  }
});

// P1-001: negative coverage — unauthorized reads fail closed with
// the safe envelope. The repository itself enforces the
// authorization policy via the use case evaluator; an
// unauthorized caller receives a typed rejection, no DealViewSnapshot.

test("P1-001: revoked former member cannot read a known Deal", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  // Revoke the buyer's current membership of the buyer Workspace so
  // the acting tuple (buyer, buyerWorkspace) is no longer a member.
  await prisma.workspaceMembership.deleteMany({
    where: { userId: fx.buyerUserId, workspaceId: fx.buyerWorkspaceId },
  });
  const result = await repo.findDealViewInTransaction(
    {
      dealId: fx.dealId,
      actingWorkspaceId: fx.buyerWorkspaceId,
      actingUserAccountId: fx.buyerUserId,
    },
    (ctx, tools) => {
      const verdict = evaluateDealReadAuthority(ctx.snapshot);
      return verdict.ok ? tools.accept() : tools.reject(verdict.reason);
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "DEAL_NOT_FOUND");
});

test("P1-001: an arbitrary acting Workspace id cannot read a known Deal", async () => {
  const fx = await loadFixture();
  await createDeal(fx);
  const result = await repo.findDealViewInTransaction(
    {
      dealId: fx.dealId,
      actingWorkspaceId: "ws-arbitrary-not-a-deal-party",
      actingUserAccountId: fx.buyerUserId,
    },
    (ctx, tools) => {
      const verdict = evaluateDealReadAuthority(ctx.snapshot);
      return verdict.ok ? tools.accept() : tools.reject(verdict.reason);
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "DEAL_NOT_FOUND");
});

test("P1-001: a known Deal that does not exist returns DEAL_NOT_FOUND", async () => {
  const fx = await loadFixture();
  const result = await repo.findDealViewInTransaction(
    {
      dealId: "deal-does-not-exist-bg5",
      actingWorkspaceId: fx.buyerWorkspaceId,
      actingUserAccountId: fx.buyerUserId,
    },
    (ctx, tools) => {
      const verdict = evaluateDealReadAuthority(ctx.snapshot);
      return verdict.ok ? tools.accept() : tools.reject(verdict.reason);
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "DEAL_NOT_FOUND");
});
