// Funding repository contract (BG6).
//
// Background: ticket #64 requires a persistence boundary for the
// PaymentIntent lifecycle (Created → Confirmed/Failed) and the
// deterministic activation transition. The contract is the only
// surface the service layer depends on; the Prisma adapter is the
// canonical implementation and is the only place that touches the
// database directly.
//
// The contract deliberately exposes three transaction-scoped use
// cases so the application can run authorization and persistence in
// one authoritative unit of work:
//
//   - findPreauthSnapshot: non-transactional read used by Phase 1
//     preauth. Assembles the current Deal + current TermsVersion +
//     both DealApprovals + ProjectRequest + acting Workspace +
//     WorkspaceMembership. No FOR UPDATE locks (Phase 1 is a
//     best-effort check; Phase 3 re-validates under lock).
//
//   - findOrCreatePaymentIntentInTransaction: opens a short
//     Serializable transaction, locks the parent TermsVersion row
//     (`SELECT ... FOR UPDATE` on `terms_versions.id`), re-reads
//     `payment_intents` by `(dealId, termsVersionId)` and returns
//     the existing row if any. Otherwise INSERTS a new row with
//     `providerState = "Created"`. A P2002 collision is caught and
//     re-reads the winning row. A `Failed` intent is always the SAME
//     durable row for the same tuple — this method NEVER creates a
//     second intent for the same `(dealId, termsVersionId)`.
//
//   - recordPaymentIntentFailureInTransaction: short tx; transitions
//     `providerState` to `Failed` and persists the closed
//     `failureReasonCode` + the server-only raw `failureDetail`.
//     Used when the provider throws between Phase 2 and Phase 3, and
//     on a second-attempt failure.
//
//   - fundDealInTransaction: the Phase-3 transaction. Opens a
//     Serializable $transaction, FOR UPDATE-locks all relevant rows,
//     hands the locked snapshot to the use-case closure. The use
//     case (a) re-runs `evaluatePreauthAuthority`, (b) re-verifies
//     exact-match, (c) calls `tools.persistFundingConfirmationAndActivate(...)`
//     OR `tools.reject(reason)`. The repository performs
//     `tx.paymentIntent.update` (transition to Confirmed + clear
//     failure columns) + raw guarded `UPDATE deals SET status =
//     'Active', "activatedAt" = ? WHERE id = ? AND status =
//     'Negotiating' RETURNING id` inside the same transaction.
//     Bounded P2034 retry on Serializable conflicts.

import type { DealStatusV1, DealPublicV1, ProjectRequestPublicV1 } from "@soundhub/types";
import type {
  ActivationAuthoritySnapshot,
  PreauthAuthoritySnapshot,
} from "./funding-authorization-policy.js";

// ---------- Persistence shapes (private audit fields retained) ----------

export interface PersistedPaymentIntent {
  readonly id: string;
  readonly dealId: string;
  readonly termsVersionId: string;
  readonly actingWorkspaceId: string;
  readonly createdByUserId: string;
  readonly expectedAmountMinor: number;
  readonly expectedCurrency: string;
  readonly assetLabel: string;
  readonly networkLabel: string;
  readonly providerKey: string;
  readonly environmentLabel: string;
  readonly correlationId: string;
  readonly providerReference: string | null;
  readonly confirmedAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly failureReasonCode: string | null;
  readonly failureDetail: string | null;
  readonly providerState: "Created" | "Confirmed" | "Failed";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PersistedDealSummaryForFunding {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly status: DealStatusV1;
  readonly activatedAt: Date | null;
}

export interface PersistedTermsVersionForFunding {
  readonly id: string;
  readonly dealId: string;
  readonly version: number;
  readonly priceAmountMinor: number;
  readonly priceCurrency: string;
}

// ---------- Preauth read shape ----------

export type FindPreauthFailureReason =
  | "DEAL_NOT_FOUND"
  | "CURRENT_TERMS_VERSION_NOT_FOUND"
  | "PROJECT_REQUEST_NOT_FOUND";

export type FindPreauthResult =
  | {
      readonly ok: true;
      readonly value: PreauthAuthoritySnapshot;
      readonly currentTermsVersion: CurrentTermsVersionSummary;
    }
  | { readonly ok: false; readonly reason: FindPreauthFailureReason };

export interface FindPreauthInput {
  readonly dealId: string;
  readonly actingWorkspaceId: string;
  readonly actingUserAccountId: string;
}

export interface CurrentTermsVersionSummary {
  readonly id: string;
  readonly version: number;
  readonly priceAmountMinor: number;
  readonly priceCurrency: string;
}

// ---------- findOrCreatePaymentIntentInTransaction ----------

export interface FindOrCreatePaymentIntentInput {
  readonly dealId: string;
  readonly termsVersionId: string;
  readonly expectedAmountMinor: number;
  readonly expectedCurrency: string;
  readonly assetLabel: string;
  readonly networkLabel: string;
  readonly providerKey: string;
  readonly environmentLabel: string;
  readonly actingWorkspaceId: string;
  readonly createdByUserId: string;
  /** SoundHub-owned opaque durable correlation identifier. */
  readonly correlationId: string;
}

export type FindOrCreateFailureReason = "TERMS_VERSION_NOT_FOUND";

export type FindOrCreatePaymentIntentResult =
  | { readonly ok: true; readonly value: PersistedPaymentIntent }
  | { readonly ok: false; readonly reason: FindOrCreateFailureReason };

// ---------- recordPaymentIntentFailureInTransaction ----------

export interface RecordPaymentIntentFailureInput {
  readonly paymentIntentId: string;
  readonly failureReasonCode:
    | "EscrowProviderUnavailable"
    | "EscrowConfirmationAmountMismatch"
    | "EscrowConfirmationCurrencyMismatch"
    | "EscrowConfirmationVersionMismatch";
  /** Server-only raw exception text. NEVER returned in any DTO. */
  readonly failureDetail: string;
}

// ---------- fundDealInTransaction (Phase 3) ----------

export type FundDealFailureReason =
  | "DEAL_NOT_FOUND"
  | "DEAL_NOT_NEGOTIATING"
  | "TERMS_VERSION_NOT_FOUND"
  | "TERMS_VERSION_NOT_CURRENT"
  | "NOT_BUYER_SIDE"
  | "NOT_A_MEMBER"
  | "WORKSPACE_INELIGIBLE"
  | "SELLER_NOT_CONSENTED"
  | "APPROVALS_INCOMPLETE"
  | "CONFIRMATION_AMOUNT_MISMATCH"
  | "CONFIRMATION_CURRENCY_MISMATCH"
  | "CONFIRMATION_TERMS_VERSION_MISMATCH"
  | "DEAL_ALREADY_ACTIVE"
  | "PAYMENT_INTENT_NOT_FOUND"
  | "PAYMENT_INTENT_NOT_CONFIRMED"
  | "CONCURRENCY_RETRY_EXHAUSTED";

export type FundDealResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly paymentIntent: PersistedPaymentIntent;
        readonly deal: PersistedDealSummaryForFunding;
      };
    }
  | { readonly ok: false; readonly reason: FundDealFailureReason };

