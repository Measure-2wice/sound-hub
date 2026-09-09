/* eslint-disable @typescript-eslint/no-floating-promises */
// DealListService unit tests (ticket #74).
//
// Background: ticket #74 acceptance criteria require the service to:
//   - let a buyer discover Deals belonging to their buyer Workspace
//   - let a seller discover Deals belonging to their seller Workspace
//   - show a multi-Workspace user only the SELECTED acting Workspace's
//     Deals
//   - fail closed when membership is revoked
//   - keep unrelated Workspaces from discovering private Deals
//   - emit human-readable labels rather than raw internal ids
//
// The in-memory repository runs the SAME authorization policy as the
// Prisma adapter, so these tests exercise real authorization rather
// than a permissive fake. The locked-transaction behavior itself is
// proven by the disposable-PostgreSQL repository test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dealListItemPublicV1Schema } from "@soundhub/types";
import { DealListService, DealListError } from "./deal-list.service.js";
import {
  InMemoryDealListRepository,
  type InMemoryDealListState,
} from "./in-memory-deal-list.repository.js";

const BUYER_USER_ID = "user-buyer";
const BUYER_WORKSPACE_ID = "ws-buyer";
const SELLER_USER_ID = "user-seller";
const SELLER_WORKSPACE_ID = "ws-seller";
const OTHER_USER_ID = "user-other";
const OTHER_WORKSPACE_ID = "ws-other";

const DEAL_ID = "deal-1";
const OTHER_DEAL_ID = "deal-other";

const BUYER_WORKSPACE_NAME = "Kingston Records";
const SELLER_WORKSPACE_NAME = "Blue Mountain Studio";
const OFFERING_TITLE = "Mixing & Mastering — Full Track";

function baseState(overrides: Partial<InMemoryDealListState> = {}): InMemoryDealListState {
  return {
    workspaces: [
      { id: BUYER_WORKSPACE_ID, name: BUYER_WORKSPACE_NAME, status: "Active" },
      { id: SELLER_WORKSPACE_ID, name: SELLER_WORKSPACE_NAME, status: "Active" },
      { id: OTHER_WORKSPACE_ID, name: "Unrelated Collective", status: "Active" },
    ],
    memberships: [
      { userId: BUYER_USER_ID, workspaceId: BUYER_WORKSPACE_ID },
      { userId: SELLER_USER_ID, workspaceId: SELLER_WORKSPACE_ID },
      { userId: OTHER_USER_ID, workspaceId: OTHER_WORKSPACE_ID },
    ],
    deals: [
      {
        id: DEAL_ID,
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        status: "Negotiating",
        activatedAt: null,
        createdAt: new Date("2026-02-01T10:00:00.000Z"),
        serviceOfferingTitle: OFFERING_TITLE,
        currentTermsVersionId: "tv-1",
        currentTermsVersionNumber: 1,
        currentApprovalWorkspaceIds: [],
        currentPaymentIntentState: null,
      },
    ],
    ...overrides,
  };
}

function buildService(state: InMemoryDealListState = baseState()): {
  service: DealListService;
  repo: InMemoryDealListRepository;
} {
  const repo = new InMemoryDealListRepository(state);
  return { service: new DealListService({ repository: repo }), repo };
}

async function expectForbidden(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (err: unknown) => err instanceof DealListError && err.code === "DEAL_LIST_FORBIDDEN",
    "expected a DEAL_LIST_FORBIDDEN rejection",
  );
}

// -------------------------------------------------------------- discovery

test("a buyer discovers Deals belonging to their buyer Workspace", async () => {
  const { service } = buildService();
  const result = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
  });

  assert.equal(result.deals.length, 1);
  const [deal] = result.deals;
  assert.equal(deal?.dealId, DEAL_ID);
  assert.equal(deal?.actingSide, "Buyer");
  // The buyer sees the SELLER as the counterparty.
  assert.equal(deal?.counterpartyWorkspaceName, SELLER_WORKSPACE_NAME);
});

test("a seller discovers Deals belonging to their seller Workspace", async () => {
  const { service } = buildService();
  const result = await service.listDeals({
    userAccountId: SELLER_USER_ID,
    actingWorkspaceId: SELLER_WORKSPACE_ID,
  });

  assert.equal(result.deals.length, 1);
  const [deal] = result.deals;
  assert.equal(deal?.actingSide, "Seller");
  // The seller sees the BUYER as the counterparty.
  assert.equal(deal?.counterpartyWorkspaceName, BUYER_WORKSPACE_NAME);
});

test("rows carry human-readable labels rather than raw internal ids", async () => {
  const { service } = buildService();
  const result = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
  });

  const [deal] = result.deals;
  assert.equal(deal?.serviceOfferingTitle, OFFERING_TITLE);
  assert.equal(deal?.counterpartyWorkspaceName, SELLER_WORKSPACE_NAME);
});

test("the public item matches the shared contract and leaks no workspace ids", async () => {
  const { service } = buildService();
  const result = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
  });

  const [deal] = result.deals;
  assert.ok(deal);
  // `.strict()` rejects unknown keys, so this also proves no extra
  // field slipped through the mapper.
  dealListItemPublicV1Schema.parse(deal);

  const serialized = JSON.stringify(deal);
  for (const forbidden of [BUYER_WORKSPACE_ID, SELLER_WORKSPACE_ID, "tv-1"]) {
    assert.ok(!serialized.includes(forbidden), `public list item must not expose ${forbidden}`);
  }
});

