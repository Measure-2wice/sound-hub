// Deal / TermsVersion / DealApproval repository contract (BG5).
//
// Background: ticket #63 requires a persistence boundary for
// TermsVersion drafting and DealApproval recording. The contract is
// the only surface the service layer depends on; the Prisma adapter
// is the canonical implementation and is the only place that touches
// the database directly.
//
// The contract deliberately exposes transaction-scoped use cases so
// the application can run authorization and persistence in one
// authoritative unit of work:
//
//   - draftTermsInTransaction acquires `SELECT ... FOR UPDATE` row
//     locks on the Deal row, both buyer + seller Workspace rows, the
//     acting user's WorkspaceMembership, then hands the snapshot to
//     the application-owned use case. The use case evaluates the
//     drafting policy helpers in
//     `./deal-terms-authorization-policy.ts` and either calls the
//     provided `persistDraft` tool or surfaces a rejection. The
//     repository persists only when the use case persists; the
//     transaction rolls back on any rejection.
//
//   - recordApprovalInTransaction acquires FOR UPDATE row locks on
//     the TermsVersion row, the Deal row, the acting Workspace row,
//     the acting user's WorkspaceMembership, and the DealApprover
//     authorization row, then hands the snapshot to the use case.
//     The use case evaluates the approval policy and returns either
//     `persistApproval` or a rejection. The repository persists only
//     when the use case persists; the unique index on
//     `(termsVersionId, workspaceId)` remains the second defense
//     against retries creating duplicate approvals.
//
//   - Read methods (`findDealById`, `findCurrentTermsVersion`,
//     `listApprovalsForCurrentVersion`) are read-only surfaces used by
//     the view flow. Membership authorization is the caller's
//     responsibility; these methods only filter by deal / version.

import type {
  Bg5DealApprovalPublicV1,
  Bg5TermsVersionPublicV1,
  DealStatusV1,
  ProjectRequestStatusV1,
  ProjectRequestPublicV1,
  DealPublicV1,
} from "@soundhub/types";
import type {
  ApprovalAuthoritySnapshot,
  DraftingAuthoritySnapshot,
} from "./deal-terms-authorization-policy.js";

// ---------- Persistence shapes (private audit fields retained) ----------

export interface PersistedTermsVersion {
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
}

export interface PersistedDealApproval {
  readonly id: string;
  readonly termsVersionId: string;
  readonly workspaceId: string;
  readonly dealApproverId: string;
  readonly approvedByUserId: string;
  readonly approvedAt: Date;
}

export interface PersistedDealSummary {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly serviceOfferingId: string;
  readonly projectBriefId: string;
  readonly projectRequestId: string;
  readonly status: DealStatusV1;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
}

// ---------- Use case inputs ----------

export interface PersistDraftTermsInput {
  readonly dealId: string;
  readonly draftedByUserId: string | null;
  readonly aiProvider: string;
  readonly aiModelId: string | null;
  readonly aiFallbackUsed: boolean;
  readonly proposedTerms: {
    readonly scope: string;
    readonly deliverables: ReadonlyArray<{
      readonly title: string;
      readonly description: string;
    }>;
    readonly schedule: {
      readonly startDate: string;
      readonly endDate: string;
      readonly deliveryDays: number;
    };
    readonly price: { readonly amountMinor: number; readonly currency: "USD" };
    readonly revisionAllowance: number;
    readonly rightsSummary: string;
    readonly fundingDeadlineAt?: string;
  };
  readonly now: Date;
}

export interface PersistApprovalInput {
  readonly termsVersionId: string;
  readonly workspaceId: string;
  readonly dealApproverId: string;
  readonly approvedByUserId: string;
  readonly now: Date;
}

// ---------- Use case outcomes ----------

export type DraftTermsFailureReason =
  | "DEAL_NOT_FOUND"
  | "DEAL_NOT_NEGOTIATING"
  | "DRAFT_FORBIDDEN"
  | "DRAFT_INVALID"
  | "CONCURRENCY_RETRY_EXHAUSTED";

export type RecordApprovalFailureReason =
  | "DEAL_NOT_FOUND"
  | "DEAL_NOT_NEGOTIATING"
  | "TERMS_VERSION_NOT_FOUND"
  | "TERMS_VERSION_NOT_CURRENT"
  | "APPROVAL_FORBIDDEN"
  | "APPROVAL_ALREADY_RECORDED"
  | "CONCURRENCY_RETRY_EXHAUSTED";

export type DraftTermsResult =
  | { readonly ok: true; readonly value: PersistedTermsVersion }
  | { readonly ok: false; readonly reason: DraftTermsFailureReason };

