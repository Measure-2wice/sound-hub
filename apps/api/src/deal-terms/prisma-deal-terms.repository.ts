// Prisma adapter for DealTermsRepository.
//
// Background: this module is the only place the BG5 Deal /
// TermsVersion / DealApproval boundary touches Prisma. Higher layers
// depend on `DealTermsRepository`; tests can swap in the in-memory
// adapter without changing the service or route code.
//
// Architectural split:
//
//   - The application owns the authorization policy (see
//     `./deal-terms-authorization-policy.ts`). Every pure evaluator
//     (drafting authority, approval authority) lives there and is
//     invoked by the service's use-case closures.
//
//   - The repository owns the transaction boundary and the
//     locked-fact reads. Inside one `$transaction` it acquires
//     `SELECT ... FOR UPDATE` row locks on every row the policy
//     depends on, then hands the assembled snapshot to the
//     application-supplied use case. The use case evaluates the
//     policy helpers and returns either `persistDraft` /
//     `persistApproval` or a rejection. The repository persists
//     only when the use case persists; the transaction rolls back
//     on any rejection.
//
//   - The Prisma adapter never decides whether the facts authorize
//     the command. The application-owned policy is the only
//     decision point.
//
// All consequential writes are wrapped in the same transaction. The
// unique index on `terms_versions(dealId, version)` and the unique
// index on `deal_approvals(termsVersionId, workspaceId)` are the
// second defenses against retries creating duplicate rows (ticket #63
// GS 26).
//
// Serializable concurrency:
//
//   Both transactional command methods open a PostgreSQL transaction
//   with `Serializable` isolation. A conflicting commit on any row
//   the transaction read produces a Prisma `P2034`
//   (serialization_failure / write conflict) error on COMMIT. The
//   adapter retries the bounded transaction a small fixed number of
//   times; each retry re-reads authoritative current facts via FOR
//   UPDATE so a revocation that committed between attempts is
//   reflected in the next snapshot. After the retry budget is
//   exhausted the adapter surfaces a safe typed failure reason
//   (CONCURRENCY_RETRY_EXHAUSTED) so the application route layer
//   maps it onto the existing safe envelope. NO partial
//   TermsVersion or DealApproval may remain from a failed attempt —
//   the bounded transaction guarantees an all-or-nothing outcome on
//   every attempt.

import type { PrismaClient } from "@soundhub/db";
import { PrismaClientKnownRequestError } from "@soundhub/db/dist/generated/internal/prismaNamespace.js";
import type {
  DealTermsRepository,
  DealViewSnapshot,
  DraftTermsFailureReason,
  DraftTermsResult,
  DraftTermsTransactionInput,
  DraftTermsUseCase,
  DraftTermsUseCaseTools,
  PersistedDealApproval,
  PersistedDealSummary,
  PersistedTermsVersion,
  RecordApprovalFailureReason,
  RecordApprovalResult,
  RecordApprovalTransactionInput,
  RecordApprovalUseCase,
  RecordApprovalUseCaseTools,
} from "./deal-terms.repository.js";
import type { ApprovalAuthoritySnapshot, DraftingAuthoritySnapshot } from "./deal-terms-authorization-policy.js";

// Small fixed maximum. Mirrors the BG4 retry budget; not a generalized
// framework — it exists only because PostgreSQL's Serializable
// isolation surfaces a write conflict (P2034) when the transaction's
// snapshot is invalidated by a concurrent committed write that
// touched a row the transaction read.
const P2034_RETRY_BUDGET = 3;

const CONCURRENCY_RETRY_EXHAUSTED_DRAFT: DraftTermsFailureReason = "CONCURRENCY_RETRY_EXHAUSTED";
const CONCURRENCY_RETRY_EXHAUSTED_APPROVAL: RecordApprovalFailureReason =
  "CONCURRENCY_RETRY_EXHAUSTED";

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

interface BoundedRetryEnvelope<TValue, TFailure> {
  readonly outcome:
    | { readonly kind: "value"; readonly value: TValue }
    | { readonly kind: "exhausted"; readonly failure: TFailure };
}
async function runWithBoundedP2034Retry<TValue, TFailure>(
  attempt: () => Promise<TValue>,
  buildFailure: () => TFailure,
): Promise<BoundedRetryEnvelope<TValue, TFailure>> {
  for (let attemptIndex = 0; attemptIndex < P2034_RETRY_BUDGET; attemptIndex += 1) {
    try {
      return { outcome: { kind: "value", value: await attempt() } };
    } catch (err) {
      if (!isSerializationConflict(err)) throw err;
    }
  }
  return { outcome: { kind: "exhausted", failure: buildFailure() } };
}

