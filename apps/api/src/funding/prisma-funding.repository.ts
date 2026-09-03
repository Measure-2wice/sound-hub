// Prisma adapter for FundingRepository.
//
// Background: this module is the only place the BG6 PaymentIntent +
// activation boundary touches Prisma. Higher layers depend on
// `FundingRepository`; tests can swap in the in-memory adapter
// without changing the service or route code.
//
// Architectural split:
//
//   - The application owns the authorization policy (see
//     `./funding-authorization-policy.ts`). Two pure evaluators
//     (`evaluatePreauthAuthority` for Phase 1 + Phase 3 revalidation,
//     and `evaluateActivationAuthority` for the GS-25 invariant) live
//     there and are invoked by the service's use-case closures.
//
//   - The repository owns the transaction boundary and the
//     locked-fact reads. The four transaction methods each open a
//     `$transaction` (Serializable for the main two; the failure
//     recorder is a short tx) and acquire `SELECT ... FOR UPDATE`
//     row locks on every row the policy depends on, then hand the
//     assembled snapshot to the application-supplied use case. The
//     use case evaluates the policy and returns either a
//     `persist*` or a `reject`. The repository persists only when
//     the use case persists; the transaction rolls back on any
//     rejection.
//
//   - The Prisma adapter never decides whether the facts authorize
//     the command. The application-owned policy is the only
//     decision point.
//
// Phase 2 deterministic convergence: the repository locks the parent
// `terms_versions` row FIRST (FOR UPDATE on `id = termsVersionId`)
// inside `findOrCreatePaymentIntentInTransaction`. FOR UPDATE on a
// row that does not yet exist cannot serialize concurrent inserts;
// the parent TermsVersion row is stable (immutable append-only per
// ADR 0005) and every concurrent `findOrCreate` for the SAME
// `(dealId, termsVersionId)` tuple must wait for the same parent
// row lock — naturally serializing the find-or-create decision.
// Inside the parent-row lock the repository re-reads
// `payment_intents` by `(dealId, termsVersionId)` and either returns
// the existing row or INSERTs a new one. A P2002 collision is caught
// and re-reads the winning row as defense-in-depth.
//
// Phase 3 transaction: opens a Serializable $transaction, FOR
// UPDATE-locks the PaymentIntent + Deal + TermsVersion + both
// DealApprovals + ProjectRequest + acting Workspace +
// WorkspaceMembership, hands the locked snapshot to the use case.
// On `persistFundingConfirmationAndActivate`, the repository:
//   - `tx.paymentIntent.update` to transition the intent to
//     `providerState = "Confirmed"`, persist `providerReference` +
//     `confirmedAt` + `acceptedAt`, and clear the failure columns.
//   - raw guarded `UPDATE deals SET status = 'Active', "activatedAt"
//     = ? WHERE id = ? AND status = 'Negotiating' RETURNING id`.
//     `RETURNING` 0 rows => `DEAL_ALREADY_ACTIVE`.
//
// All four transactional methods retry on P2034 (serialization
// conflict) up to a bounded budget (3 attempts). After the budget
// is exhausted the adapter surfaces `CONCURRENCY_RETRY_EXHAUSTED`
// so the route layer maps it onto `BG6_FUNDING_INTERNAL_FAILED`.

import type { PrismaClient } from "@soundhub/db";
import { PrismaClientKnownRequestError } from "@soundhub/db/dist/generated/internal/prismaNamespace.js";
import type {
  ActivationAuthoritySnapshot,
  PreauthAuthoritySnapshot,
} from "./funding-authorization-policy.js";
import type {
  FindOrCreatePaymentIntentInput,
  FindOrCreatePaymentIntentResult,
  FindPreauthInput,
  FindPreauthResult,
  FundDealFailureReason,
  FundDealResult,
  FundDealTransactionInput,
  FundDealUseCase,
  FundDealUseCaseTools,
  FundingRepository,
  PersistedDealSummaryForFunding,
  PersistedPaymentIntent,
  RecordPaymentIntentFailureInput,
} from "./funding.repository.js";

// Small fixed maximum. Mirrors the BG4 retry budget; not a generalized
// framework — it exists only because PostgreSQL's Serializable
// isolation surfaces a write conflict (P2034) when the transaction's
// snapshot is invalidated by a concurrent committed write that
// touched a row the transaction read.
const P2034_RETRY_BUDGET = 3;

const CONCURRENCY_RETRY_EXHAUSTED: FundDealFailureReason = "CONCURRENCY_RETRY_EXHAUSTED";

