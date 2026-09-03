// FundingService (BG6).
//
// Background: ticket #64 requires a single application boundary that
// owns the Phase-1 preauthorization, the Phase-2 idempotent
// find-or-create + provider call, and the Phase-3 Serializable
// revalidation + activation. The service composes:
//
//   - the application-owned policy evaluators in
//     `./funding-authorization-policy.ts` (`evaluatePreauthAuthority`
//     for Phase 1 + Phase 3 revalidation, `evaluateActivationAuthority`
//     for the GS-25 invariant), and
//   - the transaction-scoped repository methods in
//     `./funding.repository.ts` (one Serializable transaction per
//     write path).
//
// Three-phase flow (mirrors BG5 draftTerms):
//
//   Phase 1 — Preauthorization (BEFORE provider call, BEFORE
//   transaction). Validates EVERY GS-25 condition against a
//   non-transactional read: authenticated human + acting Workspace,
//   current WorkspaceMembership, Buyer capability, buyer side,
//   Negotiating Deal, seller consent, both approvals for the CURRENT
//   version. Preauth failure short-circuits: NO `PaymentIntent` row
//   is created, NO provider call is made, NO transaction opened.
//
//   Phase 2 — Idempotent intent creation + provider call (BEFORE
//   main transaction). findOrCreatePaymentIntentInTransaction locks
//   the parent TermsVersion row (FOR UPDATE) — this serializes
//   concurrent find-or-create calls for the SAME
//   (dealId, termsVersionId) tuple naturally. Inside the lock the
//   repository re-reads by (dealId, termsVersionId) and either
//   returns the existing row or inserts a new one with
//   providerState = "Created". A P2002 catch re-reads the winning
//   row as defense-in-depth. The branch on providerState:
//     - Confirmed → the provider is NOT called again; Phase 3 still
//       runs and re-validates exact-match against the locked
//       snapshot.
//     - Created   → invoke the provider; Phase 3 transitions to
//       Confirmed (success) or Failed (mismatch / provider throw).
//     - Failed    → invoke the provider (explicit retry path); the
//       SAME durable row transitions Failed → Confirmed (clearing
//       failure columns) or Failed → Failed (latest attempt's
//       fields). No new intent is created.
//
//   Phase 3 — Transactional revalidation + persist provider reference
//   + guarded activation (Serializable). One $transaction: FOR
//   UPDATE-locks the PaymentIntent + Deal + current TermsVersion +
//   both DealApprovals + ProjectRequest + acting Workspace +
//   WorkspaceMembership; re-runs evaluatePreauthAuthority against
//   the LOCKED snapshot; verifies exact-match (amount/currency/
//   termsVersionId) against the locked snapshot; persists the
//   provider reference + transitions providerState = "Confirmed" +
//   clears failure columns; applies the guarded activation UPDATE
//   `UPDATE deals SET status = 'Active', "activatedAt" = ? WHERE id
//   = ? AND status = 'Negotiating' RETURNING id`. Both writes live
//   in the same transaction; either both commit or neither.
//
// Provider failure path: when the provider throws OR returns a
// non-matching confirmation, the service records
// failureReasonCode + failureDetail on the SAME intent row and
// surfaces the appropriate BG6_* failure. The Deal stays Negotiating
// and the PaymentIntent remains durable.

import { randomUUID } from "node:crypto";
import type { Bg6FundingConfirmationPublicV1, Bg6PublicFundingStatusV1 } from "@soundhub/types";
import { AuthorizationError } from "../services/workspace-authorization.service.js";
import type {
  DeterministicMockEscrowProvider,
  EscrowConfirmation,
  EscrowProvider,
} from "../escrow/escrow-provider.js";
import { evaluatePreauthAuthority } from "./funding-authorization-policy.js";
import type {
  FindOrCreatePaymentIntentResult,
  FundingRepository,
  PersistedPaymentIntent,
} from "./funding.repository.js";

export class FundingServiceError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "BG6_DEAL_NOT_FOUND"
      | "BG6_FUNDING_FORBIDDEN"
      | "BG6_FUNDING_INVALID"
      | "BG6_DEAL_NOT_NEGOTIATING"
      | "BG6_APPROVALS_INCOMPLETE"
      | "BG6_TERMS_VERSION_NOT_CURRENT"
      | "BG6_FUNDING_CONFIRMATION_MISMATCH"
      | "BG6_DEAL_ALREADY_ACTIVE"
      | "BG6_ESCROW_UNAVAILABLE"
      | "BG6_FUNDING_INTERNAL_FAILED",
  ) {
    super(message);
    this.name = "FundingServiceError";
  }
}

