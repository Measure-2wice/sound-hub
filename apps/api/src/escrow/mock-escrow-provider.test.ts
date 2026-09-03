// Provider-layer tests for the deterministic mock escrow provider.
//
// Per refinement feedback: provider failure tests live at the
// provider/service layer (this file plus funding.service.test.ts);
// repository tests focus on persisted state, transactionality,
// locking, retry safety, exact-version/amount matching, and guarded
// activation.

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
    correlationId: "00000000-0000-4000-8000-000000000001",
    now: new Date("2026-09-03T12:00:00.000Z"),
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

test("requestFunding uses the unmistakable simulated network label — never 'sandbox-polkadot-...'", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const confirmation = await provider.requestFunding(makeInput());
  assert.equal(confirmation.networkLabel, "simulated-polkadot-asset-hub-testnet");
  // Explicit anti-assertion: a real network label is never claimed.
  assert.notEqual(confirmation.networkLabel, "sandbox-polkadot-asset-hub-testnet");
  assert.notEqual(confirmation.networkLabel, "polkadot-asset-hub-testnet");
});

test("requestFunding returns the fixed asset / environment / provider labels", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const confirmation = await provider.requestFunding(makeInput());
  assert.equal(confirmation.assetLabel, "sandbox-USDC");
  assert.equal(confirmation.environmentLabel, "sandbox");
  assert.equal(confirmation.providerKey, "mock-escrow-deterministic");
});

test("requestFunding produces a deterministic providerReference for the same input", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const input = makeInput();
  const a = await provider.requestFunding(input);
  const b = await provider.requestFunding(input);
  assert.equal(a.providerReference, b.providerReference);
  // The reference embeds paymentIntentId + correlationId so a future
  // provider integration can correlate without depending on SoundHub
  // internal ids.
  assert.equal(a.providerReference, `mock-${input.paymentIntentId}-${input.correlationId}`);
});

test("requestFunding reflects the supplied confirmedAt", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const now = new Date("2026-09-03T12:34:56.000Z");
  const confirmation = await provider.requestFunding(makeInput({ now }));
  assert.equal(confirmation.confirmedAt.getTime(), now.getTime());
});

test("requestFunding does NOT throw on a well-formed input (the deterministic mock has no failure path)", async () => {
  const provider = new DeterministicMockEscrowProvider();
  // Calling the mock never throws; the service-layer test injects a
  // failing stub for the failure path.
  await assert.doesNotReject(() => provider.requestFunding(makeInput()));
});

test("two calls with different inputs produce different providerReferences", async () => {
  const provider = new DeterministicMockEscrowProvider();
  const a = await provider.requestFunding(makeInput({ paymentIntentId: "pi_a" }));
  const b = await provider.requestFunding(makeInput({ paymentIntentId: "pi_b" }));
  assert.notEqual(a.providerReference, b.providerReference);
});
