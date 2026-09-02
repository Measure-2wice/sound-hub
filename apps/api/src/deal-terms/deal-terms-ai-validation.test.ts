/* eslint-disable @typescript-eslint/no-floating-promises */
// P1-001 strict AI runtime validation tests (BG5).
//
// Per ticket #63 P1-001: AI output must cross the strict
// `bg5ProposedTermsV1Schema` runtime boundary. A missing, unknown,
// or wrong-type field rejects the candidate; the application
// surface the typed `BG5_TERMS_DRAFT_INVALID` envelope; no
// TermsVersion may be persisted.
//
// These tests use a fake AI adapter that returns a controlled
// candidate shape; the application service is the only authority
// deciding whether persistence happens. No source-pattern
// assertions, no JSDOM, no production-repository hooks.

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
const OFFERING_ID = "of-1";
const BRIEF_ID = "brief-1";
const DEAL_ID = "deal-1";

const VALID_CANDIDATE = {
  scope: "Scope",
  deliverables: [{ title: "t", description: "d" }],
  schedule: { startDate: "2026-01-01", endDate: "2026-01-22", deliveryDays: 21 },
  price: { amountMinor: 75000, currency: "USD" },
  revisionAllowance: 1,
  rightsSummary: "Rights",
};

function makeFakeAdapter(candidate: unknown): DealTermsAiAdapter {
  return {
    key: "fake-managed",
    draftProposedTerms: () =>
      Promise.resolve({
        provider: "managed",
        modelId: "impala-1.2",
        candidate: (candidate ?? {}) as Record<string, unknown>,
      }),
  };
}

interface Harness {
  service: DealTermsService;
  repo: InMemoryDealTermsRepository;
}

function buildHarness(candidate: unknown): Harness {
  const repo = new InMemoryDealTermsRepository();
  repo.seedWorkspace({ workspaceId: BUYER_WORKSPACE_ID, status: "Active" });
  repo.seedWorkspace({ workspaceId: SELLER_WORKSPACE_ID, status: "Active" });
  repo.seedMembership({ userId: BUYER_USER_ID, workspaceId: BUYER_WORKSPACE_ID });
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
  const service = new DealTermsService({
    dealTermsRepository: repo,
    workspaceAuthorizationService: authz,
    aiAdapter: makeFakeAdapter(candidate),
  });
  return { service, repo };
}

const draftInput = {
  userAccountId: BUYER_USER_ID,
  actingWorkspaceId: BUYER_WORKSPACE_ID,
  dealId: DEAL_ID,
};

// ---------------------------------------------------------------------------
// P1-001: each malformed shape fails the application boundary with the
// typed BG5 envelope; no TermsVersion row is persisted.
// ---------------------------------------------------------------------------

test("missing required field (scope) → BG5_TERMS_DRAFT_INVALID, no row", async () => {
  const { service, repo } = buildHarness({
    deliverables: VALID_CANDIDATE.deliverables,
    schedule: VALID_CANDIDATE.schedule,
    price: VALID_CANDIDATE.price,
    revisionAllowance: VALID_CANDIDATE.revisionAllowance,
    rightsSummary: VALID_CANDIDATE.rightsSummary,
  });
  await assert.rejects(
    () => service.draftTerms(draftInput),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_INVALID");
      return true;
    },
  );
  assert.equal(repo["termsVersions"].size, 0, "no TermsVersion row was persisted");
});

test("unknown field → strict .strict() rejects, no row", async () => {
  const { service, repo } = buildHarness({
    ...VALID_CANDIDATE,
    rogueField: "ignored-by-strict-schema",
  });
  await assert.rejects(
    () => service.draftTerms(draftInput),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_INVALID");
      return true;
    },
  );
  assert.equal(repo["termsVersions"].size, 0);
});

test("empty deliverables → BG5_TERMS_DRAFT_INVALID, no row", async () => {
  const { service, repo } = buildHarness({
    ...VALID_CANDIDATE,
    deliverables: [],
  });
  await assert.rejects(
    () => service.draftTerms(draftInput),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_INVALID");
      return true;
    },
  );
  assert.equal(repo["termsVersions"].size, 0);
});

test("invalid schedule date → BG5_TERMS_DRAFT_INVALID, no row", async () => {
  const { service, repo } = buildHarness({
    ...VALID_CANDIDATE,
    schedule: { startDate: "not-a-date", endDate: "2026-01-22", deliveryDays: 21 },
  });
  await assert.rejects(
    () => service.draftTerms(draftInput),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_INVALID");
      return true;
    },
  );
  assert.equal(repo["termsVersions"].size, 0);
});

test("non-integer amountMinor → BG5_TERMS_DRAFT_INVALID, no row", async () => {
  const { service, repo } = buildHarness({
    ...VALID_CANDIDATE,
    price: { amountMinor: 75.5, currency: "USD" },
  });
  await assert.rejects(
    () => service.draftTerms(draftInput),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_INVALID");
      return true;
    },
  );
  assert.equal(repo["termsVersions"].size, 0);
});

test("non-integer revisionAllowance → BG5_TERMS_DRAFT_INVALID, no row", async () => {
  const { service, repo } = buildHarness({
    ...VALID_CANDIDATE,
    revisionAllowance: 1.5,
  });
  await assert.rejects(
    () => service.draftTerms(draftInput),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_INVALID");
      return true;
    },
  );
  assert.equal(repo["termsVersions"].size, 0);
});

test("non-USD currency → BG5_TERMS_DRAFT_INVALID, no row", async () => {
  const { service, repo } = buildHarness({
    ...VALID_CANDIDATE,
    price: { amountMinor: 75000, currency: "EUR" },
  });
  await assert.rejects(
    () => service.draftTerms(draftInput),
    (err: unknown) => {
      assert.ok(err instanceof DealTermsError);
      assert.equal(err.code, "BG5_TERMS_DRAFT_INVALID");
      return true;
    },
  );
  assert.equal(repo["termsVersions"].size, 0);
});

test("a valid candidate still persists; sanity check the harness", async () => {
  const { service, repo } = buildHarness(VALID_CANDIDATE);
  const result = await service.draftTerms(draftInput);
  assert.equal(result.termsVersion.version, 1);
  assert.equal(repo["termsVersions"].size, 1);
});
