-- Milestone 2 (#84): SellerProfile publication evidence + retry identity.
--
-- Adds ONE narrow append-only table for immutable publication attestation
-- (mirrors the DealApproval evidence pattern at packages/db/prisma/
-- schema.prisma around line 1013). Each successful Publish / Update
-- creates one row bound to the (acting UserAccount, acting Workspace,
-- SellerProfile, confirmation version, idempotencyKey, requestId).
-- The (workspaceId, idempotencyKey) unique constraint is the second
-- defense against retries creating duplicate evidence; the first
-- defense is the application-layer pre-transaction check in
-- SellerProfileService.
--
-- The SellerProfile table also gets two nullable convenience columns
-- that cache the latest publication metadata for fast reads. These are
-- NOT the durable evidence — they are an index pointer to the latest
-- row in seller_profile_publications. A failed update preserves the
-- prior values (the rows are NOT updated on transaction rollback).
--
-- No generalized audit / event-sourcing infrastructure is added; the
-- table is scoped to SellerProfile publication only.

CREATE TABLE "seller_profile_publications" (
  "id"                  TEXT NOT NULL,
  "publishedByUserId"   TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,
  "sellerProfileId"     TEXT NOT NULL,
  "confirmationVersion" TEXT NOT NULL,
  "publishedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey"      TEXT NOT NULL,
  "requestId"           TEXT NOT NULL,
  CONSTRAINT "seller_profile_publications_pkey" PRIMARY KEY ("id")
);

-- Same-attempt retry convergence. A transport retry after a lost
-- response reuses the same idempotencyKey; the unique constraint
-- rejects the duplicate INSERT and the service converges on the
-- already-persisted row.
CREATE UNIQUE INDEX "seller_profile_publications_workspace_idem_unique_idx"
  ON "seller_profile_publications"("workspaceId", "idempotencyKey");

-- Latest-evidence lookup: "what is the most recent publication for
-- this profile?". ORDER BY publishedAt DESC plus this index supports
-- the dashboard readiness row (owned by another ticket) and the
-- editor / review on-mount reads.
CREATE INDEX "seller_profile_publications_profile_publishedAt_idx"
  ON "seller_profile_publications"("sellerProfileId", "publishedAt" DESC);

ALTER TABLE "seller_profile_publications"
  ADD CONSTRAINT "seller_profile_publications_publishedByUserId_fkey"
  FOREIGN KEY ("publishedByUserId") REFERENCES "user_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "seller_profile_publications"
  ADD CONSTRAINT "seller_profile_publications_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "seller_profile_publications"
  ADD CONSTRAINT "seller_profile_publications_sellerProfileId_fkey"
  FOREIGN KEY ("sellerProfileId") REFERENCES "seller_profiles"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Convenience current-state columns on SellerProfile. These are NOT
-- the durable evidence — see seller_profile_publications for the
-- append-only audit trail. ON DELETE SET NULL on publishedByUserId
-- so a hard-deleted UserAccount does not cascade-erase the
-- publication timestamp on a profile that still belongs to an
-- active Workspace.
ALTER TABLE "seller_profiles" ADD COLUMN "publishedAt" TIMESTAMP(3);
ALTER TABLE "seller_profiles" ADD COLUMN "publishedByUserId" TEXT;

ALTER TABLE "seller_profiles"
  ADD CONSTRAINT "seller_profiles_publishedByUserId_fkey"
  FOREIGN KEY ("publishedByUserId") REFERENCES "user_accounts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Supports dashboard readiness (owned by another ticket) and the
-- catalog non-leakage test. Index does NOT include publishedAt —
-- a publication timestamp is a single row attribute, not a query
-- axis.
CREATE INDEX "seller_profiles_status_updatedAt_idx"
  ON "seller_profiles"("status", "updatedAt");