export interface FundDealUseCaseContext {
  readonly preauth: PreauthAuthoritySnapshot;
  readonly activation: ActivationAuthoritySnapshot;
  readonly paymentIntentId: string;
}

export interface FundDealUseCaseTools {
  reject(reason: FundDealFailureReason): FundDealUseCaseOutcome;
  /**
   * Persist the confirmed funding fields on the PaymentIntent row
   * (transition to "Confirmed", clear failure columns) and apply the
   * guarded activation UPDATE inside the same transaction. The
   * repository maps a 0-row UPDATE to `DEAL_ALREADY_ACTIVE`.
   */
  persistFundingConfirmationAndActivate(input: {
    readonly paymentIntentId: string;
    readonly providerReference: string;
    readonly confirmedAt: Date;
    readonly acceptedAt: Date;
  }): FundDealUseCaseOutcome;
}

export type FundDealUseCaseOutcome =
  | { readonly kind: "reject"; readonly reason: FundDealFailureReason }
  | {
      readonly kind: "persist";
      readonly input: {
        readonly paymentIntentId: string;
        readonly providerReference: string;
        readonly confirmedAt: Date;
        readonly acceptedAt: Date;
      };
    };

export type FundDealUseCase = (
  ctx: FundDealUseCaseContext,
  tools: FundDealUseCaseTools,
) => FundDealUseCaseOutcome;

export interface FundDealTransactionInput {
  readonly dealId: string;
  readonly paymentIntentId: string;
  readonly providerReference: string;
  readonly confirmedAt: Date;
  readonly acceptedAt: Date;
  readonly actingWorkspaceId: string;
  readonly actingUserAccountId: string;
}

// ---------- Public DTO mapping surface ----------

/**
 * The minimal public funding-status DTO is computed in the service
 * layer using `toPublicFundingStatus`. The repository returns raw
 * persisted rows; the service owns the allow-list.
 */
export interface FundingRepository {
  findPreauthSnapshot(input: FindPreauthInput): Promise<FindPreauthResult>;

  findOrCreatePaymentIntentInTransaction(
    input: FindOrCreatePaymentIntentInput,
  ): Promise<FindOrCreatePaymentIntentResult>;

  recordPaymentIntentFailureInTransaction(input: RecordPaymentIntentFailureInput): Promise<void>;

  fundDealInTransaction(
    input: FundDealTransactionInput,
    useCase: FundDealUseCase,
  ): Promise<FundDealResult>;

  /**
   * Read the persisted PaymentIntent for the current
   * (dealId, termsVersionId) tuple. Returns null when no intent
   * exists yet. Used by the service to surface the public funding
   * status on a fresh page load (the route does NOT need to wait
   * for a fundDeal response to render the current intent state).
   */
  findCurrentPaymentIntent(dealId: string): Promise<PersistedPaymentIntent | null>;
}

// Re-exports for service layer convenience.
export type { DealPublicV1, ProjectRequestPublicV1 };
