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
// The interface is provider-neutral. A future PolkaAward adapter (or
// any real provider) slots in without changing the application
// contract or masquerading as the deterministic mock.
//
// The provider is called with a fixed input and returns a fixed
// output. The application parses the output through a STRICT Zod
// schema (`escrowConfirmationSchema`) before any persistence,
// transition, or activation runs. A failed parse fails closed and
// leaves the Deal Negotiating. The deterministic mock wired for the
// buildathon returns a parseable object whose amount/currency/
// termsVersionId/confirmedAt equal the supplied input.
//
// IMPORTANT — privacy boundary:
//   - The internal `correlationId` is SoundHub's opaque durable
//     audit identity. It is INTENTIONALLY ABSENT from the provider
//     input. A provider that needs its own external idempotency
//     token derives it from `paymentIntentId` (the SoundHub-supplied
//     opaque handle adapters may use for trace correlation; the
//     deterministic mock does NOT embed it).

import { z } from "zod";

const boundedLabel = z.string().trim().min(1).max(128);

export const escrowRequestInputSchema = z
  .object({
    paymentIntentId: boundedLabel,
    dealId: boundedLabel,
    termsVersionId: boundedLabel,
    termsVersionNumber: z.number().int().positive(),
    priceAmountMinor: z.number().int().nonnegative(),
    priceCurrency: z.string().regex(/^[A-Z]{3}$/),
    now: z.string().datetime({ offset: true }),
  })
  .strict();

export const escrowConfirmationSchema = z
  .object({
    providerKey: boundedLabel,
    providerReference: boundedLabel,
    confirmedAmountMinor: z.number().int().nonnegative(),
    confirmedCurrency: z.string().regex(/^[A-Z]{3}$/),
    assetLabel: boundedLabel,
    networkLabel: boundedLabel,
    environmentLabel: boundedLabel,
    termsVersionId: boundedLabel,
    confirmedAt: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * Provider-neutral escrow confirmation. The Zod parse is the
 * runtime boundary — application code MUST validate every adapter
 * response before persisting it.
 */
export type EscrowConfirmation = z.infer<typeof escrowConfirmationSchema>;

/**
 * Provider-neutral escrow request input. The Zod parse is the
 * runtime boundary for the application; adapters may also
 * re-validate, but the application-side parse is the authoritative
 * gate.
 */
export type EscrowRequestInput = z.infer<typeof escrowRequestInputSchema>;

export interface EscrowProvider {
  readonly key: string;
  readonly assetLabel: string;
  readonly networkLabel: string;
  readonly environmentLabel: string;
  /**
   * Request funding for the exact supplied TermsVersion + amount.
   * Throws on provider outage (the application maps the throw to
   * BG6_ESCROW_UNAVAILABLE). Returns a confirmation whose amount,
   * currency, termsVersionId, and confirmedAt MUST equal the
   * supplied input — the application re-validates the parsed
   * confirmation against the locked snapshot before persisting (the
   * "mismatch is not success" rule).
   *
   * The application parses the returned object through
   * `escrowConfirmationSchema` before any further processing.
   */
  requestFunding(input: EscrowRequestInput): Promise<EscrowConfirmation>;
}

/**
 * The deterministic mock escrow provider. The buildathon wires this
 * as the only provider; the `EscrowProvider` interface remains the
 * seam a future PolkaAward adapter (or any real provider) slots
 * into without changing the application boundary.
 *
 * The mock returns unmistakably synthetic labels:
 *   - assetLabel       = "sandbox-USDC"
 *   - networkLabel     = "simulated-network"
 *   - environmentLabel = "sandbox"
 * The application persists these verbatim so the public DTO and UI
 * surface can never claim a real asset or network family.
 */
export class DeterministicMockEscrowProvider implements EscrowProvider {
  readonly key = "mock-escrow-deterministic" as const;
  readonly assetLabel = "sandbox-USDC" as const;
  readonly networkLabel = "simulated-network" as const;
  readonly environmentLabel = "sandbox" as const;

  requestFunding(input: EscrowRequestInput): Promise<EscrowConfirmation> {
    // Pre-parse the input through the closed contract so a buggy
    // caller cannot smuggle provider-neutral metadata through.
    escrowRequestInputSchema.parse(input);
    // Build the confirmation with the same closed labels.
    const confirmation = {
      providerKey: this.key,
      // Reference shape: opaque to the application, bounded length
      // (max 128 chars enforced by the Zod schema). The mock does
      // NOT embed SoundHub's internal correlationId.
      providerReference: `mock-${input.paymentIntentId}`,
      confirmedAmountMinor: input.priceAmountMinor,
      confirmedCurrency: input.priceCurrency,
      assetLabel: this.assetLabel,
      networkLabel: this.networkLabel,
      environmentLabel: this.environmentLabel,
      termsVersionId: input.termsVersionId,
      confirmedAt: input.now,
    };
    // The deterministic mock is owned by the application; the
    // confirmation is parseable by construction. The parse is here
    // so a future code change cannot bypass the runtime boundary.
    return Promise.resolve(escrowConfirmationSchema.parse(confirmation));
  }
}
