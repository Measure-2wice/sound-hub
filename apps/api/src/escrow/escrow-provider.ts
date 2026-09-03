// EscrowProvider — provider-neutral escrow interface (BG6).
//
// Per ticket #64 a deterministic application service transitions the
// Deal to Active only when seller acceptance, buyer approval, seller
// approval, and confirmed funding all match the same current
// TermsVersion and amount. The provider is a thin adapter behind a
// narrow interface; it does NOT decide authorization, state
// transitions, deadlines, or what to do on failure — those are all
// application-owned.
//
// The provider is called with a fixed input and returns a fixed
// output. A throw from the provider surfaces as BG6_ESCROW_UNAVAILABLE
// at the route boundary; the intent row transitions to Failed on the
// SAME durable (dealId, termsVersionId) row and the Deal stays
// Negotiating.
//
// The deterministic mock wired for the buildathon returns:
//   - providerReference = "mock-${paymentIntentId}-${correlationId}"
//   - assetLabel        = "sandbox-USDC"
//   - networkLabel      = "simulated-polkadot-asset-hub-testnet"  (unmistakably simulated)
//   - environmentLabel  = "sandbox"
// The confirmation's amount/currency/termsVersionId/confirmedAt
// MUST equal the supplied input. The application re-verifies this
// exact match (the "mismatch is not success" rule) before persisting
// during the Phase 3 Serializable transaction.

export interface EscrowRequestInput {
  readonly paymentIntentId: string;
  readonly dealId: string;
  readonly termsVersionId: string;
  readonly termsVersionNumber: number;
  readonly priceAmountMinor: number;
  readonly priceCurrency: "USD";
  /**
   * The SoundHub-owned opaque correlation identifier. Persisted on
   * the PaymentIntent but NOT sent to the provider as an input
   * field — the provider does not see SoundHub's internal audit
   * handle. (The provider MAY choose to embed it in its own
   * `providerReference` for trace correlation; the mock does.)
   */
  readonly correlationId: string;
  readonly now: Date;
}

export interface EscrowConfirmation {
  readonly providerKey: "mock-escrow-deterministic";
  readonly providerReference: string;
  readonly confirmedAmountMinor: number;
  readonly confirmedCurrency: "USD";
  readonly assetLabel: "sandbox-USDC";
  readonly networkLabel: "simulated-polkadot-asset-hub-testnet";
  readonly environmentLabel: "sandbox";
  readonly termsVersionId: string;
  readonly confirmedAt: Date;
}

export interface EscrowProvider {
  readonly key: "mock-escrow-deterministic";
  /**
   * Request funding for the exact supplied TermsVersion + amount.
   * Throws on provider outage (the application maps the throw to
   * BG6_ESCROW_UNAVAILABLE). Returns a confirmation whose amount,
   * currency, and termsVersionId MUST equal the supplied input —
   * the application re-verifies this exact match before persisting
   * (the "mismatch is not success" rule).
   */
  requestFunding(input: EscrowRequestInput): Promise<EscrowConfirmation>;
}

/**
 * The deterministic mock escrow provider. The buildathon wires this
 * as the only provider; the `EscrowProvider` interface remains the
 * seam a future PolkaAward adapter (or any real provider) slots
 * into without changing the application boundary.
 */
export class DeterministicMockEscrowProvider implements EscrowProvider {
  readonly key = "mock-escrow-deterministic" as const;

  async requestFunding(input: EscrowRequestInput): Promise<EscrowConfirmation> {
    return {
      providerKey: this.key,
      providerReference: `mock-${input.paymentIntentId}-${input.correlationId}`,
      confirmedAmountMinor: input.priceAmountMinor,
      confirmedCurrency: input.priceCurrency,
      assetLabel: "sandbox-USDC",
      networkLabel: "simulated-polkadot-asset-hub-testnet",
      environmentLabel: "sandbox",
      termsVersionId: input.termsVersionId,
      confirmedAt: input.now,
    };
  }
}
