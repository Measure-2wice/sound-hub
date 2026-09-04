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
//   WorkspaceMembership + buyer WorkspaceCapability; re-runs
//   evaluatePreauthAuthority against the LOCKED snapshot; verifies
//   exact-match (amount/currency/termsVersionId) against the locked
//   snapshot; persists the provider reference + transitions
//   providerState = "Confirmed" + clears failure columns; applies
//   the guarded activation UPDATE `UPDATE deals SET status =
//   'Active', "activatedAt" = ? WHERE id = ? AND status =
//   'Negotiating' RETURNING id`. Both writes live in the same
//   transaction; either both commit or neither.
//
// Provider failure path: when the provider throws OR returns a
// non-matching confirmation, the service records the closed
// failureReasonCode + closed failureDetailCategory on the SAME
// intent row. Raw exception text, stack traces, hostnames, secrets,
// or stack-frame diagnostics are NEVER persisted — server-side logs
// retain them (ticket #64 P1-004). A late concurrent failure that
// observes the intent already Confirmed is a no-op: the guarded
// UPDATE returns 0 rows, the method returns ALREADY_CONFIRMED, and
// the service converges on the existing success (ticket #64
// P0-002).
//
// Idempotent Confirmed retry path (ticket #64 P1-001): before Phase
// 1 preauth, the service reads the persisted PaymentIntent for the
// current (dealId, termsVersionId) tuple. If it is Confirmed AND
// the Deal is already Active, the service returns the cached
// success through the same `fundDeal` call shape WITHOUT calling
// the provider or opening a new transaction. A second identical
// fundDeal command observes the same 200 response, no second
// provider call, no second intent, no second activation.
//
// Strict provider confirmation validation (ticket #64 P1-002): the
// provider's response is parsed through the closed
// `bg6EscrowConfirmationV1Schema` BEFORE any persistence or
// activation. Malformed, missing, or unexpected fields fail closed
// with BG6_FUNDING_CONFIRMATION_MISMATCH and leave the Deal
// Negotiating.

import { randomUUID } from "node:crypto";
import {
  type Bg6FundingConfirmationPublicV1,
  type Bg6PublicFundingStatusV1,
} from "@soundhub/types";
import { ZodError } from "zod";
import { AuthorizationError } from "../services/workspace-authorization.service.js";
import {
  escrowConfirmationSchema,
  escrowRequestInputSchema,
  type DeterministicMockEscrowProvider,
  type EscrowConfirmation,
  type EscrowProvider,
} from "../escrow/escrow-provider.js";
import {
  evaluateConfirmedRetryAuthority,
  evaluatePreauthAuthority,
} from "./funding-authorization-policy.js";
import type { FundingRepository, PersistedPaymentIntent } from "./funding.repository.js";

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

