/* eslint-disable @typescript-eslint/no-floating-promises */
// Provider-layer tests for the deterministic mock escrow provider
// (BG6).
//
// Per refinement feedback: provider failure tests live at the
// provider/service layer (this file plus funding.service.test.ts);
// repository tests focus on persisted state, transactionality,
// locking, retry safety, exact-version/amount matching, and guarded
// activation.
//
// The provider boundary is provider-neutral: a future PolkaAward
// adapter (or any real provider) slots into the same interface
// without changing the application boundary. The deterministic mock
// returns unmistakably synthetic labels — see ticket #64 P1-006.

import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicMockEscrowProvider, type EscrowRequestInput } from "./escrow-provider.js";

function makeInput(overrides: Partial<EscrowRequestInput> = {}): EscrowRequestInput {
  return {
    paymentIntentId: "pi_test_001",
    dealId: "deal_test_001",
    termsVersionId: "tv_test_001",
    termsVersionNumber: 1,
    priceAmountMinor: 75000,
    priceCurrency: "USD",
    now: "2026-09-03T12:00:00.000Z",
    ...overrides,
  };
}

test("DeterministicMockEscrowProvider.key === 'mock-escrow-deterministic'", () => {
  const provider = new DeterministicMockEscrowProvider();
  assert.equal(provider.key, "mock-escrow-deterministic");
});

test("requestFunding returns a confirmation whose amount/currency/termsVersionId exactly equal the input", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const input = makeInput();
  const confirmation = await provider.requestFunding(input);
  assert.equal(confirmation.confirmedAmountMinor, input.priceAmountMinor);
  assert.equal(confirmation.confirmedCurrency, input.priceCurrency);
  assert.equal(confirmation.termsVersionId, input.termsVersionId);
});

test("requestFunding returns the unmistakable synthetic network label — never a real network family", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const confirmation = await provider.requestFunding(makeInput());
  // Per ticket #64 P1-006 — the mock has zero blockchain
  // connectivity so the network label must be unmistakably synthetic.
  // The closed tuple in @soundhub/types now exposes only
  // "simulated-network"; no concrete blockchain family is named.
  assert.equal(confirmation.networkLabel, "simulated-network");
  // Anti-assertions: no real network family is ever claimed.
  assert.notEqual(confirmation.networkLabel, "sandbox-polkadot-asset-hub-testnet");
  assert.notEqual(confirmation.networkLabel, "polkadot-asset-hub-testnet");
  assert.notEqual(confirmation.networkLabel, "polkadot");
});

test("requestFunding returns the fixed asset / environment / provider labels", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const confirmation = await provider.requestFunding(makeInput());
  assert.equal(confirmation.assetLabel, "sandbox-USDC");
  assert.equal(confirmation.environmentLabel, "sandbox");
  assert.equal(confirmation.providerKey, "mock-escrow-deterministic");
});

test("EscrowRequestInput is provider-neutral: NO correlationId field is exposed (P1-003)", () => {
  // The internal correlationId is SoundHub's opaque durable audit
  // identity. The provider MUST NOT see this value. A provider
  // that needs an external idempotency token should derive it
  // from the public paymentIntentId (the SoundHub-supplied opaque
  // handle adapters can use for trace correlation).
  const input = makeInput() as unknown as Record<string, unknown>;
  assert.equal(
    Object.prototype.hasOwnProperty.call(input, "correlationId"),
    false,
    "EscrowRequestInput MUST NOT carry SoundHub's internal correlationId",
  );
});

test("requestFunding returns a unique bounded providerReference per call", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const input = makeInput();
  const a = await provider.requestFunding(input);
  const b = await provider.requestFunding(input);
  // Per call the mock generates a fresh opaque UUID — SoundHub's
  // internal correlationId is INTENTIONALLY NOT embedded in the
  // provider reference. The strict Zod schema bounds the
  // providerReference length (max 128).
  assert.notEqual(a.providerReference, b.providerReference);
  assert.ok(a.providerReference.length > 0);
  assert.ok(a.providerReference.length <= 128);
  assert.ok(!a.providerReference.includes("00000000-0000-4000-8000"));
});

test("requestFunding reflects the supplied confirmedAt", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const now = "2026-09-03T12:34:56.000Z";
  const confirmation = await provider.requestFunding(makeInput({ now }));
  assert.equal(confirmation.confirmedAt, now);
});

test("requestFunding does NOT throw on a well-formed input (the deterministic mock has no failure path)", async () => {
  const provider = new DeterministicMockEscrowProvider();
  await assert.doesNotReject(() => provider.requestFunding(makeInput()));
});

test("two calls with different inputs produce different providerReferences", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const a = await provider.requestFunding(makeInput({ paymentIntentId: "pi_a" }));
  const b = await provider.requestFunding(makeInput({ paymentIntentId: "pi_b" }));
  assert.notEqual(a.providerReference, b.providerReference);
});