function isSerializationConflict(err: unknown): boolean {
  if (err instanceof PrismaClientKnownRequestError) {
    if (err.code === "P2034" || err.code === "40001" || err.code === "40P01") return true;
  }
  if (
    err instanceof Error &&
    /40001|serialization_failure|write conflict|P2034/i.test(err.message)
  ) {
    return true;
  }
  return false;
}

interface BoundedRetryEnvelope<TValue> {
  readonly outcome:
    | { readonly kind: "value"; readonly value: TValue }
    | { readonly kind: "exhausted" };
}
async function runWithBoundedP2034Retry<TValue>(
  attempt: () => Promise<TValue>,
): Promise<BoundedRetryEnvelope<TValue>> {
  for (let i = 0; i < P2034_RETRY_BUDGET; i += 1) {
    try {
      return { outcome: { kind: "value", value: await attempt() } };
    } catch (err) {
      if (!isSerializationConflict(err)) throw err;
    }
  }
  return { outcome: { kind: "exhausted" } };
}

export class PrismaFundingRepository implements FundingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------- findPreauthSnapshot ----------

  async findPreauthSnapshot(input: FindPreauthInput): Promise<FindPreauthResult> {
    const deal = await this.prisma.deal.findUnique({
      where: { id: input.dealId },
      select: {
        id: true,
        buyerWorkspaceId: true,
        sellerWorkspaceId: true,
        status: true,
        projectRequestId: true,
      },
    });
    if (!deal) {
      return { ok: false, reason: "DEAL_NOT_FOUND" };
    }
    const versions = await this.prisma.termsVersion.findMany({
      where: { dealId: input.dealId },
      select: {
        id: true,
        dealId: true,
        version: true,
        priceAmountMinor: true,
        priceCurrency: true,
      },
      orderBy: { version: "desc" },
      take: 1,
    });
    const current = versions[0];
    if (!current) {
      return { ok: false, reason: "CURRENT_TERMS_VERSION_NOT_FOUND" };
    }
    const projectRequest = await this.prisma.projectRequest.findUnique({
      where: { id: deal.projectRequestId },
      select: { status: true, sellerConsentAt: true },
    });
    if (!projectRequest) {
      return { ok: false, reason: "PROJECT_REQUEST_NOT_FOUND" };
    }
    const memberRows = await this.prisma.$queryRaw<{ readonly status: "Active" | "Suspended" }[]>`
      SELECT w.status
      FROM workspace_memberships m
      JOIN workspaces w ON w.id = m."workspaceId"
      WHERE m."userId" = ${input.actingUserAccountId}
        AND m."workspaceId" = ${input.actingWorkspaceId}
    `;
    const member = memberRows[0];
    const approvals = await this.prisma.dealApproval.findMany({
      where: { termsVersionId: current.id },
      select: { workspaceId: true },
    });
    let buyerApproval = false;
    let sellerApproval = false;
    for (const approval of approvals) {
      if (approval.workspaceId === deal.buyerWorkspaceId) buyerApproval = true;
      else if (approval.workspaceId === deal.sellerWorkspaceId) sellerApproval = true;
    }
    const snapshot: PreauthAuthoritySnapshot = {
      dealId: deal.id,
      dealStatus: deal.status,
      buyerWorkspaceId: deal.buyerWorkspaceId,
      sellerWorkspaceId: deal.sellerWorkspaceId,
      actingWorkspaceId: input.actingWorkspaceId,
      actingWorkspaceStatus: member?.status ?? "Suspended",
      actingUserIsMember: member !== undefined,
      currentTermsVersionId: current.id,
      currentTermsVersionDealId: current.dealId,
      projectRequestStatus: projectRequest.status,
      projectRequestSellerConsentAt: projectRequest.sellerConsentAt,
      buyerApprovalExists: buyerApproval,
      sellerApprovalExists: sellerApproval,
    };
    return {
      ok: true,
      value: snapshot,
      currentTermsVersion: {
        id: current.id,
        version: current.version,
        priceAmountMinor: current.priceAmountMinor,
        priceCurrency: current.priceCurrency,
      },
    };
  }

  // ---------- findOrCreatePaymentIntentInTransaction ----------

  async findOrCreatePaymentIntentInTransaction(
    input: FindOrCreatePaymentIntentInput,
  ): Promise<FindOrCreatePaymentIntentResult> {
    const envelope = await runWithBoundedP2034Retry(() => this.runFindOrCreateTx(input));
    if (envelope.outcome.kind === "exhausted") {
      // A Failed retry budget on this short tx should be vanishingly
      // rare; surface as a NOT_FOUND so the service can map to a
      // safe envelope rather than the activation-specific
      // CONCURRENCY_RETRY_EXHAUSTED.
      return { ok: false, reason: "TERMS_VERSION_NOT_FOUND" };
    }
    return envelope.outcome.value;
  }

  private async runFindOrCreateTx(
    input: FindOrCreatePaymentIntentInput,
  ): Promise<FindOrCreatePaymentIntentResult> {
    return this.prisma.$transaction(
      async (tx) => {
        // Step 1: lock the parent TermsVersion row (immutable
        // append-only per ADR 0005). Every concurrent find-or-create
        // for the same (dealId, termsVersionId) serializes here.
        const tvRows = await tx.$queryRaw<{ readonly id: string; readonly dealId: string }[]>`
          SELECT id, "dealId" FROM terms_versions WHERE id = ${input.termsVersionId} FOR UPDATE
        `;
        const tvRow = tvRows[0];
        if (!tvRow || tvRow.dealId !== input.dealId) {
          return {
            ok: false as const,
            reason: "TERMS_VERSION_NOT_FOUND" as const,
          };
        }
        // Step 2: re-read by (dealId, termsVersionId).
        const existing = await tx.paymentIntent.findUnique({
          where: {
            dealId_termsVersionId: {
              dealId: input.dealId,
              termsVersionId: input.termsVersionId,
            },
          },
        });
        if (existing) {
          return { ok: true as const, value: toPersistedPaymentIntent(existing) };
        }
        // Step 3: INSERT a new row with providerState = "Created".
        try {
          const created = await tx.paymentIntent.create({
            data: {
              dealId: input.dealId,
              termsVersionId: input.termsVersionId,
              actingWorkspaceId: input.actingWorkspaceId,
              createdByUserId: input.createdByUserId,
              expectedAmountMinor: input.expectedAmountMinor,
              expectedCurrency: input.expectedCurrency,
              assetLabel: input.assetLabel,
              networkLabel: input.networkLabel,
              providerKey: input.providerKey,
              environmentLabel: input.environmentLabel,
              correlationId: input.correlationId,
              providerState: "Created",
            },
          });
          return { ok: true as const, value: toPersistedPaymentIntent(created) };
        } catch (err) {
          if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
            // Defense-in-depth: re-read the winning row.
            const winner = await tx.paymentIntent.findUniqueOrThrow({
              where: {
                dealId_termsVersionId: {
                  dealId: input.dealId,
                  termsVersionId: input.termsVersionId,
                },
              },
            });
            return { ok: true as const, value: toPersistedPaymentIntent(winner) };
          }
          throw err;
        }
      },
      { isolationLevel: "Serializable" },
    );
  }

  // ---------- recordPaymentIntentFailureInTransaction ----------

  async recordPaymentIntentFailureInTransaction(
    input: RecordPaymentIntentFailureInput,
  ): Promise<void> {
    await this.prisma.paymentIntent.update({
      where: { id: input.paymentIntentId },
      data: {
        providerState: "Failed",
        failureReasonCode: input.failureReasonCode,
        failureDetail: input.failureDetail,
      },
    });
  }

  // ---------- fundDealInTransaction ----------

  async fundDealInTransaction(
    input: FundDealTransactionInput,
    useCase: FundDealUseCase,
  ): Promise<FundDealResult> {
    const envelope = await runWithBoundedP2034Retry(() => this.runFundDealTx(input, useCase));
    if (envelope.outcome.kind === "exhausted") {
      return { ok: false, reason: CONCURRENCY_RETRY_EXHAUSTED };
    }
    return envelope.outcome.value;
  }

  private async runFundDealTx(
    input: FundDealTransactionInput,
    useCase: FundDealUseCase,
  ): Promise<FundDealResult> {
    return this.prisma.$transaction(
      async (tx) => {
        // Step 1: FOR UPDATE-lock the PaymentIntent row.
        const intentRows = await tx.$queryRaw<
          {
            readonly id: string;
            readonly dealId: string;
            readonly termsVersionId: string;
            readonly providerState: "Created" | "Confirmed" | "Failed";
            readonly expectedAmountMinor: number;
            readonly expectedCurrency: string;
          }[]
        >`SELECT id, "dealId", "termsVersionId", "providerState", "expectedAmountMinor", "expectedCurrency" FROM payment_intents WHERE id = ${input.paymentIntentId} FOR UPDATE`;
        const intentRow = intentRows[0];
        if (!intentRow) {
          return {
            ok: false as const,
            reason: "PAYMENT_INTENT_NOT_FOUND" as FundDealFailureReason,
          };
        }
        if (intentRow.dealId !== input.dealId) {
          return {
            ok: false as const,
            reason: "DEAL_NOT_FOUND" as FundDealFailureReason,
          };
        }
        // Step 2: FOR UPDATE-lock the Deal row.
        const dealRows = await tx.$queryRaw<
          {
            readonly id: string;
            readonly buyerWorkspaceId: string;
            readonly sellerWorkspaceId: string;
            readonly status: "Negotiating" | "Active";
            readonly projectRequestId: string;
          }[]
        >`SELECT id, "buyerWorkspaceId", "sellerWorkspaceId", status, "projectRequestId" FROM deals WHERE id = ${input.dealId} FOR UPDATE`;
        const dealRow = dealRows[0];
        if (!dealRow) {
          return {
            ok: false as const,
            reason: "DEAL_NOT_FOUND" as FundDealFailureReason,
          };
        }
        // Step 3: FOR UPDATE-lock the TermsVersion row + verify it's
        // the CURRENT version for this Deal.
        const tvRows = await tx.$queryRaw<
          {
            readonly id: string;
            readonly dealId: string;
            readonly version: number;
            readonly priceAmountMinor: number;
            readonly priceCurrency: string;
          }[]
        >`SELECT id, "dealId", version, "priceAmountMinor", "priceCurrency" FROM terms_versions WHERE id = ${intentRow.termsVersionId} FOR UPDATE`;
        const tvRow = tvRows[0];
        if (!tvRow || tvRow.dealId !== input.dealId) {
          return {
            ok: false as const,
            reason: "TERMS_VERSION_NOT_FOUND" as FundDealFailureReason,
          };
        }
        const currentVersionRows = await tx.$queryRaw<{ readonly id: string }[]>`
          SELECT id FROM terms_versions WHERE "dealId" = ${input.dealId} ORDER BY version DESC LIMIT 1
        `;
        const currentVersionId = currentVersionRows[0]?.id;
        if (!currentVersionId || currentVersionId !== intentRow.termsVersionId) {
          return {
            ok: false as const,
            reason: "TERMS_VERSION_NOT_CURRENT" as FundDealFailureReason,
          };
        }
        // Step 4: lock the ProjectRequest row via the Deal's
        // projectRequestId (no scalar dealId column on ProjectRequest).
        const prRows = await tx.$queryRaw<
          {
            readonly status: "Pending" | "Accepted" | "Declined";
            readonly sellerConsentAt: Date | null;
          }[]
        >`SELECT status, "sellerConsentAt" FROM project_requests WHERE id = ${dealRow.projectRequestId} FOR UPDATE`;
        const prRow = prRows[0];
        if (!prRow) {
          return {
            ok: false as const,
            reason: "SELLER_NOT_CONSENTED" as FundDealFailureReason,
          };
        }
        // Step 5: lock acting WorkspaceMembership + acting Workspace.
        const memberRows = await tx.$queryRaw<{ readonly status: "Active" | "Suspended" }[]>`
          SELECT w.status
          FROM workspace_memberships m
          JOIN workspaces w ON w.id = m."workspaceId"
          WHERE m."userId" = ${input.actingUserAccountId}
            AND m."workspaceId" = ${input.actingWorkspaceId}
          FOR UPDATE OF w, m
        `;
        const memberRow = memberRows[0];
        // Step 6: read both DealApprovals for the current TermsVersion.
        const approvals = await tx.dealApproval.findMany({
          where: { termsVersionId: currentVersionId },
          select: { workspaceId: true },
        });
        let buyerApproval = false;
        let sellerApproval = false;
        for (const approval of approvals) {
          if (approval.workspaceId === dealRow.buyerWorkspaceId) buyerApproval = true;
          else if (approval.workspaceId === dealRow.sellerWorkspaceId) sellerApproval = true;
        }
        const preauth: PreauthAuthoritySnapshot = {
          dealId: dealRow.id,
          dealStatus: dealRow.status,
          buyerWorkspaceId: dealRow.buyerWorkspaceId,
          sellerWorkspaceId: dealRow.sellerWorkspaceId,
          actingWorkspaceId: input.actingWorkspaceId,
          actingWorkspaceStatus: memberRow?.status ?? "Suspended",
          actingUserIsMember: memberRow !== undefined,
          currentTermsVersionId: currentVersionId,
          currentTermsVersionDealId: tvRow.dealId,
          projectRequestStatus: prRow.status,
          projectRequestSellerConsentAt: prRow.sellerConsentAt,
          buyerApprovalExists: buyerApproval,
          sellerApprovalExists: sellerApproval,
        };
        const activation: ActivationAuthoritySnapshot = {
          projectRequestSellerConsentAt: prRow.sellerConsentAt,
          buyerApprovalExists: buyerApproval,
          sellerApprovalExists: sellerApproval,
          fundingConfirmedAmountMinor: intentRow.expectedAmountMinor,
          fundingConfirmedCurrency: intentRow.expectedCurrency,
          fundingTermsVersionId: intentRow.termsVersionId,
          currentTermsVersionId: currentVersionId,
          currentTermsVersionAmountMinor: tvRow.priceAmountMinor,
          currentTermsVersionCurrency: tvRow.priceCurrency,
        };
        const tools: FundDealUseCaseTools = {
          reject: (reason): { kind: "reject"; reason: FundDealFailureReason } => ({
            kind: "reject",
            reason,
          }),
          persistFundingConfirmationAndActivate: (persistInput) => ({
            kind: "persist",
            input: persistInput,
          }),
        };
        const outcome = useCase(
          {
            preauth,
            activation,
            paymentIntentId: intentRow.id,
          },
          tools,
        );
        if (outcome.kind === "reject") {
          return { ok: false as const, reason: outcome.reason };
        }
        // Persist the confirmed funding fields on the PaymentIntent
        // (transition to Confirmed + clear failure columns).
        const updated = await tx.paymentIntent.update({
          where: { id: intentRow.id },
          data: {
            providerReference: outcome.input.providerReference,
            confirmedAt: outcome.input.confirmedAt,
            acceptedAt: outcome.input.acceptedAt,
            providerState: "Confirmed",
            failureReasonCode: null,
            failureDetail: null,
          },
        });
        // Guarded activation UPDATE. RETURNING 0 rows => deal is no
        // longer Negotiating; the transaction rolls back.
        const activatedRows = await tx.$queryRaw<{ readonly id: string }[]>`
          UPDATE deals
             SET status = 'Active', "activatedAt" = ${outcome.input.acceptedAt}
           WHERE id = ${input.dealId} AND status = 'Negotiating'
           RETURNING id
        `;
        if (activatedRows.length === 0) {
          return {
            ok: false as const,
            reason: "DEAL_ALREADY_ACTIVE" as FundDealFailureReason,
          };
        }
        const summary: PersistedDealSummaryForFunding = {
          id: dealRow.id,
          buyerWorkspaceId: dealRow.buyerWorkspaceId,
          sellerWorkspaceId: dealRow.sellerWorkspaceId,
          status: "Active",
          activatedAt: outcome.input.acceptedAt,
        };
        return {
          ok: true as const,
          value: {
            paymentIntent: toPersistedPaymentIntent(updated),
            deal: summary,
          },
        };
      },
      { isolationLevel: "Serializable" },
    );
  }

  // ---------- findCurrentPaymentIntent ----------

  async findCurrentPaymentIntent(dealId: string): Promise<PersistedPaymentIntent | null> {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { dealId },
      orderBy: { createdAt: "desc" },
    });
    return intent ? toPersistedPaymentIntent(intent) : null;
  }
}

