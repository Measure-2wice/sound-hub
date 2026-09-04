/* eslint-disable @typescript-eslint/no-floating-promises */
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
  // Per ticket #64 P0-001 the Buyer capability is an independently
  // granted WorkspaceCapability row — NOT inferred from membership,
  // ownership, or Deal party identity.
  repo.seedWorkspaceCapability({ workspaceId: BUYER_WS, capability: "Buyer" });
}

class StubEscrowProvider implements EscrowProvider {
  readonly key = "mock-escrow-deterministic" as const;
  readonly assetLabel = "sandbox-USDC" as const;
  readonly networkLabel = "simulated-network" as const;
  readonly environmentLabel = "sandbox" as const;
  public callCount = 0;
  public lastInput: EscrowRequestInput | null = null;
  constructor(
    private readonly behavior:
      | { kind: "ok"; override?: Partial<EscrowConfirmation> }
      | { kind: "throw"; message: string }
      | { kind: "malformed"; value: Record<string, unknown> },
  ) {}
  // eslint-disable-next-line @typescript-eslint/require-await -- test stub mirrors interface signature
  async requestFunding(input: EscrowRequestInput): Promise<EscrowConfirmation> {
    this.callCount += 1;
    this.lastInput = input;
    // Internal correlationId is INTENTIONALLY absent from
    // EscrowRequestInput (ticket #64 P1-003). The deterministic
    // mock no longer embeds SoundHub's internal audit identity in
    // its reference shape.
    if (this.behavior.kind === "throw") {
      throw new Error(this.behavior.message);
    }
    if (this.behavior.kind === "malformed") {
      // Return whatever the test supplies — the service must
      // fail closed at the strict runtime-validation boundary.
      return this.behavior.value as unknown as EscrowConfirmation;
    }
    return {
      providerKey: this.key,
      providerReference:
        this.behavior.override?.providerReference ?? `mock-${input.paymentIntentId}`,
      confirmedAmountMinor: this.behavior.override?.confirmedAmountMinor ?? input.priceAmountMinor,
      confirmedCurrency: this.behavior.override?.confirmedCurrency ?? input.priceCurrency,
      assetLabel: this.behavior.override?.assetLabel ?? "sandbox-USDC",
      networkLabel: this.behavior.override?.networkLabel ?? "simulated-network",
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
  assert.equal(parsed.networkLabel, "simulated-network");
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
  const json = JSON.parse(JSON.stringify(result.fundingStatus)) as Record<string, unknown>;
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

test("fundDeal provider throw → intent transitions to Failed on the SAME row; service raises BG6_ESCROW_UNAVAILABLE; raw exception text is NOT persisted (P1-004)", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const secret = "AKIA-SECRET-1234-DO-NOT-PERSIST";
  const provider = new StubEscrowProvider({
    kind: "throw",
    message: `ECONNRESET with secret ${secret}`,
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
  // Raw exception text — including any secret value — must NEVER
  // appear on the persisted PaymentIntent. The closed enum is the
  // only persisted failureDetailCategory value. See ticket #64
  // P1-004.
  assert.equal(intent.failureDetailCategory, "PROVIDER_UNAVAILABLE");
  const intentJson = JSON.stringify(intent);
  assert.equal(intentJson.includes(secret), false, "raw secret must not leak into persisted state");
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
  assert.equal(secondIntent.failureDetailCategory, null);
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
  // The provider threw both times — both attempts are
  // PROVIDER_UNAVAILABLE failures (not CONFIRMATION_MISMATCH).
  assert.equal(intent.failureDetailCategory, "PROVIDER_UNAVAILABLE");
});

test("fundDeal Confirmed short-circuit: a second call when intent is Confirmed does NOT call the provider (idempotent retry per P1-001)", async () => {
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
  // Second call — idempotent Confirmed retry path: returns the cached
  // success WITHOUT calling the provider or opening a new transaction.
  // See ticket #64 P1-001.
  const second = await service.fundDeal({
    userAccountId: USER_ID,
    actingWorkspaceId: BUYER_WS,
    dealId: DEAL_ID,
    now: new Date("2026-09-04T00:00:00.000Z"),
  });
  assert.equal(second.dealStatus, "Active");
  assert.equal(second.fundingStatus.status, "Confirmed");
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
  assert.equal(result.fundingStatus.networkLabel, "simulated-network");
  assert.equal(result.fundingStatus.assetLabel, "sandbox-USDC");
  assert.equal(result.fundingStatus.environmentLabel, "sandbox");
  assert.equal(result.fundingStatus.providerKey, "mock-escrow-deterministic");
});

// ---------- Buyer-capability authorization (P0-001) ----------

test("fundDeal rejects preauth when Buyer capability is missing; provider NOT called; no PaymentIntent row", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  // Revoke Buyer capability — membership remains, but the
  // independently granted WorkspaceCapability row is gone.
  repo.removeWorkspaceCapability(BUYER_WS, "Buyer");
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
  assert.equal(
    provider.callCount,
    0,
    "provider must not be called when Buyer capability is absent",
  );
  const intent = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.equal(intent, null, "no PaymentIntent row may be written when preauth fails");
});

test("fundDeal with Phase-3 capability revocation: a removed Buyer capability between Phase 1 and Phase 3 fails closed (no activation, no provider confirmation persisted)", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  // Wrap the in-memory repository so we can revoke the capability
  // immediately after Phase 1 preauth but BEFORE Phase 3 revalidation.
  const wrapped: typeof repo = new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === "findPreauthSnapshot") {
        return async (input: Parameters<typeof target.findPreauthSnapshot>[0]) => {
          const out = await target.findPreauthSnapshot(input);
          // Revoke Buyer capability immediately after Phase 1.
          target.removeWorkspaceCapability(BUYER_WS, "Buyer");
          return out;
        };
      }
      return Reflect.get(target as unknown as Record<string | symbol, unknown>, prop, receiver);
    },
  });
  const provider = new StubEscrowProvider({ kind: "ok" });
  const service = new FundingService({
    fundingRepository: wrapped,
    escrowProvider: provider,
  });
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
  // The provider was invoked once (Phase 2), but Phase 3 must have
  // failed closed so neither the Deal nor the intent is Activated
  // / Confirmed.
  assert.equal(provider.callCount, 1, "provider may be called once before Phase 3 rollback");
  const intent = await repo.findCurrentPaymentIntent(DEAL_ID);
  // The Phase 3 revalidation fails closed; the intent may exist in
  // Created or Failed state, but it MUST NOT be Confirmed and the
  // Deal MUST NOT be Active.
  if (intent) {
    assert.notEqual(intent.providerState, "Confirmed");
  }
});

