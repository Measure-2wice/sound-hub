-- Buildathon Golden Slice 5 (BG5) persistence migration.
--
-- Per ticket #63: introduce the minimal explicit DealApprover
-- authorization required by the Golden Slice (GS 6 / DealApprover
-- portion), the immutable TermsVersion proposal (GS 19, GS 21), and
-- independent DealApproval records (GS 20, GS 26). The slice is
-- buildathon-scoped: this migration ships the smallest set of
-- tables, indexes, and foreign keys that prove the GS criteria;
-- no generalized audit subsystem, messaging infrastructure, or
-- versioning UI is added.
--
-- Per CONTEXT.md ("Preserve immutable terms, approvals, delivery
-- versions, and audit evidence in later milestones.") every
-- consequential reference uses ON DELETE RESTRICT so removing a
-- Workspace, UserAccount, Deal, or TermsVersion fails closed
-- rather than erasing authorization or approval evidence.

-- CreateTable: DealApprover authorization
--
-- A Workspace may grant one or more explicit DealApprover
-- authorizations; each row binds the Workspace to a single
-- (current) member who may approve an immutable TermsVersion on
-- the Workspace's behalf. Being authenticated, being an Owner, or
-- possessing Buyer/Seller capability does NOT record approval —
-- only this row does.
CREATE TABLE "deal_approvers" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_approvers_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TermsVersion immutable proposal
--
-- Every TermsVersion is append-only. A material change creates a NEW
-- row with a monotonically incremented `version`; existing rows are
-- never mutated. The (dealId, version) unique index is the second
-- defense against retries creating duplicate version rows.
CREATE TABLE "terms_versions" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "deliverablesJson" JSONB NOT NULL,
    "scheduleJson" JSONB NOT NULL,
    "priceAmountMinor" INTEGER NOT NULL,
    "priceCurrency" TEXT NOT NULL,
    "revisionAllowance" INTEGER NOT NULL,
    "rightsSummary" TEXT NOT NULL,
    "fundingDeadlineAt" TIMESTAMP(3),
    "aiProvider" TEXT NOT NULL,
    "aiModelId" TEXT,
    "aiFallbackUsed" BOOLEAN NOT NULL,
    "draftedByUserId" TEXT,
    "draftedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: DealApproval independent durable record
--
-- Buyer and seller approvals are separate rows; one party's
-- approval does NOT synthesize the other party's approval. The
-- (termsVersionId, workspaceId) unique index is the second defense
-- against retries creating duplicate approvals for the same
-- Workspace on the same version. The dealApproverId column is
-- REQUIRED — a missing authorization fails the approval at the
-- policy layer before reaching this table.
CREATE TABLE "deal_approvals" (
    "id" TEXT NOT NULL,
    "termsVersionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "dealApproverId" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: DealApprover natural uniqueness
--
-- One explicit authorization per (Workspace, user) tuple. The BG5
-- seed (and the deterministic tests) use this constraint to keep
-- the grant idempotent across runs.
CREATE UNIQUE INDEX "deal_approvers_workspace_user_unique_idx"
  ON "deal_approvers"("workspaceId", "userId");

-- CreateIndex: lookup helpers for DealApprover
CREATE INDEX "deal_approvers_workspaceId_idx" ON "deal_approvers"("workspaceId");
CREATE INDEX "deal_approvers_userId_idx" ON "deal_approvers"("userId");

-- CreateIndex: TermsVersion natural uniqueness
--
-- One row per (Deal, version) tuple. A retried draft that re-uses
-- the same version is rejected by this index as a duplicate.
CREATE UNIQUE INDEX "terms_versions_deal_version_unique_idx"
  ON "terms_versions"("dealId", "version");

-- CreateIndex: TermsVersion ordered retrieval for the deal page
CREATE INDEX "terms_versions_dealId_createdAt_idx" ON "terms_versions"("dealId", "createdAt");

-- CreateIndex: DealApproval natural uniqueness
--
-- One approval per (TermsVersion, Workspace) tuple. A retry on the
-- same workspace + same version is rejected by this index.
CREATE UNIQUE INDEX "deal_approvals_terms_workspace_unique_idx"
  ON "deal_approvals"("termsVersionId", "workspaceId");

-- CreateIndex: DealApproval lookup helpers
CREATE INDEX "deal_approvals_workspaceId_idx" ON "deal_approvals"("workspaceId");
CREATE INDEX "deal_approvals_dealApproverId_idx" ON "deal_approvals"("dealApproverId");

-- AddForeignKey: DealApprover.Workspace → Workspace
ALTER TABLE "deal_approvers" ADD CONSTRAINT "deal_approvers_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: DealApprover.user → UserAccount
ALTER TABLE "deal_approvers" ADD CONSTRAINT "deal_approvers_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: DealApprover.grantedBy → UserAccount
ALTER TABLE "deal_approvers" ADD CONSTRAINT "deal_approvers_grantedByUserId_fkey"
  FOREIGN KEY ("grantedByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: TermsVersion.deal → Deal
ALTER TABLE "terms_versions" ADD CONSTRAINT "terms_versions_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: TermsVersion.draftedBy → UserAccount (optional)
ALTER TABLE "terms_versions" ADD CONSTRAINT "terms_versions_draftedByUserId_fkey"
  FOREIGN KEY ("draftedByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: DealApproval.termsVersion → TermsVersion
ALTER TABLE "deal_approvals" ADD CONSTRAINT "deal_approvals_termsVersionId_fkey"
  FOREIGN KEY ("termsVersionId") REFERENCES "terms_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: DealApproval.workspace → Workspace
ALTER TABLE "deal_approvals" ADD CONSTRAINT "deal_approvals_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: DealApproval.dealApprover → DealApprover
ALTER TABLE "deal_approvals" ADD CONSTRAINT "deal_approvals_dealApproverId_fkey"
  FOREIGN KEY ("dealApproverId") REFERENCES "deal_approvers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: DealApproval.approvedBy → UserAccount
ALTER TABLE "deal_approvals" ADD CONSTRAINT "deal_approvals_approvedByUserId_fkey"
  FOREIGN KEY ("approvedByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;