export interface FundingServiceDeps {
  readonly fundingRepository: FundingRepository;
  readonly escrowProvider: EscrowProvider | DeterministicMockEscrowProvider;
  readonly now?: () => Date;
}

export interface FundDealInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly dealId: string;
  readonly now?: Date;
}

const SANDBOX_ASSET_LABEL = "sandbox-USDC" as const;
const SANDBOX_NETWORK_LABEL = "simulated-polkadot-asset-hub-testnet" as const;
const SANDBOX_ENVIRONMENT_LABEL = "sandbox" as const;

export class FundingService {
  private readonly repository: FundingRepository;
  private readonly escrowProvider: EscrowProvider;
  private readonly now: () => Date;

  constructor(deps: FundingServiceDeps) {
    this.repository = deps.fundingRepository;
    this.escrowProvider = deps.escrowProvider;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Fund the Deal and (on success) transition it to Active.
   *
   * Returns the minimal public funding-status DTO — never the
   * internal PaymentIntent row, correlationId, providerReference, or
   * raw failureDetail.
   */
  async fundDeal(input: FundDealInput): Promise<{
    readonly dealStatus: "Negotiating" | "Active";
    readonly activatedAt: string | null;
    readonly fundingStatus: Bg6FundingConfirmationPublicV1;
  }> {
    const now = input.now ?? this.now();

    // Phase 1: preauthorize BEFORE the provider call.
    const preauth = await this.repository.findPreauthSnapshot({
      dealId: input.dealId,
      actingWorkspaceId: input.actingWorkspaceId,
      actingUserAccountId: input.userAccountId,
    });
    if (!preauth.ok) {
      throw preauthFailureToServiceError(preauth.reason);
    }
    const preauthVerdict = evaluatePreauthAuthority(preauth.value);
    if (!preauthVerdict.ok) {
      throw preauthVerdictToServiceError(preauthVerdict.reason);
    }
    const currentTermsVersion = preauth.currentTermsVersion;

    // Phase 2a: find-or-create the durable PaymentIntent. The
    // repository locks the parent TermsVersion row (FOR UPDATE) so
    // concurrent calls for the same (dealId, termsVersionId)
    // converge on a single row. The expectedAmountMinor +
    // expectedCurrency are pinned to the locked TermsVersion's
    // price — the Phase-3 transaction re-verifies the provider's
    // confirmation matches these values bit-for-bit.
    const intentResult = await this.repository.findOrCreatePaymentIntentInTransaction({
      dealId: input.dealId,
      termsVersionId: currentTermsVersion.id,
      expectedAmountMinor: currentTermsVersion.priceAmountMinor,
      expectedCurrency: currentTermsVersion.priceCurrency,
      assetLabel: SANDBOX_ASSET_LABEL,
      networkLabel: SANDBOX_NETWORK_LABEL,
      providerKey: this.escrowProvider.key,
      environmentLabel: SANDBOX_ENVIRONMENT_LABEL,
      actingWorkspaceId: input.actingWorkspaceId,
      createdByUserId: input.userAccountId,
      correlationId: randomUUID(),
    });
    if (!intentResult.ok) {
      throw new FundingServiceError("TermsVersion not found.", "BG6_TERMS_VERSION_NOT_CURRENT");
    }
    const intent = intentResult.value;
    const termsVersionNumber = currentTermsVersion.version;
    const priceAmountMinor = currentTermsVersion.priceAmountMinor;

    // Phase 2b: branch on providerState. Confirmed → reuse cached
    // confirmation; Created or Failed → invoke the provider.
    let providerConfirmation: EscrowConfirmation | null = null;
    if (intent.providerState === "Confirmed") {
      // Reuse cached fields. The Phase-3 transaction still re-runs
      // preauth + exact-match under lock — a material change to
      // TermsVersion.priceAmountMinor between the original
      // confirmation and this retry would reject.
      providerConfirmation = {
        providerKey: intent.providerKey as "mock-escrow-deterministic",
        providerReference: intent.providerReference ?? "",
        confirmedAmountMinor: intent.expectedAmountMinor,
        confirmedCurrency: intent.expectedCurrency as "USD",
        assetLabel: SANDBOX_ASSET_LABEL,
        networkLabel: SANDBOX_NETWORK_LABEL,
        environmentLabel: SANDBOX_ENVIRONMENT_LABEL,
        termsVersionId: intent.termsVersionId,
        confirmedAt: intent.confirmedAt ?? now,
      };
    } else {
      try {
        providerConfirmation = await this.escrowProvider.requestFunding({
          paymentIntentId: intent.id,
          dealId: input.dealId,
          termsVersionId: intent.termsVersionId,
          termsVersionNumber,
          priceAmountMinor,
          priceCurrency: "USD",
          correlationId: intent.correlationId,
          now,
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await this.repository.recordPaymentIntentFailureInTransaction({
          paymentIntentId: intent.id,
          failureReasonCode: "EscrowProviderUnavailable",
          failureDetail: detail,
        });
        throw new FundingServiceError(
          "The escrow provider is unavailable.",
          "BG6_ESCROW_UNAVAILABLE",
        );
      }
    }

    // Phase 3: open the Serializable activation transaction.
    let activationResult: Awaited<ReturnType<FundingRepository["fundDealInTransaction"]>>;
    try {
      activationResult = await this.repository.fundDealInTransaction(
        {
          dealId: input.dealId,
          paymentIntentId: intent.id,
          providerReference: providerConfirmation.providerReference,
          confirmedAt: providerConfirmation.confirmedAt,
          acceptedAt: now,
          actingWorkspaceId: input.actingWorkspaceId,
          actingUserAccountId: input.userAccountId,
        },
        (ctx, tools) => {
          // Re-run preauth + activation under lock.
          const verdict = evaluatePreauthAuthority(ctx.preauth);
          if (!verdict.ok) {
            return tools.reject(preauthVerdictToFundRepoReason(verdict.reason));
          }
          // Exact-match re-verification against the locked snapshot.
          if (
            providerConfirmation!.confirmedAmountMinor !==
            ctx.activation.currentTermsVersionAmountMinor
          ) {
            return tools.reject("CONFIRMATION_AMOUNT_MISMATCH");
          }
          if (
            providerConfirmation!.confirmedCurrency !== ctx.activation.currentTermsVersionCurrency
          ) {
            return tools.reject("CONFIRMATION_CURRENCY_MISMATCH");
          }
          if (providerConfirmation!.termsVersionId !== ctx.activation.currentTermsVersionId) {
            return tools.reject("CONFIRMATION_TERMS_VERSION_MISMATCH");
          }
          return tools.persistFundingConfirmationAndActivate({
            paymentIntentId: ctx.paymentIntentId,
            providerReference: providerConfirmation!.providerReference,
            confirmedAt: providerConfirmation!.confirmedAt,
            acceptedAt: now,
          });
        },
      );
    } catch (err) {
      if (err instanceof AuthorizationError) {
        throw new FundingServiceError(
          "You are not authorized to fund this Deal.",
          "BG6_FUNDING_FORBIDDEN",
        );
      }
      throw err;
    }

    if (!activationResult.ok) {
      // On confirmation mismatch the transaction rolls back the
      // intent update; record the latest attempt's failure fields on
      // the SAME row so a future retry carries forward the diagnostic.
      if (
        activationResult.reason === "CONFIRMATION_AMOUNT_MISMATCH" ||
        activationResult.reason === "CONFIRMATION_CURRENCY_MISMATCH" ||
        activationResult.reason === "CONFIRMATION_TERMS_VERSION_MISMATCH"
      ) {
        await this.repository.recordPaymentIntentFailureInTransaction({
          paymentIntentId: intent.id,
          failureReasonCode: mismatchReasonToCode(activationResult.reason),
          failureDetail: `provider confirmation did not match locked snapshot: ${activationResult.reason}`,
        });
        throw new FundingServiceError(
          "The provider confirmation did not match the locked TermsVersion snapshot.",
          "BG6_FUNDING_CONFIRMATION_MISMATCH",
        );
      }
      throw fundRepoFailureToServiceError(activationResult.reason);
    }

    return {
      dealStatus: activationResult.value.deal.status,
      activatedAt: activationResult.value.deal.activatedAt
        ? activationResult.value.deal.activatedAt.toISOString()
        : null,
      fundingStatus: toPublicFundingStatus(
        activationResult.value.paymentIntent,
        currentTermsVersion.version,
        null,
      ),
    };
  }
}

function preauthFailureToServiceError(
  reason: "DEAL_NOT_FOUND" | "CURRENT_TERMS_VERSION_NOT_FOUND" | "PROJECT_REQUEST_NOT_FOUND",
): FundingServiceError {
  switch (reason) {
    case "DEAL_NOT_FOUND":
      return new FundingServiceError("Deal not found.", "BG6_DEAL_NOT_FOUND");
    case "CURRENT_TERMS_VERSION_NOT_FOUND":
      return new FundingServiceError(
        "The Deal has no current TermsVersion.",
        "BG6_TERMS_VERSION_NOT_CURRENT",
      );
    case "PROJECT_REQUEST_NOT_FOUND":
      return new FundingServiceError(
        "ProjectRequest not found for this Deal.",
        "BG6_FUNDING_FORBIDDEN",
      );
  }
}

function preauthVerdictToServiceError(
  reason:
    | "DEAL_NOT_FOUND"
    | "DEAL_NOT_NEGOTIATING"
    | "TERMS_VERSION_NOT_FOUND"
    | "TERMS_VERSION_NOT_CURRENT"
    | "NOT_BUYER_SIDE"
    | "NOT_A_MEMBER"
    | "WORKSPACE_INELIGIBLE"
    | "SELLER_NOT_CONSENTED"
    | "APPROVALS_INCOMPLETE",
): FundingServiceError {
  switch (reason) {
    case "DEAL_NOT_FOUND":
      return new FundingServiceError("Deal not found.", "BG6_DEAL_NOT_FOUND");
    case "DEAL_NOT_NEGOTIATING":
      return new FundingServiceError(
        "Funding may only be requested for a Negotiating Deal.",
        "BG6_DEAL_NOT_NEGOTIATING",
      );
    case "TERMS_VERSION_NOT_FOUND":
    case "TERMS_VERSION_NOT_CURRENT":
      return new FundingServiceError(
        "The current TermsVersion has been replaced; refresh and retry.",
        "BG6_TERMS_VERSION_NOT_CURRENT",
      );
    case "NOT_BUYER_SIDE":
    case "NOT_A_MEMBER":
    case "WORKSPACE_INELIGIBLE":
      return new FundingServiceError(
        "You are not authorized to fund this Deal.",
        "BG6_FUNDING_FORBIDDEN",
      );
    case "SELLER_NOT_CONSENTED":
      return new FundingServiceError(
        "The seller has not consented to this Deal.",
        "BG6_FUNDING_FORBIDDEN",
      );
    case "APPROVALS_INCOMPLETE":
      return new FundingServiceError(
        "Both parties must approve the current TermsVersion before funding.",
        "BG6_APPROVALS_INCOMPLETE",
      );
  }
}

function preauthVerdictToFundRepoReason(
  reason:
    | "DEAL_NOT_FOUND"
    | "DEAL_NOT_NEGOTIATING"
    | "TERMS_VERSION_NOT_FOUND"
    | "TERMS_VERSION_NOT_CURRENT"
    | "NOT_BUYER_SIDE"
    | "NOT_A_MEMBER"
    | "WORKSPACE_INELIGIBLE"
    | "SELLER_NOT_CONSENTED"
    | "APPROVALS_INCOMPLETE",
):
  | "DEAL_NOT_FOUND"
  | "DEAL_NOT_NEGOTIATING"
  | "TERMS_VERSION_NOT_FOUND"
  | "TERMS_VERSION_NOT_CURRENT"
  | "NOT_BUYER_SIDE"
  | "NOT_A_MEMBER"
  | "WORKSPACE_INELIGIBLE"
  | "SELLER_NOT_CONSENTED"
  | "APPROVALS_INCOMPLETE" {
  return reason;
}

function fundRepoFailureToServiceError(
  reason:
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
    | "CONCURRENCY_RETRY_EXHAUSTED",
): FundingServiceError {
  switch (reason) {
    case "DEAL_NOT_FOUND":
      return new FundingServiceError("Deal not found.", "BG6_DEAL_NOT_FOUND");
    case "DEAL_NOT_NEGOTIATING":
      return new FundingServiceError(
        "Funding may only be requested for a Negotiating Deal.",
        "BG6_DEAL_NOT_NEGOTIATING",
      );
    case "TERMS_VERSION_NOT_FOUND":
    case "TERMS_VERSION_NOT_CURRENT":
      return new FundingServiceError(
        "The current TermsVersion has been replaced; refresh and retry.",
        "BG6_TERMS_VERSION_NOT_CURRENT",
      );
    case "NOT_BUYER_SIDE":
    case "NOT_A_MEMBER":
    case "WORKSPACE_INELIGIBLE":
    case "SELLER_NOT_CONSENTED":
      return new FundingServiceError(
        "You are not authorized to fund this Deal.",
        "BG6_FUNDING_FORBIDDEN",
      );
    case "APPROVALS_INCOMPLETE":
      return new FundingServiceError(
        "Both parties must approve the current TermsVersion before funding.",
        "BG6_APPROVALS_INCOMPLETE",
      );
    case "CONFIRMATION_AMOUNT_MISMATCH":
    case "CONFIRMATION_CURRENCY_MISMATCH":
    case "CONFIRMATION_TERMS_VERSION_MISMATCH":
      return new FundingServiceError(
        "The provider confirmation did not match the locked TermsVersion snapshot.",
        "BG6_FUNDING_CONFIRMATION_MISMATCH",
      );
    case "DEAL_ALREADY_ACTIVE":
      return new FundingServiceError("The Deal is already Active.", "BG6_DEAL_ALREADY_ACTIVE");
    case "PAYMENT_INTENT_NOT_FOUND":
      return new FundingServiceError("PaymentIntent not found.", "BG6_DEAL_NOT_FOUND");
    case "PAYMENT_INTENT_NOT_CONFIRMED":
      return new FundingServiceError(
        "The PaymentIntent is not yet confirmed by the provider.",
        "BG6_FUNDING_INTERNAL_FAILED",
      );
    case "CONCURRENCY_RETRY_EXHAUSTED":
      return new FundingServiceError(
        "The marketplace is busy; please retry.",
        "BG6_FUNDING_INTERNAL_FAILED",
      );
  }
}

function mismatchReasonToCode(
  reason:
    | "CONFIRMATION_AMOUNT_MISMATCH"
    | "CONFIRMATION_CURRENCY_MISMATCH"
    | "CONFIRMATION_TERMS_VERSION_MISMATCH",
):
  | "EscrowProviderUnavailable"
  | "EscrowConfirmationAmountMismatch"
  | "EscrowConfirmationCurrencyMismatch"
  | "EscrowConfirmationVersionMismatch" {
  switch (reason) {
    case "CONFIRMATION_AMOUNT_MISMATCH":
      return "EscrowConfirmationAmountMismatch";
    case "CONFIRMATION_CURRENCY_MISMATCH":
      return "EscrowConfirmationCurrencyMismatch";
    case "CONFIRMATION_TERMS_VERSION_MISMATCH":
      return "EscrowConfirmationVersionMismatch";
  }
}

/**
 * Map a persisted PaymentIntent + the locked snapshot's CURRENT
 * version number into the minimal public funding-status DTO. This
 * function is the SOLE allow-list boundary; internal identifiers
 * (paymentIntentId, correlationId, raw providerReference, raw
 * failureDetail) never reach the returned shape.
 */
export function toPublicFundingStatus(
  intent: PersistedPaymentIntent,
  termsVersionNumber: number,
  failureReason: string | null,
): Bg6FundingConfirmationPublicV1 {
  const status: Bg6PublicFundingStatusV1 =
    intent.providerState === "Confirmed"
      ? "Confirmed"
      : intent.providerState === "Failed"
        ? "Failed"
        : "AwaitingConfirmation";
  return {
    status,
    expectedAmount: {
      amountMinor: intent.expectedAmountMinor,
      currency: "USD" as const,
    },
    confirmedAmount:
      intent.providerState === "Confirmed" && intent.confirmedAt
        ? { amountMinor: intent.expectedAmountMinor, currency: "USD" as const }
        : null,
    providerKey: "mock-escrow-deterministic",
    assetLabel: SANDBOX_ASSET_LABEL,
    networkLabel: SANDBOX_NETWORK_LABEL,
    environmentLabel: SANDBOX_ENVIRONMENT_LABEL,
    confirmationTime: intent.confirmedAt ? intent.confirmedAt.toISOString() : null,
    sanitizedFailureReason:
      intent.providerState === "Failed" && intent.failureReasonCode
        ? (intent.failureReasonCode as Bg6FundingConfirmationPublicV1["sanitizedFailureReason"])
        : null,
    sandboxSimulatedBadge: true,
  };
}