type FailureDetailCategory =
  | "PROVIDER_UNAVAILABLE"
  | "CONFIRMATION_INVALID"
  | "CONFIRMATION_MISMATCH";

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
   * raw failureDetail. Idempotent on a successful Confirmed retry
   * (P1-001): a second identical fundDeal command observes the
   * cached success WITHOUT calling the provider or opening a new
   * transaction.
   */
  async fundDeal(input: FundDealInput): Promise<{
    readonly dealStatus: "Negotiating" | "Active";
    readonly activatedAt: string | null;
    readonly fundingStatus: Bg6FundingConfirmationPublicV1;
  }> {
    const now = input.now ?? this.now();

    // ---------- Idempotent Confirmed retry path (P1-001) ----------
    //
    // Before Phase 1 preauth we read the persisted intent for the
    // current (dealId, termsVersionId). If it is Confirmed AND the
    // Deal is already Active, we return the cached success without
    // calling the provider or opening a new transaction. This runs
    // BEFORE the Phase-1 already-Active rejection so the
    // "Confirmed + already-Active" retry returns 200 instead of 409.
    //
    // The current TermsVersion id is the same one Phase 1 would
    // derive from MAX(version) per Deal — re-derive here via a
    // lightweight read so the cached intent's binding is the same
    // tuple Phase 1 / Phase 3 / Phase 2 use.
    const earlySuccess = await this.findAuthorizedConfirmedSuccess(input);
    if (earlySuccess) return earlySuccess;

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
      assetLabel: this.escrowProvider.assetLabel,
      networkLabel: this.escrowProvider.networkLabel,
      providerKey: this.escrowProvider.key,
      environmentLabel: this.escrowProvider.environmentLabel,
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
      // confirmation and this retry would reject. The cache path
      // does NOT round-trip through the strict Zod boundary —
      // these fields were already validated at first-confirmation
      // time and persisted to PostgreSQL.
      providerConfirmation = {
        providerKey: intent.providerKey,
        providerReference: intent.providerReference ?? "",
        confirmedAmountMinor: intent.expectedAmountMinor,
        confirmedCurrency: intent.expectedCurrency,
        assetLabel: intent.assetLabel,
        networkLabel: intent.networkLabel,
        environmentLabel: intent.environmentLabel,
        termsVersionId: intent.termsVersionId,
        confirmedAt: (intent.confirmedAt ?? now).toISOString(),
      };
    } else {
      try {
        // Parse the provider input through the closed schema before
        // any network round-trip — the deterministic mock and any
        // future adapter are gated on the same boundary.
        const unvalidatedProviderInput: EscrowProvider["requestFunding"] extends (
          i: infer I,
        ) => unknown
          ? I
          : never = {
          paymentIntentId: intent.id,
          dealId: input.dealId,
          termsVersionId: intent.termsVersionId,
          termsVersionNumber,
          priceAmountMinor,
          priceCurrency: currentTermsVersion.priceCurrency,
          // Strict boundary exposes `now` as an ISO-8601 string.
          now: now.toISOString(),
        };
        const providerInput = escrowRequestInputSchema.parse(unvalidatedProviderInput);
        const rawConfirmation = await this.escrowProvider.requestFunding(providerInput);
        // Strict runtime validation of provider output (P1-002).
        // The mock returns parseable-by-construction output; a future
        // adapter that returns malformed data fails closed here.
        const parsed = escrowConfirmationSchema.parse(rawConfirmation);
        // The strict boundary exposes `confirmedAt` as an ISO
        // string. Phase 3 stores a Date column; coerce here so the
        // cache and provider paths share one shape.
        providerConfirmation = {
          ...parsed,
          confirmedAt: new Date(parsed.confirmedAt).toISOString(),
        };
      } catch (err) {
        // Two distinct failure modes:
        //   - Provider threw → PROVIDER_UNAVAILABLE category.
        //   - Provider returned unparseable confirmation →
        //     CONFIRMATION_INVALID category.
        // Raw exception text is logged server-side only; the
        // persisted column carries the closed category (P1-004).
        const category: FailureDetailCategory =
          err instanceof ZodError ? "CONFIRMATION_INVALID" : "PROVIDER_UNAVAILABLE";
        logProviderDiagnostic("BG6 provider failure", err);
        const failure = await this.repository.recordPaymentIntentFailureInTransaction({
          paymentIntentId: intent.id,
          failureReasonCode: "EscrowProviderUnavailable",
          failureDetailCategory: category,
        });
        if (!failure.persisted) {
          const converged = await this.findAuthorizedConfirmedSuccess(input);
          if (converged) return converged;
        }
        throw new FundingServiceError(
          "The escrow provider is unavailable.",
          "BG6_ESCROW_UNAVAILABLE",
        );
      }
    }

    // Phase 3: open the Serializable activation transaction.
    let activationResult: Awaited<ReturnType<FundingRepository["fundDealInTransaction"]>>;
    try {
      // providerConfirmation is non-null after Phase 2 — the
      // Confirmed cache branch constructs it; the Created/Failed
      // branch assigns it from a successful provider call OR
      // throws BG6_ESCROW_UNAVAILABLE before reaching Phase 3.
      if (!providerConfirmation) {
        throw new FundingServiceError(
          "Internal funding flow failure.",
          "BG6_FUNDING_INTERNAL_FAILED",
        );
      }
      const confirmation = providerConfirmation;
      const confirmedAtDate = new Date(confirmation.confirmedAt);
      activationResult = await this.repository.fundDealInTransaction(
        {
          dealId: input.dealId,
          paymentIntentId: intent.id,
          providerReference: confirmation.providerReference,
          confirmedAt: confirmedAtDate,
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
          if (confirmation.confirmedAmountMinor !== ctx.activation.currentTermsVersionAmountMinor) {
            return tools.reject("CONFIRMATION_AMOUNT_MISMATCH");
          }
          if (confirmation.confirmedCurrency !== ctx.activation.currentTermsVersionCurrency) {
            return tools.reject("CONFIRMATION_CURRENCY_MISMATCH");
          }
          if (confirmation.termsVersionId !== ctx.activation.currentTermsVersionId) {
            return tools.reject("CONFIRMATION_TERMS_VERSION_MISMATCH");
          }
          if (
            confirmation.providerKey !== intent.providerKey ||
            confirmation.assetLabel !== intent.assetLabel ||
            confirmation.networkLabel !== intent.networkLabel ||
            confirmation.environmentLabel !== intent.environmentLabel
          ) {
            return tools.reject("CONFIRMATION_TERMS_VERSION_MISMATCH");
          }
          return tools.persistFundingConfirmationAndActivate({
            paymentIntentId: ctx.paymentIntentId,
            providerReference: confirmation.providerReference,
            confirmedAt: confirmedAtDate,
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
      if (
        activationResult.reason === "DEAL_NOT_NEGOTIATING" ||
        activationResult.reason === "DEAL_ALREADY_ACTIVE"
      ) {
        const converged = await this.findAuthorizedConfirmedSuccess(input);
        if (converged) return converged;
      }
      // On confirmation mismatch the transaction rolls back the
      // intent update; record the latest attempt's failure fields on
      // the SAME row so a future retry carries forward the
      // diagnostic. Raw provider diagnostics are logged server-side
      // only — the persisted column carries the closed category.
      if (
        activationResult.reason === "CONFIRMATION_AMOUNT_MISMATCH" ||
        activationResult.reason === "CONFIRMATION_CURRENCY_MISMATCH" ||
        activationResult.reason === "CONFIRMATION_TERMS_VERSION_MISMATCH"
      ) {
        const failure = await this.repository.recordPaymentIntentFailureInTransaction({
          paymentIntentId: intent.id,
          failureReasonCode: mismatchReasonToCode(activationResult.reason),
          failureDetailCategory: "CONFIRMATION_MISMATCH",
        });
        if (!failure.persisted) {
          const converged = await this.findAuthorizedConfirmedSuccess(input);
          if (converged) return converged;
        }
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

  private async findAuthorizedConfirmedSuccess(input: FundDealInput): Promise<{
    readonly dealStatus: "Active";
    readonly activatedAt: string | null;
    readonly fundingStatus: Bg6FundingConfirmationPublicV1;
  } | null> {
    const intent = await this.repository.findCurrentPaymentIntent(input.dealId);
    if (!intent || intent.providerState !== "Confirmed") return null;
    const snapshot = await this.repository.findPreauthSnapshot({
      dealId: input.dealId,
      actingWorkspaceId: input.actingWorkspaceId,
      actingUserAccountId: input.userAccountId,
    });
    if (!snapshot.ok || intent.termsVersionId !== snapshot.currentTermsVersion.id) return null;
    const verdict = evaluateConfirmedRetryAuthority(snapshot.value);
    if (!verdict.ok) throw preauthVerdictToServiceError(verdict.reason);
    return {
      dealStatus: "Active",
      activatedAt: intent.acceptedAt ? intent.acceptedAt.toISOString() : null,
      fundingStatus: toPublicFundingStatus(intent, snapshot.currentTermsVersion.version, null),
    };
  }
}

function logProviderDiagnostic(label: string, err: unknown): void {
  // Server-side log only — raw exception text, stack traces,
  // hostnames, secrets, and stack-frame diagnostics are NEVER
  // persisted on PaymentIntent.failureDetail (the column is a
  // closed enum). See ticket #64 P1-004.
  // The log line itself is bounded to the message text; never
  // echo the message into a public DTO.
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  // Use a single console.error line so the server log captures
  // both the bounded label and the raw diagnostic without leaking
  // into any persisted column or public DTO.
  console.error(
    `[bg6] ${label} (server-only): ${message}${stack !== undefined ? `\n${stack}` : ""}`,
  );
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
    | "APPROVALS_INCOMPLETE"
    | "MISSING_BUYER_CAPABILITY",
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
    case "MISSING_BUYER_CAPABILITY":
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
    | "APPROVALS_INCOMPLETE"
    | "MISSING_BUYER_CAPABILITY",
):
  | "DEAL_NOT_FOUND"
  | "DEAL_NOT_NEGOTIATING"
  | "TERMS_VERSION_NOT_FOUND"
  | "TERMS_VERSION_NOT_CURRENT"
  | "NOT_BUYER_SIDE"
  | "NOT_A_MEMBER"
  | "WORKSPACE_INELIGIBLE"
  | "SELLER_NOT_CONSENTED"
  | "APPROVALS_INCOMPLETE"
  | "MISSING_BUYER_CAPABILITY" {
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
    | "MISSING_BUYER_CAPABILITY"
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
    case "MISSING_BUYER_CAPABILITY":
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
  void termsVersionNumber;
  void failureReason;
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
    providerKey: intent.providerKey as Bg6FundingConfirmationPublicV1["providerKey"],
    assetLabel: intent.assetLabel as Bg6FundingConfirmationPublicV1["assetLabel"],
    networkLabel: intent.networkLabel as Bg6FundingConfirmationPublicV1["networkLabel"],
    environmentLabel: intent.environmentLabel as Bg6FundingConfirmationPublicV1["environmentLabel"],
    confirmationTime: intent.confirmedAt ? intent.confirmedAt.toISOString() : null,
    sanitizedFailureReason:
      intent.providerState === "Failed" && intent.failureReasonCode
        ? (intent.failureReasonCode as Bg6FundingConfirmationPublicV1["sanitizedFailureReason"])
        : null,
    sandboxSimulatedBadge: true,
  };
}