export class PrismaDealTermsRepository implements DealTermsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------- draftTermsInTransaction ----------

  async draftTermsInTransaction(
    input: DraftTermsTransactionInput,
    useCase: DraftTermsUseCase,
  ): Promise<DraftTermsResult> {
    const envelope = await runWithBoundedP2034Retry<
      DraftTermsResult,
      DraftTermsFailureReason
    >(
      () => this.runDraftTransactionOnce(input, useCase),
      () => CONCURRENCY_RETRY_EXHAUSTED_DRAFT,
    );
    if (envelope.outcome.kind === "exhausted") {
      return { ok: false, reason: envelope.outcome.failure };
    }
    return envelope.outcome.value;
  }

  private async runDraftTransactionOnce(
    input: DraftTermsTransactionInput,
    useCase: DraftTermsUseCase,
  ): Promise<DraftTermsResult> {
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          // Step 1: FOR UPDATE-lock the Deal row.
          const dealRows = await tx.$queryRaw<
            {
              readonly id: string;
              readonly buyerWorkspaceId: string;
              readonly sellerWorkspaceId: string;
              readonly status: "Negotiating" | "Active";
            }[]
          >`SELECT id, "buyerWorkspaceId", "sellerWorkspaceId", status FROM deals WHERE id = ${input.dealId} FOR UPDATE`;
          const dealRow = dealRows[0];
          if (!dealRow) {
            return { ok: false as const, reason: "DEAL_NOT_FOUND" as DraftTermsFailureReason };
          }

          // Step 2: load the snapshot. The application service
          // supplies `draftedByUserId` (= the acting human, when
          // known) on the transaction input. We FOR UPDATE-lock
          // the buyer + seller WorkspaceMembership rows so a
          // concurrent revoke cannot commit between this read and
          // the BG5 write.
          const actingUserId = input.draftedByUserId ?? "__none__";
          const memberRows = await tx.$queryRaw<
            {
              readonly workspaceId: string;
              readonly status: "Active" | "Suspended";
            }[]
          >`
            SELECT w.id AS "workspaceId", w.status
            FROM workspace_memberships m
            JOIN workspaces w ON w.id = m."workspaceId"
            WHERE m."userId" = ${actingUserId}
              AND m."workspaceId" IN (${dealRow.buyerWorkspaceId}, ${dealRow.sellerWorkspaceId})
            FOR UPDATE OF w, m
          `;
          const member = memberRows[0];
          const snapshot: DraftingAuthoritySnapshot = {
            dealId: dealRow.id,
            dealStatus: dealRow.status,
            buyerWorkspaceId: dealRow.buyerWorkspaceId,
            sellerWorkspaceId: dealRow.sellerWorkspaceId,
            actingWorkspaceId: member?.workspaceId ?? "",
            actingWorkspaceStatus: member?.status ?? "Suspended",
            actingUserIsMember: member !== undefined,
          };

          const tools: DraftTermsUseCaseTools = {
            reject: (r) => ({ kind: "reject" as const, reason: r }),
            persistDraft: (persistInput) => ({
              kind: "persistDraft" as const,
              input: persistInput,
            }),
          };
          const outcome = useCase({ draftingAuthority: snapshot }, tools);

          if (outcome.kind === "reject") {
            return { ok: false as const, reason: outcome.reason };
          }

          // Step 3: compute next version under lock + insert the
          // TermsVersion row.
          const existingRows = await tx.$queryRaw<
            { readonly max: number | null }[]
          >`SELECT MAX(version) AS max FROM terms_versions WHERE "dealId" = ${input.dealId}`;
          const nextVersion = (existingRows[0]?.max ?? 0) + 1;

          try {
            const row = await tx.termsVersion.create({
              data: {
                dealId: outcome.input.dealId,
                version: nextVersion,
                scope: outcome.input.proposedTerms.scope,
                deliverablesJson: outcome.input.proposedTerms.deliverables,
                scheduleJson: outcome.input.proposedTerms.schedule,
                priceAmountMinor: outcome.input.proposedTerms.price.amountMinor,
                priceCurrency: outcome.input.proposedTerms.price.currency,
                revisionAllowance: outcome.input.proposedTerms.revisionAllowance,
                rightsSummary: outcome.input.proposedTerms.rightsSummary,
                fundingDeadlineAt: outcome.input.proposedTerms.fundingDeadlineAt
                  ? new Date(outcome.input.proposedTerms.fundingDeadlineAt)
                  : null,
                aiProvider: outcome.input.aiProvider,
                aiModelId: outcome.input.aiModelId,
                aiFallbackUsed: outcome.input.aiFallbackUsed,
                draftedByUserId: outcome.input.draftedByUserId,
                draftedAt: outcome.input.now,
              },
            });
            return { ok: true as const, value: toPersistedTermsVersion(row) };
          } catch (err) {
            if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
              return {
                ok: false as const,
                reason: "DRAFT_INVALID" as DraftTermsFailureReason,
              };
            }
            throw err;
          }
        },
        { isolationLevel: "Serializable" },
      );
      return result;
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
        return { ok: false, reason: "DRAFT_INVALID" };
      }
      throw err;
    }
  }

  // ---------- recordApprovalInTransaction ----------

  async recordApprovalInTransaction(
    input: RecordApprovalTransactionInput,
    useCase: RecordApprovalUseCase,
  ): Promise<RecordApprovalResult> {
    const envelope = await runWithBoundedP2034Retry<
      RecordApprovalResult,
      RecordApprovalFailureReason
    >(
      () => this.runApprovalTransactionOnce(input, useCase),
      () => CONCURRENCY_RETRY_EXHAUSTED_APPROVAL,
    );
    if (envelope.outcome.kind === "exhausted") {
      return { ok: false, reason: envelope.outcome.failure };
    }
    return envelope.outcome.value;
  }

  private async runApprovalTransactionOnce(
    input: RecordApprovalTransactionInput,
    useCase: RecordApprovalUseCase,
  ): Promise<RecordApprovalResult> {
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          // Lock the TermsVersion row + the Deal it belongs to.
          const tvRows = await tx.$queryRaw<
            {
              readonly id: string;
              readonly dealId: string;
              readonly version: number;
            }[]
          >`SELECT id, "dealId", version FROM terms_versions WHERE id = ${input.termsVersionId} FOR UPDATE`;
          const tvRow = tvRows[0];
          if (!tvRow) {
            return {
              ok: false as const,
              reason: "TERMS_VERSION_NOT_FOUND" as RecordApprovalFailureReason,
            };
          }

          const dealRows = await tx.$queryRaw<
            {
              readonly id: string;
              readonly buyerWorkspaceId: string;
              readonly sellerWorkspaceId: string;
              readonly status: "Negotiating" | "Active";
            }[]
          >`SELECT id, "buyerWorkspaceId", "sellerWorkspaceId", status FROM deals WHERE id = ${tvRow.dealId} FOR UPDATE`;
          const dealRow = dealRows[0];
          if (!dealRow) {
            return {
              ok: false as const,
              reason: "DEAL_NOT_FOUND" as RecordApprovalFailureReason,
            };
          }

          // Compute the current version (MAX) under the lock.
          const maxRows = await tx.$queryRaw<
            { readonly max: number | null }[]
          >`SELECT MAX(version) AS max FROM terms_versions WHERE "dealId" = ${dealRow.id}`;
          const currentMax = maxRows[0]?.max ?? null;
          const currentVersionRow = await tx.termsVersion.findFirst({
            where: { dealId: dealRow.id, version: currentMax ?? -1 },
            select: { id: true },
          });

          // Lock the acting Workspace + WorkspaceMembership +
          // DealApprover rows.
          const actingWsRows = await tx.$queryRaw<
            { readonly status: "Active" | "Suspended" }[]
          >`SELECT status FROM workspaces WHERE id = ${input.actingWorkspaceId} FOR UPDATE`;
          const actingWsStatus: "Active" | "Suspended" =
            actingWsRows[0]?.status ?? "Suspended";

          const membershipRows = await tx.$queryRaw<{ readonly id: string }[]>`
            SELECT id FROM workspace_memberships
            WHERE "userId" = ${input.userAccountId} AND "workspaceId" = ${input.actingWorkspaceId}
            FOR UPDATE
          `;
          const actingUserIsMember = membershipRows.length > 0;

          const dealApproverRows = await tx.$queryRaw<{ readonly id: string }[]>`
            SELECT id FROM deal_approvers
            WHERE "workspaceId" = ${input.actingWorkspaceId} AND "userId" = ${input.userAccountId}
            FOR UPDATE
          `;
          const dealApproverExists = dealApproverRows.length > 0;
          const dealApproverId = dealApproverRows[0]?.id ?? null;

          const snapshot: ApprovalAuthoritySnapshot = {
            dealId: dealRow.id,
            dealStatus: dealRow.status,
            termsVersionId: tvRow.id,
            termsVersionDealId: tvRow.dealId,
            currentTermsVersionId: currentVersionRow?.id ?? null,
            buyerWorkspaceId: dealRow.buyerWorkspaceId,
            sellerWorkspaceId: dealRow.sellerWorkspaceId,
            actingWorkspaceId: input.actingWorkspaceId,
            actingWorkspaceStatus: actingWsStatus,
            actingUserIsMember,
            userAccountId: input.userAccountId,
            dealApproverExists,
            dealApproverId,
          };

          const tools: RecordApprovalUseCaseTools = {
            reject: (r) => ({ kind: "reject" as const, reason: r }),
            persistApproval: (persistInput) => ({
              kind: "persistApproval" as const,
              input: persistInput,
            }),
          };
          const outcome = useCase({ approvalAuthority: snapshot }, tools);

          if (outcome.kind === "reject") {
            return { ok: false as const, reason: outcome.reason };
          }

          if (!dealApproverId) {
            return {
              ok: false as const,
              reason: "APPROVAL_FORBIDDEN" as RecordApprovalFailureReason,
            };
          }

          try {
            const row = await tx.dealApproval.create({
              data: {
                termsVersionId: outcome.input.termsVersionId,
                workspaceId: outcome.input.workspaceId,
                dealApproverId,
                approvedByUserId: outcome.input.approvedByUserId,
                approvedAt: outcome.input.now,
              },
            });
            return { ok: true as const, value: toPersistedApproval(row) };
          } catch (err) {
            if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
              return {
                ok: false as const,
                reason: "APPROVAL_ALREADY_RECORDED" as RecordApprovalFailureReason,
              };
            }
            throw err;
          }
        },
        { isolationLevel: "Serializable" },
      );
      return result;
    } catch (err) {
      if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
        return { ok: false, reason: "APPROVAL_ALREADY_RECORDED" };
      }
      throw err;
    }
  }

  // ---------- reads ----------

  async findDealView(dealId: string): Promise<DealViewSnapshot | null> {
    const deal = await this.prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) return null;
    const versions = await this.prisma.termsVersion.findMany({
      where: { dealId },
      orderBy: { version: "desc" },
      take: 50,
    });
    const current = versions[0] ?? null;
    const approvals = current
      ? await this.prisma.dealApproval.findMany({
          where: { termsVersionId: current.id },
        })
      : [];
    return {
      deal: toPersistedDealSummary(deal),
      projectRequest: null,
      currentTermsVersion: current ? toPersistedTermsVersion(current) : null,
      currentApprovals: approvals.map(toPersistedApproval),
    };
  }

  async findDealSummary(dealId: string): Promise<PersistedDealSummary | null> {
    const deal = await this.prisma.deal.findUnique({ where: { id: dealId } });
    return deal ? toPersistedDealSummary(deal) : null;
  }
}