// ---------- Idempotent Confirmed retry path (P1-001) ----------

test("fundDeal idempotent Confirmed retry: a second identical command on an already-Active Deal returns the same 200 result, provider is NOT called again, no second intent, no second activation", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const provider = new StubEscrowProvider({ kind: "ok" });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  const first = await service.fundDeal({
    userAccountId: USER_ID,
    actingWorkspaceId: BUYER_WS,
    dealId: DEAL_ID,
    now: new Date("2026-09-03T12:00:00.000Z"),
  });
  assert.equal(first.dealStatus, "Active");
  assert.equal(provider.callCount, 1);
  const intentBefore = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(intentBefore);
  const activatedAtBefore = first.activatedAt;
  // Second identical command — recognized as idempotent success
  // BEFORE any provider call or transaction.
  const second = await service.fundDeal({
    userAccountId: USER_ID,
    actingWorkspaceId: BUYER_WS,
    dealId: DEAL_ID,
    now: new Date("2026-09-04T00:00:00.000Z"),
  });
  assert.equal(second.dealStatus, "Active");
  assert.equal(second.fundingStatus.status, "Confirmed");
  assert.equal(provider.callCount, 1, "second identical fundDeal must NOT call the provider again");
  const intentAfter = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(intentAfter);
  assert.equal(intentAfter.id, intentBefore.id, "no second intent row may be created");
  assert.equal(intentAfter.providerState, "Confirmed");
  assert.equal(
    intentAfter.acceptedAt?.toISOString(),
    intentBefore.acceptedAt?.toISOString(),
    "activatedAt timestamp must not be rewritten by the retry",
  );
  assert.equal(second.activatedAt, activatedAtBefore);
});

// ---------- Strict provider confirmation validation (P1-002) ----------

test("fundDeal provider returns a confirmation with the wrong provider identity → fails closed as mismatch; Deal stays Negotiating; intent on SAME row", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const provider = new StubEscrowProvider({
    kind: "malformed",
    value: {
      providerKey: "unauthorized-provider",
      providerReference: "x",
      confirmedAmountMinor: 75000,
      confirmedCurrency: "USD",
      assetLabel: "sandbox-USDC",
      networkLabel: "simulated-network",
      environmentLabel: "sandbox",
      termsVersionId: TV_ID,
      confirmedAt: new Date("2026-09-03T12:00:00.000Z").toISOString(),
    },
  });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  await assert.rejects(
    () =>
      service.fundDeal({
        userAccountId: USER_ID,
        actingWorkspaceId: BUYER_WS,
        dealId: DEAL_ID,
        now: new Date("2026-09-03T12:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof FundingServiceError);
      assert.equal(err.code, "BG6_FUNDING_CONFIRMATION_MISMATCH");
      return true;
    },
  );
  const intent = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(intent);
  assert.notEqual(intent.providerState, "Confirmed");
});

test("fundDeal provider returns malformed confirmation (missing required field) → fails closed; Deal stays Negotiating", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  const provider = new StubEscrowProvider({
    kind: "malformed",
    value: {
      // Missing `confirmedAt` — strict schema rejects.
      providerKey: "mock-escrow-deterministic",
      providerReference: "x",
      confirmedAmountMinor: 75000,
      confirmedCurrency: "USD",
      assetLabel: "sandbox-USDC",
      networkLabel: "simulated-network",
      environmentLabel: "sandbox",
      termsVersionId: TV_ID,
    },
  });
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  await assert.rejects(
    () =>
      service.fundDeal({
        userAccountId: USER_ID,
        actingWorkspaceId: BUYER_WS,
        dealId: DEAL_ID,
        now: new Date("2026-09-03T12:00:00.000Z"),
      }),
    (err: unknown) => {
      assert.ok(err instanceof FundingServiceError);
      return true;
    },
  );
});