function toPersistedPaymentIntent(row: {
  id: string;
  dealId: string;
  termsVersionId: string;
  actingWorkspaceId: string;
  createdByUserId: string;
  expectedAmountMinor: number;
  expectedCurrency: string;
  assetLabel: string;
  networkLabel: string;
  providerKey: string;
  environmentLabel: string;
  correlationId: string;
  providerReference: string | null;
  confirmedAt: Date | null;
  acceptedAt: Date | null;
  failureReasonCode: string | null;
  failureDetail: string | null;
  providerState: "Created" | "Confirmed" | "Failed";
  createdAt: Date;
  updatedAt: Date;
}): PersistedPaymentIntent {
  return {
    id: row.id,
    dealId: row.dealId,
    termsVersionId: row.termsVersionId,
    actingWorkspaceId: row.actingWorkspaceId,
    createdByUserId: row.createdByUserId,
    expectedAmountMinor: row.expectedAmountMinor,
    expectedCurrency: row.expectedCurrency,
    assetLabel: row.assetLabel,
    networkLabel: row.networkLabel,
    providerKey: row.providerKey,
    environmentLabel: row.environmentLabel,
    correlationId: row.correlationId,
    providerReference: row.providerReference,
    confirmedAt: row.confirmedAt,
    acceptedAt: row.acceptedAt,
    failureReasonCode: row.failureReasonCode,
    failureDetail: row.failureDetail,
    providerState: row.providerState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