// ---------- helpers ----------

function toPersistedTermsVersion(row: {
  readonly id: string;
  readonly dealId: string;
  readonly version: number;
  readonly scope: string;
  readonly deliverablesJson: unknown;
  readonly scheduleJson: unknown;
  readonly priceAmountMinor: number;
  readonly priceCurrency: string;
  readonly revisionAllowance: number;
  readonly rightsSummary: string;
  readonly fundingDeadlineAt: Date | null;
  readonly aiProvider: string;
  readonly aiModelId: string | null;
  readonly aiFallbackUsed: boolean;
  readonly draftedByUserId: string | null;
  readonly draftedAt: Date;
  readonly createdAt: Date;
}): PersistedTermsVersion {
  return {
    id: row.id,
    dealId: row.dealId,
    version: row.version,
    scope: row.scope,
    deliverablesJson: row.deliverablesJson,
    scheduleJson: row.scheduleJson,
    priceAmountMinor: row.priceAmountMinor,
    priceCurrency: row.priceCurrency,
    revisionAllowance: row.revisionAllowance,
    rightsSummary: row.rightsSummary,
    fundingDeadlineAt: row.fundingDeadlineAt,
    aiProvider: row.aiProvider,
    aiModelId: row.aiModelId,
    aiFallbackUsed: row.aiFallbackUsed,
    draftedByUserId: row.draftedByUserId,
    draftedAt: row.draftedAt,
    createdAt: row.createdAt,
  };
}

function toPersistedApproval(row: {
  readonly id: string;
  readonly termsVersionId: string;
  readonly workspaceId: string;
  readonly dealApproverId: string;
  readonly approvedByUserId: string;
  readonly approvedAt: Date;
}): PersistedDealApproval {
  return {
    id: row.id,
    termsVersionId: row.termsVersionId,
    workspaceId: row.workspaceId,
    dealApproverId: row.dealApproverId,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
  };
}

function toPersistedDealSummary(row: {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly projectRequestId: string;
  readonly status: "Negotiating" | "Active";
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}): PersistedDealSummary {
  return {
    id: row.id,
    buyerWorkspaceId: row.buyerWorkspaceId,
    sellerWorkspaceId: row.sellerWorkspaceId,
    serviceOfferingId: row.serviceOfferingId,
    projectBriefId: row.projectBriefId,
    projectRequestId: row.projectRequestId,
    status: row.status,
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
  };
}