test("deals are ordered newest first", async () => {
  const state = baseState();
  const { service } = buildService({
    ...state,
    deals: [
      ...state.deals,
      {
        id: "deal-newer",
        buyerWorkspaceId: BUYER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        status: "Negotiating",
        activatedAt: null,
        createdAt: new Date("2026-03-01T10:00:00.000Z"),
        serviceOfferingTitle: "Session Drums",
        currentTermsVersionId: null,
        currentTermsVersionNumber: null,
      },
    ],
  });

  const result = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
  });
  assert.deepEqual(
    result.deals.map((deal) => deal.dealId),
    ["deal-newer", DEAL_ID],
  );
});

// ---------------------------------------------------------- acting Workspace

test("a multi-Workspace user sees only the selected acting Workspace's Deals", async () => {
  const state = baseState();
  const { service } = buildService({
    ...state,
    // One human who is a current member of BOTH sides' Workspaces.
    memberships: [...state.memberships, { userId: BUYER_USER_ID, workspaceId: OTHER_WORKSPACE_ID }],
    deals: [
      ...state.deals,
      {
        id: OTHER_DEAL_ID,
        buyerWorkspaceId: OTHER_WORKSPACE_ID,
        sellerWorkspaceId: SELLER_WORKSPACE_ID,
        status: "Negotiating",
        activatedAt: null,
        createdAt: new Date("2026-02-05T10:00:00.000Z"),
        serviceOfferingTitle: "Vocal Tuning",
        currentTermsVersionId: null,
        currentTermsVersionNumber: null,
      },
    ],
  });

  const asBuyer = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
  });
  assert.deepEqual(
    asBuyer.deals.map((deal) => deal.dealId),
    [DEAL_ID],
    "acting as the buyer Workspace must not surface the other Workspace's Deal",
  );

  const asOther = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: OTHER_WORKSPACE_ID,
  });
  assert.deepEqual(
    asOther.deals.map((deal) => deal.dealId),
    [OTHER_DEAL_ID],
    "switching the acting Workspace must switch the visible Deals",
  );
});

// ------------------------------------------------------------ authorization

test("a revoked member cannot discover Deals — fails closed", async () => {
  const state = baseState();
  const { service, repo } = buildService(state);

  // Prove the member could read before revocation.
  const before = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
  });
  assert.equal(before.deals.length, 1);

  // Revocation deletes the membership row.
  repo.setState({
    ...state,
    memberships: state.memberships.filter((membership) => membership.userId !== BUYER_USER_ID),
  });

  await expectForbidden(
    service.listDeals({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
    }),
  );
});

test("a non-member cannot list another Workspace's Deals", async () => {
  const { service } = buildService();
  await expectForbidden(
    service.listDeals({
      userAccountId: OTHER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
    }),
  );
});

test("an unrelated Workspace's member discovers none of the private Deals", async () => {
  // Authorized for their OWN Workspace, but a party to nothing.
  const { service } = buildService();
  const result = await service.listDeals({
    userAccountId: OTHER_USER_ID,
    actingWorkspaceId: OTHER_WORKSPACE_ID,
  });
  assert.deepEqual(result.deals, []);
});

test("a Suspended Workspace cannot list Deals", async () => {
  const state = baseState();
  const { service } = buildService({
    ...state,
    workspaces: state.workspaces.map((workspace) =>
      workspace.id === BUYER_WORKSPACE_ID
        ? { ...workspace, status: "Suspended" as const }
        : workspace,
    ),
  });

  await expectForbidden(
    service.listDeals({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: BUYER_WORKSPACE_ID,
    }),
  );
});

test("an unknown acting Workspace is rejected indistinguishably", async () => {
  const { service } = buildService();
  await expectForbidden(
    service.listDeals({
      userAccountId: BUYER_USER_ID,
      actingWorkspaceId: "ws-does-not-exist",
    }),
  );
});

// -------------------------------------------------------------- derived state

test("derived approval and funding state reach the public item", async () => {
  const state = baseState();
  const { service } = buildService({
    ...state,
    deals: [
      {
        ...state.deals[0]!,
        status: "Active",
        activatedAt: new Date("2026-02-10T09:00:00.000Z"),
        currentApprovalWorkspaceIds: [BUYER_WORKSPACE_ID, SELLER_WORKSPACE_ID],
        currentPaymentIntentState: "Confirmed",
      },
    ],
  });

  const result = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
  });

  const [deal] = result.deals;
  assert.equal(deal?.approvalState, "BothApproved");
  assert.equal(deal?.fundingStatus, "Confirmed");
  assert.equal(deal?.status, "Active");
  assert.equal(deal?.activatedAt, "2026-02-10T09:00:00.000Z");
  assert.equal(deal?.currentTermsVersion, 1);
});

test("funding status is null while approvals are incomplete", async () => {
  const state = baseState();
  const { service } = buildService({
    ...state,
    deals: [
      {
        ...state.deals[0]!,
        currentApprovalWorkspaceIds: [BUYER_WORKSPACE_ID],
      },
    ],
  });

  const result = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
  });

  const [deal] = result.deals;
  assert.equal(deal?.approvalState, "AwaitingSellerApproval");
  assert.equal(deal?.fundingStatus, null);
});

test("a Deal with no drafted terms reports NoTerms and no funding", async () => {
  const state = baseState();
  const { service } = buildService({
    ...state,
    deals: [
      {
        ...state.deals[0]!,
        currentTermsVersionId: null,
        currentTermsVersionNumber: null,
      },
    ],
  });

  const result = await service.listDeals({
    userAccountId: BUYER_USER_ID,
    actingWorkspaceId: BUYER_WORKSPACE_ID,
  });

  const [deal] = result.deals;
  assert.equal(deal?.approvalState, "NoTerms");
  assert.equal(deal?.fundingStatus, null);
  assert.equal(deal?.currentTermsVersion, null);
});