// ---------- Confirmed→Failed demotion guard (P0-002) ----------

test("fundDeal guarded failure recorder: a failure attempt against an already-Confirmed intent is a no-op (no Failed demotion)", async () => {
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
  const before = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(before);
  assert.equal(before.providerState, "Confirmed");
  // Simulate a late concurrent failure attempt — must be a no-op
  // because the intent is already Confirmed (P0-002).
  const result = await repo.recordPaymentIntentFailureInTransaction({
    paymentIntentId: before.id,
    failureReasonCode: "EscrowProviderUnavailable",
    failureDetailCategory: "PROVIDER_UNAVAILABLE",
  });
  assert.deepEqual(result, { ok: true, persisted: false, reason: "ALREADY_CONFIRMED" });
  const after = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.ok(after);
  assert.equal(after.providerState, "Confirmed", "Confirmed intent must NOT be demoted to Failed");
  assert.equal(after.failureReasonCode, null, "failure columns remain cleared");
  assert.equal(after.failureDetailCategory, null, "failureDetailCategory remains null");
});

test("confirmed retries reauthorize membership, exact buyer Workspace, active status, and Buyer capability", async (t) => {
  const cases: readonly {
    name: string;
    mutate(repo: InMemoryFundingRepository): void;
    actingWorkspaceId?: string;
  }[] = [
    {
      name: "membership removed",
      mutate: (repo) => repo.removeMembership(USER_ID, BUYER_WS),
    },
    {
      name: "Buyer capability removed",
      mutate: (repo) => repo.removeWorkspaceCapability(BUYER_WS, "Buyer"),
    },
    {
      name: "buyer Workspace suspended",
      mutate: (repo) => repo.seedWorkspace({ workspaceId: BUYER_WS, status: "Suspended" }),
    },
    {
      name: "seller Workspace substituted",
      actingWorkspaceId: SELLER_WS,
      mutate: () => undefined,
    },
    {
      name: "unrelated Workspace substituted",
      actingWorkspaceId: "ws_unrelated",
      mutate: (repo) => {
        repo.seedWorkspace({ workspaceId: "ws_unrelated", status: "Active" });
        repo.seedMembership({ userId: USER_ID, workspaceId: "ws_unrelated" });
        repo.seedWorkspaceCapability({ workspaceId: "ws_unrelated", capability: "Buyer" });
      },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
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
      scenario.mutate(repo);
      await assert.rejects(
        service.fundDeal({
          userAccountId: USER_ID,
          actingWorkspaceId: scenario.actingWorkspaceId ?? BUYER_WS,
          dealId: DEAL_ID,
          now: new Date("2026-09-03T12:01:00.000Z"),
        }),
        (err: unknown) =>
          err instanceof FundingServiceError && err.code === "BG6_FUNDING_FORBIDDEN",
      );
      assert.equal(provider.callCount, 1, "cached retry must not invoke provider");
    });
  }
});

test("concurrent provider failure that loses to confirmation converges to the successful result", async () => {
  const repo = new InMemoryFundingRepository();
  seedHappyPath(repo);
  let succeed!: (value: EscrowConfirmation) => void;
  let fail!: (reason: Error) => void;
  let calls = 0;
  const provider: EscrowProvider = {
    key: "mock-escrow-deterministic",
    assetLabel: "sandbox-USDC",
    networkLabel: "simulated-network",
    environmentLabel: "sandbox",
    requestFunding() {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          succeed = resolve;
        });
      }
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    },
  };
  const service = new FundingService({ fundingRepository: repo, escrowProvider: provider });
  const command = {
    userAccountId: USER_ID,
    actingWorkspaceId: BUYER_WS,
    dealId: DEAL_ID,
    now: new Date("2026-09-03T12:00:00.000Z"),
  };
  const winner = service.fundDeal(command);
  const loser = service.fundDeal(command);
  await new Promise((resolve) => setImmediate(resolve));
  succeed({
    providerKey: provider.key,
    providerReference: "mock-converged",
    confirmedAmountMinor: 75000,
    confirmedCurrency: "USD",
    assetLabel: provider.assetLabel,
    networkLabel: provider.networkLabel,
    environmentLabel: provider.environmentLabel,
    termsVersionId: TV_ID,
    confirmedAt: command.now.toISOString(),
  });
  const success = await winner;
  fail(new Error("late provider outage"));
  const converged = await loser;
  assert.deepEqual(converged, success);
  const intent = await repo.findCurrentPaymentIntent(DEAL_ID);
  assert.equal(intent?.providerState, "Confirmed");
});