export type RecordApprovalResult =
  | { readonly ok: true; readonly value: PersistedDealApproval }
  | { readonly ok: false; readonly reason: RecordApprovalFailureReason };

// ---------- Draft use case ----------

export interface DraftTermsUseCaseContext {
  readonly draftingAuthority: DraftingAuthoritySnapshot;
}

export interface DraftTermsUseCaseTools {
  reject(reason: DraftTermsFailureReason): DraftTermsUseCaseOutcome;
  persistDraft(input: PersistDraftTermsInput): DraftTermsUseCaseOutcome;
}

export type DraftTermsUseCaseOutcome =
  | { readonly kind: "reject"; readonly reason: DraftTermsFailureReason }
  | { readonly kind: "persistDraft"; readonly input: PersistDraftTermsInput };

export type DraftTermsUseCase = (
  ctx: DraftTermsUseCaseContext,
  tools: DraftTermsUseCaseTools,
) => DraftTermsUseCaseOutcome;

export interface DraftTermsTransactionInput {
  readonly dealId: string;
  readonly draftedByUserId: string | null;
  readonly aiProvider: string;
  readonly aiModelId: string | null;
  readonly aiFallbackUsed: boolean;
}

// ---------- Approval use case ----------

export interface RecordApprovalUseCaseContext {
  readonly approvalAuthority: ApprovalAuthoritySnapshot;
}

export interface RecordApprovalUseCaseTools {
  reject(reason: RecordApprovalFailureReason): RecordApprovalUseCaseOutcome;
  persistApproval(input: PersistApprovalInput): RecordApprovalUseCaseOutcome;
}

export type RecordApprovalUseCaseOutcome =
  | { readonly kind: "reject"; readonly reason: RecordApprovalFailureReason }
  | { readonly kind: "persistApproval"; readonly input: PersistApprovalInput };

export type RecordApprovalUseCase = (
  ctx: RecordApprovalUseCaseContext,
  tools: RecordApprovalUseCaseTools,
) => RecordApprovalUseCaseOutcome;

export interface RecordApprovalTransactionInput {
  readonly termsVersionId: string;
  readonly actingWorkspaceId: string;
  readonly userAccountId: string;
  readonly now: Date;
}

// ---------- Read shape ----------

export interface DealViewSnapshot {
  readonly deal: PersistedDealSummary;
  readonly projectRequest: ProjectRequestPublicV1 | null;
  readonly currentTermsVersion: PersistedTermsVersion | null;
  readonly currentApprovals: readonly PersistedDealApproval[];
}

export interface DealTermsRepository {
  /**
   * Open one PostgreSQL transaction. Inside the transaction the
   * adapter acquires `SELECT ... FOR UPDATE` row locks on the Deal
   * row, both buyer + seller Workspace rows, the acting user's
   * WorkspaceMembership row, then hands the snapshot to the
   * application-owned use case. The use case evaluates the drafting
   * policy and either calls `persistDraft` or surfaces a rejection.
   * The adapter persists only when the use case persists; otherwise
   * the transaction rolls back with no state change.
   *
   * The unique index on `(dealId, version)` is the second defense
   * against retries creating duplicate TermsVersion rows.
   */
  draftTermsInTransaction(
    input: DraftTermsTransactionInput,
    useCase: DraftTermsUseCase,
  ): Promise<DraftTermsResult>;

  /**
   * Same shape as draft, but for approvals. The adapter FOR
   * UPDATE-locks the TermsVersion row, the Deal row, the acting
   * Workspace row, the acting user's WorkspaceMembership row, and
   * the DealApprover authorization row, then hands the snapshot to
   * the use case. The use case evaluates the approval policy and
   * returns `persistApproval` or a rejection. When the use case
   * persists, the adapter inserts the DealApproval row; the unique
   * index on `(termsVersionId, workspaceId)` is the second defense.
   */
  recordApprovalInTransaction(
    input: RecordApprovalTransactionInput,
    useCase: RecordApprovalUseCase,
  ): Promise<RecordApprovalResult>;

  /**
   * Read the Deal summary plus the current TermsVersion + the
   * approvals recorded against it. Membership authorization is the
   * caller's responsibility; this method only filters by Deal.
   */
  findDealView(dealId: string): Promise<DealViewSnapshot | null>;

  /**
   * Read the Deal summary alone. Used for authorization boundary
   * checks that only need buyer/seller workspace ids + status.
   */
  findDealSummary(dealId: string): Promise<PersistedDealSummary | null>;
}

// Re-exports for service layer convenience.
export type { Bg5DealApprovalPublicV1, Bg5TermsVersionPublicV1, ProjectRequestStatusV1, DealPublicV1 };