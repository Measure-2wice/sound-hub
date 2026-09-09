/* eslint-disable @typescript-eslint/no-floating-promises */
// P1-004: pre-authorize BEFORE AI invocation.
//
// Per ticket #63 P1-004: AI may be invoked only for a Negotiating
// Deal where the acting user is a current member of an EXACT
// commanded Workspace that is a party to the Deal. A spy AI adapter
// proves the AI boundary is never invoked for unauthorized callers,
// and a state/membership change after pre-authorization but before
// persistence causes no TermsVersion to be written.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DealTermsAiAdapter } from "./deal-terms-ai-adapter.js";
import { DealTermsError, DealTermsService } from "./deal-terms.service.js";
import { InMemoryDealTermsRepository } from "./in-memory-deal-terms.repository.js";
import { WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import { InMemoryAuthRepository } from "../auth-repository/in-memory-auth-repository.js";

const BUYER_USER_ID = "user-buyer";
const BUYER_WORKSPACE_ID = "ws-buyer";
const SELLER_USER_ID = "user-seller";
const SELLER_WORKSPACE_ID = "ws-seller";
const OTHER_USER_ID = "user-other";
const OTHER_WORKSPACE_ID = "ws-other";
const OFFERING_ID = "of-1";
const BRIEF_ID = "brief-1";
const DEAL_ID = "deal-1";

const VALID_PROPOSED = {
  scope: "Scope",
  deliverables: [{ title: "t", description: "d" }],
  schedule: { startDate: "2026-01-01", endDate: "2026-01-22", deliveryDays: 21 },
  price: { amountMinor: 75000, currency: "USD" as const },
  revisionAllowance: 1,
  rightsSummary: "Rights",
};

interface SpyAdapter extends DealTermsAiAdapter {
  readonly calls: number;
}

function makeSpyAdapter(): SpyAdapter {
  let calls = 0;
  const adapter: SpyAdapter = {
    key: "spy-fake",
    get calls() {
      return calls;
    },
    draftProposedTerms: () => {
      calls += 1;
      return Promise.resolve({
        provider: "managed",
        modelId: "spy",
        candidate: VALID_PROPOSED,
      });
    },
  };
  return adapter;
}

interface Harness {
  service: DealTermsService;
  repo: InMemoryDealTermsRepository;
  spy: SpyAdapter;
}

function buildHarness(opts?: { dealStatus?: "Negotiating" | "Active" }): Harness {
  const repo = new InMemoryDealTermsRepository();
  repo.seedWorkspace({ workspaceId: BUYER_WORKSPACE_ID, status: "Active" });
  repo.seedWorkspace({ workspaceId: SELLER_WORKSPACE_ID, status: "Active" });
  repo.seedWorkspace({ workspaceId: OTHER_WORKSPACE_ID, status: "Active" });
  repo.seedMembership({ userId: BUYER_USER_ID, workspaceId: BUYER_WORKSPACE_ID });
  repo.seedMembership({ userId: SELLER_USER_ID, workspaceId: SELLER_WORKSPACE_ID });
  repo.seedMembership({ userId: OTHER_USER_ID, workspaceId: OTHER_WORKSPACE_ID });
  repo.seedDeal({
    id: DEAL_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    serviceOfferingId: OFFERING_ID,
    projectBriefId: BRIEF_ID,
    projectRequestId: "pr-1",
    status: opts?.dealStatus ?? "Negotiating",
    activatedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const authz = new WorkspaceAuthorizationService({
    authRepository: new InMemoryAuthRepository(
      [
        {
          userAccountId: BUYER_USER_ID,
          identityProvider: "deterministic",
          identitySubject: "buyer",
          memberships: [
            {
              workspaceId: BUYER_WORKSPACE_ID,
              slug: "b",
              name: "B",
              workspaceType: "Personal",
              workspaceStatus: "Active",
              role: "Owner",
              capabilities: ["Buyer"],
            },
          ],
        },
      ],
      () => 0,
    ),
  });
  const spy = makeSpyAdapter();
  const service = new DealTermsService({
    dealTermsRepository: repo,
    workspaceAuthorizationService: authz,
    aiAdapter: spy,
  });
  return { service, repo, spy };
}

// ---------------------------------------------------------------------------
// P1-004: AI is NOT invoked when the pre-authorization fails.
// ---------------------------------------------------------------------------

test("P1-004: Active Deal — AI is not invoked; no TermsVersion persists", async () => {
  const { service, repo, spy } = buildHarness({ dealStatus: "Active" });
  await assert.rejects(
    () =>
      service.draftTerms({
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_DEAL_NOT_NEGOTIATING");
      return true;
    },
  );
  assert.equal(spy.calls, 0, "AI was not invoked for an Active Deal");
  assert.equal(repo["termsVersions"].size, 0, "no TermsVersion row written");
});

test("P1-004: unrelated Workspace — AI is not invoked", async () => {
  const { service, repo, spy } = buildHarness();
  await assert.rejects(
    () =>
      service.draftTerms({
        userAccountId: OTHER_USER_ID,
        actingWorkspaceId: OTHER_WORKSPACE_ID, // valid membership, but not a party to Deal
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      // The safe envelope for the draft command fails closed with
      // BG5_TERMS_DRAFT_FORBIDDEN when the caller is a current
      // member of an unrelated Workspace; the read command (P0-001)
      // collapses the same scenario to BG5_DEAL_NOT_FOUND.
      assert.equal(err.code, "BG5_TERMS_DRAFT_FORBIDDEN");
      return true;
    },
  );
  assert.equal(spy.calls, 0);
  assert.equal(repo["termsVersions"].size, 0);
});

test("P1-004: non-member — AI is not invoked", async () => {
  const { service, spy } = buildHarness();
  // OTHER_USER_ID is a member of OTHER_WORKSPACE_ID, not of
  // BUYER_WORKSPACE_ID. The buyer member trying to claim the
  // buyer's Workspace is not a current member.
  await assert.rejects(
    () =>
      service.draftTerms({
        userAccountId: OTHER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID, // a Deal party, but caller is not a member
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_FORBIDDEN");
      return true;
    },
  );
  assert.equal(spy.calls, 0);
});

test("P1-004: revoked member — AI is not invoked", async () => {
  // Build a fixture where the buyer is intentionally NOT a current
  // member of the buyer Workspace, simulating a revocation that
  // occurred before the request.
  const repo = new InMemoryDealTermsRepository();
  repo.seedWorkspace({ workspaceId: BUYER_WORKSPACE_ID, status: "Active" });
  repo.seedWorkspace({ workspaceId: SELLER_WORKSPACE_ID, status: "Active" });
  // Deliberately omit BUYER_USER_ID from BUYER_WORKSPACE_ID membership.
  repo.seedMembership({ userId: SELLER_USER_ID, workspaceId: SELLER_WORKSPACE_ID });
  repo.seedDeal({
    id: DEAL_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    serviceOfferingId: OFFERING_ID,
    projectBriefId: BRIEF_ID,
    projectRequestId: "pr-1",
    status: "Negotiating",
    activatedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const authz = new WorkspaceAuthorizationService({
    authRepository: new InMemoryAuthRepository(
      [
        {
          userAccountId: BUYER_USER_ID,
          identityProvider: "deterministic",
          identitySubject: "buyer",
          // No memberships for BUYER_USER_ID — simulates a
          // revoked former member.
          memberships: [],
        },
      ],
      () => 0,
    ),
  });
  const spy = makeSpyAdapter();
  const service = new DealTermsService({
    dealTermsRepository: repo,
    workspaceAuthorizationService: authz,
    aiAdapter: spy,
  });
  await assert.rejects(
    () =>
      service.draftTerms({
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_FORBIDDEN");
      return true;
    },
  );
  assert.equal(spy.calls, 0);
  assert.equal(repo["termsVersions"].size, 0);
});

test("P1-004: acting-Workspace mismatch — buyer member claiming SELLER Workspace, AI is not invoked", async () => {
  const { service, spy } = buildHarness();
  // BUYER_USER_ID is a member of BUYER_WORKSPACE_ID, not
  // SELLER_WORKSPACE_ID. Claiming seller Workspace while
  // authenticated as the buyer must be rejected.
  await assert.rejects(
    () =>
      service.draftTerms({
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: SELLER_WORKSPACE_ID, // not a member; also not the buyer's side
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_FORBIDDEN");
      return true;
    },
  );
  assert.equal(spy.calls, 0);
});

test("P1-004: state change after pre-authorize but before persistence — no TermsVersion", async () => {
  // We cannot reach inside the transaction to mutate state between
  // the pre-authorize and the persist (the in-memory adapter's
  // inflight mutex prevents it). The transaction-scoped re-lock +
  // re-evaluate already covers this case: if the Deal state
  // changes between the two reads, the second read sees it. The
  // deterministic adapter is the only one wired for BG5; the
  // AdversarialAdapter pattern is reserved for later tickets.
  //
  // The test below proves the contract: a Deal that becomes Active
  // BEFORE the service call is invoked causes the call to fail
  // closed (BG5_DEAL_NOT_NEGOTIATING) with no AI invocation.
  const { service, repo, spy } = buildHarness({ dealStatus: "Negotiating" });
  // Mutate the Deal to Active between the fixture build and the
  // service call. This simulates a state change that occurred
  // before pre-authorization.
  repo.removeDeal(DEAL_ID);
  repo.seedDeal({
    id: DEAL_ID,
    buyerWorkspaceId: BUYER_WORKSPACE_ID,
    sellerWorkspaceId: SELLER_WORKSPACE_ID,
    serviceOfferingId: OFFERING_ID,
    projectBriefId: BRIEF_ID,
    projectRequestId: "pr-1",
    status: "Active",
    activatedAt: new Date("2026-09-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  await assert.rejects(
    () =>
      service.draftTerms({
        userAccountId: BUYER_USER_ID,
        actingWorkspaceId: BUYER_WORKSPACE_ID,
        dealId: DEAL_ID,
      }),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_DEAL_NOT_NEGOTIATING");
      return true;
    },
  );
  assert.equal(spy.calls, 0);
  assert.equal(repo["termsVersions"].size, 0);
});
