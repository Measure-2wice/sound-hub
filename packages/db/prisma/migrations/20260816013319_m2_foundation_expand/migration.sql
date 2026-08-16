-- M2.0A / Gate 0 expand migration.
--
-- This migration ADDS the M2 (authority, revision, authentication-identity,
-- security, audit, enforcement, closure, and idempotency) structures BESIDE
-- the M1.1 model. The M1.1 search path is not touched: no M1.1 model,
-- column, enum, index, or foreign key is removed or repurposed.
--
-- The migration also backfills the canonical initial state from the
-- existing M1.1 data so later M2 tickets can read the new structures
-- without a separate data-migration step:
--
--   1. WorkspaceMembership.authority is backfilled from the M1.1
--      `role` column (Owner -> Owner, Admin/Member -> Editor).
--   2. Every canonical SellerProfile gets one initial published
--      SellerProfileRevision (revisionNumber = 1, kind = Published),
--      including its specialty join rows and Caribbean affiliations.
--   3. Every canonical ServiceOffering gets one initial published
--      ServiceOfferingRevision (revisionNumber = 1, kind = Published),
--      including its pricing fields (denormalized for an immutable
--      record), service-area rows, and bundled included-service rows.
--
-- The seed owns the M1.1 fixtures; M2 structures are owned by this
-- migration. Re-running the seed does not change the M2 backfill
-- state.

-- CreateEnum
CREATE TYPE "WorkspaceMembershipAuthority" AS ENUM ('Owner', 'Editor');

-- CreateEnum
CREATE TYPE "AuthenticationProvider" AS ENUM ('MagicLink');

-- CreateEnum
CREATE TYPE "WorkspaceClosureState" AS ENUM ('None', 'PendingClosure', 'Closed');

-- CreateEnum
CREATE TYPE "UserAccountClosureState" AS ENUM ('None', 'PendingClosure', 'Closed');

-- CreateEnum
CREATE TYPE "MarketplaceReportStatus" AS ENUM ('Open', 'UnderReview', 'Resolved');

-- CreateEnum
CREATE TYPE "MarketplaceReportReason" AS ENUM ('Impersonation', 'Fraud', 'Misrepresentation', 'HarmfulContent');

-- CreateEnum
CREATE TYPE "AcceptanceKind" AS ENUM ('Terms', 'Privacy', 'SellerTerms', 'AuthorityAttestation', 'EditorAuthorityAttestation');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('Terms', 'Privacy', 'SellerTerms', 'AuthorityRepresentation');

-- CreateEnum
CREATE TYPE "PolicyUpdateClass" AS ENUM ('Editorial', 'NoticeRequired', 'ReconsentRequired');

-- CreateEnum
CREATE TYPE "RetentionClass" AS ENUM ('Security', 'Governance', 'Publication', 'Enforcement');

-- CreateEnum
CREATE TYPE "AuditEventOutcome" AS ENUM ('Success', 'Failure');

-- CreateEnum
CREATE TYPE "WorkspaceControlFreezeState" AS ENUM ('Active', 'Lifted');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('InProgress', 'Completed', 'Failed');

-- CreateEnum
CREATE TYPE "SellerProfileRevisionKind" AS ENUM ('Working', 'Published');

-- CreateEnum
CREATE TYPE "ServiceOfferingRevisionKind" AS ENUM ('Working', 'Published');

-- CreateEnum
CREATE TYPE "WorkspaceInvitationStatus" AS ENUM ('Pending', 'Accepted', 'Revoked', 'Expired', 'Failed');

-- AlterTable
-- closureState columns have a default of 'None', so existing M1.1 rows
-- do not violate NOT NULL during the alteration.
ALTER TABLE "user_accounts" ADD COLUMN     "closureState" "UserAccountClosureState" NOT NULL DEFAULT 'None';

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "closureState" "WorkspaceClosureState" NOT NULL DEFAULT 'None';

-- DropForeignKey
-- The M1.1 `workspaces.ownerUserId` foreign-key constraint made the
-- singular owner reference an authority pointer. The M2 model
-- (ADR 0001, Milestone 2 spec) requires Active WorkspaceMembership
-- to be the sole source of current Workspace authority. The FK
-- constraint is dropped so the column carries no DB-level authority
-- semantics. The column is preserved as a correspondence / display
-- field for M1.1 fixtures and search-result presentation; no
-- authorization decision may consult it.
ALTER TABLE "workspaces" DROP CONSTRAINT IF EXISTS "workspaces_ownerUserId_fkey";

-- Promote ownerUserId to nullable. The legacy reference is no
-- longer authoritative and the column may be cleared by retention
-- processing without nullifying the active Owner membership that
-- actually grants authority.
ALTER TABLE "workspaces" ALTER COLUMN "ownerUserId" DROP NOT NULL;

-- AlterTable
-- Add the new authority column as NULLABLE first so the backfill can
-- populate it; promote to NOT NULL after the backfill completes.
ALTER TABLE "workspace_memberships" ADD COLUMN     "authority" "WorkspaceMembershipAuthority",
ADD COLUMN     "removedAt" TIMESTAMP(3);

-- Backfill WorkspaceMembership.authority from the M1.1 `role` column.
-- Owner -> Owner; Admin and Member (the M1.1 secondary roles) -> Editor.
UPDATE "workspace_memberships"
SET "authority" = 'Owner'
WHERE "role" = 'Owner';

UPDATE "workspace_memberships"
SET "authority" = 'Editor'
WHERE "role" IN ('Admin', 'Member');

-- Promote authority to NOT NULL after the backfill. Every existing
-- WorkspaceMembership row has been assigned a value; later M2 tickets
-- creating new memberships must supply `authority` explicitly.
ALTER TABLE "workspace_memberships" ALTER COLUMN "authority" SET NOT NULL;

-- CreateTable
CREATE TABLE "authentication_identities" (
    "id" TEXT NOT NULL,
    "userAccountId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "provider" "AuthenticationProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLinkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authentication_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "magic_link_challenges" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "magic_link_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_account_security" (
    "id" TEXT NOT NULL,
    "userAccountId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    "recentAuthenticationAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_account_security_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_profile_revisions" (
    "id" TEXT NOT NULL,
    "sellerProfileId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "kind" "SellerProfileRevisionKind" NOT NULL,
    "professionalName" TEXT NOT NULL,
    "bio" TEXT NOT NULL,
    "basedInCity" TEXT,
    "basedInRegion" TEXT,
    "basedInCountryCode" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,

    CONSTRAINT "seller_profile_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_profile_revision_specialties" (
    "sellerProfileRevisionId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,

    CONSTRAINT "seller_profile_revision_specialties_pkey" PRIMARY KEY ("sellerProfileRevisionId","specialtyId")
);

-- CreateTable
CREATE TABLE "seller_profile_revision_caribbean_affiliations" (
    "id" TEXT NOT NULL,
    "sellerProfileRevisionId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,

    CONSTRAINT "seller_profile_revision_caribbean_affiliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_offering_revisions" (
    "id" TEXT NOT NULL,
    "serviceOfferingId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "kind" "ServiceOfferingRevisionKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "serviceMode" "ServiceMode" NOT NULL,
    "primaryCategoryId" TEXT NOT NULL,
    "genreTags" TEXT[],
    "pricingKind" "PricingKind",
    "pricingAmountMinor" INTEGER,
    "pricingCurrency" TEXT,
    "pricingUnitId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,

    CONSTRAINT "service_offering_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_offering_revision_service_areas" (
    "id" TEXT NOT NULL,
    "serviceOfferingRevisionId" TEXT NOT NULL,
    "city" TEXT,
    "region" TEXT,
    "countryCode" TEXT NOT NULL,

    CONSTRAINT "service_offering_revision_service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_offering_revision_included_services" (
    "id" TEXT NOT NULL,
    "serviceOfferingRevisionId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "purchaseMode" "PurchaseMode" NOT NULL,

    CONSTRAINT "service_offering_revision_included_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actingWorkspaceId" TEXT,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "requestId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "AuditEventOutcome" NOT NULL,
    "retentionClass" "RetentionClass" NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_control_freezes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "state" "WorkspaceControlFreezeState" NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedByOperatorId" TEXT,
    "reason" TEXT NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftedByOperatorId" TEXT,
    "liftedReason" TEXT,

    CONSTRAINT "workspace_control_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_reports" (
    "id" TEXT NOT NULL,
    "reportedWorkspaceId" TEXT NOT NULL,
    "reporterUserId" TEXT,
    "reason" "MarketplaceReportReason" NOT NULL,
    "description" TEXT NOT NULL,
    "contactEmail" TEXT,
    "status" "MarketplaceReportStatus" NOT NULL DEFAULT 'Open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolutionSummary" TEXT,

    CONSTRAINT "marketplace_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_closures" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "restoredBy" TEXT,
    "finalReason" TEXT,

    CONSTRAINT "workspace_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_account_closures" (
    "id" TEXT NOT NULL,
    "userAccountId" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "restoredBy" TEXT,
    "finalReason" TEXT,

    CONSTRAINT "user_account_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_invitations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "authority" "WorkspaceMembershipAuthority" NOT NULL,
    "status" "WorkspaceInvitationStatus" NOT NULL DEFAULT 'Pending',
    "invitedByUserId" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "failureReason" TEXT,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "policyUpdateClass" "PolicyUpdateClass" NOT NULL DEFAULT 'Editorial',
    "summaryOfChanges" TEXT,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acceptances" (
    "id" TEXT NOT NULL,
    "userAccountId" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "kind" "AcceptanceKind" NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actingWorkspaceId" TEXT,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'InProgress',
    "responseSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- Backfill initial published SellerProfileRevision for every existing
-- canonical SellerProfile. revisionNumber is 1 (the first revision);
-- kind is 'Published' so the row is the immutable public record. The
-- revision id is deterministically derived from the parent SellerProfile
-- id so re-running the migration (or restoring a backup over the
-- schema) does not produce duplicate revisions.
INSERT INTO "seller_profile_revisions" (
    "id",
    "sellerProfileId",
    "revisionNumber",
    "kind",
    "professionalName",
    "bio",
    "basedInCity",
    "basedInRegion",
    "basedInCountryCode",
    "avatarUrl",
    "publishedAt",
    "createdAt"
)
SELECT
    'rev-' || "id" || '-1',
    "id",
    1,
    'Published'::"SellerProfileRevisionKind",
    "professionalName",
    "bio",
    "basedInCity",
    "basedInRegion",
    "basedInCountryCode",
    "avatarUrl",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "seller_profiles";

-- Backfill the specialty join rows for each initial published revision.
INSERT INTO "seller_profile_revision_specialties" (
    "sellerProfileRevisionId",
    "specialtyId"
)
SELECT
    'rev-' || "sp"."id" || '-1',
    "sps"."specialtyId"
FROM "seller_profiles" "sp"
JOIN "seller_profile_specialties" "sps" ON "sps"."sellerProfileId" = "sp"."id";

-- Backfill the Caribbean affiliations for each initial published revision.
INSERT INTO "seller_profile_revision_caribbean_affiliations" (
    "id",
    "sellerProfileRevisionId",
    "countryCode"
)
SELECT
    'rev-' || "sp"."id" || '-1-' || "ca"."id",
    'rev-' || "sp"."id" || '-1',
    "ca"."countryCode"
FROM "seller_profiles" "sp"
JOIN "caribbean_affiliations" "ca" ON "ca"."sellerProfileId" = "sp"."id";

-- Backfill initial published ServiceOfferingRevision for every existing
-- canonical ServiceOffering. Pricing fields are denormalized from the
-- offering_pricing row so the immutable revision preserves the exact
-- advertised amount; offerings without a pricing row leave the pricing
-- columns NULL.
INSERT INTO "service_offering_revisions" (
    "id",
    "serviceOfferingId",
    "revisionNumber",
    "kind",
    "title",
    "description",
    "serviceMode",
    "primaryCategoryId",
    "genreTags",
    "pricingKind",
    "pricingAmountMinor",
    "pricingCurrency",
    "pricingUnitId",
    "publishedAt",
    "createdAt"
)
SELECT
    'rev-' || "so"."id" || '-1',
    "so"."id",
    1,
    'Published'::"ServiceOfferingRevisionKind",
    "so"."title",
    "so"."description",
    "so"."serviceMode",
    "so"."primaryCategoryId",
    "so"."genreTags",
    "sop"."kind",
    "sop"."amountMinor",
    "sop"."currency",
    "sop"."unitId",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "service_offerings" "so"
LEFT JOIN "offering_pricing" "sop" ON "sop"."offeringId" = "so"."id";

-- Backfill the service-area rows for each initial published revision.
INSERT INTO "service_offering_revision_service_areas" (
    "id",
    "serviceOfferingRevisionId",
    "city",
    "region",
    "countryCode"
)
SELECT
    'rev-' || "so"."id" || '-1-' || "sa"."id",
    'rev-' || "so"."id" || '-1',
    "sa"."city",
    "sa"."region",
    "sa"."countryCode"
FROM "service_offerings" "so"
JOIN "offering_service_areas" "sa" ON "sa"."offeringId" = "so"."id";

-- Backfill the included-service rows for each initial published
-- revision. The M1.1 `included_services` table already represents
-- the canonical bundle children (category and purchaseMode per
-- offering). The immutable revision must mirror the same set so
-- the complete revision graph is reconstructable from the
-- published record alone. Offerings with no bundled
-- `included_services` rows produce no `included_services` rows in
-- the revision graph; the migration preserves the empty relation.
INSERT INTO "service_offering_revision_included_services" (
    "id",
    "serviceOfferingRevisionId",
    "categoryId",
    "purchaseMode"
)
SELECT
    'rev-' || "so"."id" || '-1-' || "is"."id",
    'rev-' || "so"."id" || '-1',
    "is"."categoryId",
    "is"."purchaseMode"
FROM "service_offerings" "so"
JOIN "included_services" "is" ON "is"."offeringId" = "so"."id";

-- CreateIndex
CREATE INDEX "authentication_identities_userAccountId_idx" ON "authentication_identities"("userAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "authentication_identities_provider_subject_key" ON "authentication_identities"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "magic_link_challenges_tokenHash_key" ON "magic_link_challenges"("tokenHash");

-- CreateIndex
CREATE INDEX "magic_link_challenges_email_idx" ON "magic_link_challenges"("email");

-- CreateIndex
CREATE INDEX "magic_link_challenges_expiresAt_idx" ON "magic_link_challenges"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_security_userAccountId_key" ON "user_account_security"("userAccountId");

-- CreateIndex
CREATE INDEX "sessions_userAccountId_idx" ON "sessions"("userAccountId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "seller_profile_revisions_sellerProfileId_idx" ON "seller_profile_revisions"("sellerProfileId");

-- CreateIndex
CREATE INDEX "seller_profile_revisions_kind_idx" ON "seller_profile_revisions"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "seller_profile_revisions_sellerProfileId_revisionNumber_key" ON "seller_profile_revisions"("sellerProfileId", "revisionNumber");

-- CreateIndex
CREATE INDEX "seller_profile_revision_caribbean_affiliations_countryCode_idx" ON "seller_profile_revision_caribbean_affiliations"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "seller_profile_revision_caribbean_affiliations_sellerProfil_key" ON "seller_profile_revision_caribbean_affiliations"("sellerProfileRevisionId", "countryCode");

-- CreateIndex
CREATE INDEX "service_offering_revisions_serviceOfferingId_idx" ON "service_offering_revisions"("serviceOfferingId");

-- CreateIndex
CREATE INDEX "service_offering_revisions_kind_idx" ON "service_offering_revisions"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "service_offering_revisions_serviceOfferingId_revisionNumber_key" ON "service_offering_revisions"("serviceOfferingId", "revisionNumber");

-- CreateIndex
CREATE INDEX "service_offering_revision_service_areas_serviceOfferingRevi_idx" ON "service_offering_revision_service_areas"("serviceOfferingRevisionId");

-- CreateIndex
CREATE INDEX "service_offering_revision_service_areas_countryCode_idx" ON "service_offering_revision_service_areas"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "service_offering_revision_included_services_serviceOffering_key" ON "service_offering_revision_included_services"("serviceOfferingRevisionId", "categoryId");

-- CreateIndex
CREATE INDEX "audit_events_actorUserId_occurredAt_idx" ON "audit_events"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_events_actingWorkspaceId_occurredAt_idx" ON "audit_events"("actingWorkspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_events_action_occurredAt_idx" ON "audit_events"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_events_subjectType_subjectId_idx" ON "audit_events"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "audit_events_occurredAt_idx" ON "audit_events"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_control_freezes_workspaceId_key" ON "workspace_control_freezes"("workspaceId");

-- CreateIndex
CREATE INDEX "marketplace_reports_reportedWorkspaceId_status_idx" ON "marketplace_reports"("reportedWorkspaceId", "status");

-- CreateIndex
CREATE INDEX "marketplace_reports_status_createdAt_idx" ON "marketplace_reports"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_closures_workspaceId_key" ON "workspace_closures"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_closures_closesAt_idx" ON "workspace_closures"("closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_closures_userAccountId_key" ON "user_account_closures"("userAccountId");

-- CreateIndex
CREATE INDEX "user_account_closures_closesAt_idx" ON "user_account_closures"("closesAt");

-- CreateIndex
CREATE INDEX "workspace_invitations_workspaceId_status_idx" ON "workspace_invitations"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "workspace_invitations_email_idx" ON "workspace_invitations"("email");

-- CreateIndex
CREATE INDEX "workspace_invitations_expiresAt_idx" ON "workspace_invitations"("expiresAt");

-- CreateIndex
CREATE INDEX "document_versions_kind_publishedAt_idx" ON "document_versions"("kind", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_kind_version_key" ON "document_versions"("kind", "version");

-- CreateIndex
CREATE INDEX "acceptances_userAccountId_kind_acceptedAt_idx" ON "acceptances"("userAccountId", "kind", "acceptedAt");

-- CreateIndex
CREATE INDEX "acceptances_documentVersionId_idx" ON "acceptances"("documentVersionId");

-- CreateIndex
CREATE INDEX "idempotency_keys_status_createdAt_idx" ON "idempotency_keys"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_scope_key_key" ON "idempotency_keys"("scope", "key");

-- AddForeignKey
ALTER TABLE "authentication_identities" ADD CONSTRAINT "authentication_identities_userAccountId_fkey" FOREIGN KEY ("userAccountId") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authentication_identities" ADD CONSTRAINT "authentication_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_account_security" ADD CONSTRAINT "user_account_security_userAccountId_fkey" FOREIGN KEY ("userAccountId") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userAccountId_fkey" FOREIGN KEY ("userAccountId") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_profile_revisions" ADD CONSTRAINT "seller_profile_revisions_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_profile_revision_specialties" ADD CONSTRAINT "seller_profile_revision_specialties_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_profile_revision_specialties" ADD CONSTRAINT "seller_profile_revision_specialties_sellerProfileRevisionI_fkey" FOREIGN KEY ("sellerProfileRevisionId") REFERENCES "seller_profile_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_profile_revision_caribbean_affiliations" ADD CONSTRAINT "seller_profile_revision_caribbean_affiliations_sellerProfi_fkey" FOREIGN KEY ("sellerProfileRevisionId") REFERENCES "seller_profile_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offering_revisions" ADD CONSTRAINT "service_offering_revisions_serviceOfferingId_fkey" FOREIGN KEY ("serviceOfferingId") REFERENCES "service_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offering_revisions" ADD CONSTRAINT "service_offering_revisions_primaryCategoryId_fkey" FOREIGN KEY ("primaryCategoryId") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offering_revisions" ADD CONSTRAINT "service_offering_revisions_pricingUnitId_fkey" FOREIGN KEY ("pricingUnitId") REFERENCES "pricing_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offering_revision_service_areas" ADD CONSTRAINT "service_offering_revision_service_areas_serviceOfferingRev_fkey" FOREIGN KEY ("serviceOfferingRevisionId") REFERENCES "service_offering_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offering_revision_included_services" ADD CONSTRAINT "service_offering_revision_included_services_serviceOfferin_fkey" FOREIGN KEY ("serviceOfferingRevisionId") REFERENCES "service_offering_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offering_revision_included_services" ADD CONSTRAINT "service_offering_revision_included_services_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actingWorkspaceId_fkey" FOREIGN KEY ("actingWorkspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_control_freezes" ADD CONSTRAINT "workspace_control_freezes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_reports" ADD CONSTRAINT "marketplace_reports_reportedWorkspaceId_fkey" FOREIGN KEY ("reportedWorkspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_reports" ADD CONSTRAINT "marketplace_reports_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_closures" ADD CONSTRAINT "workspace_closures_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- M2.0A: change Acceptance.userAccountId to ON DELETE RESTRICT so
-- cascading account deletion does not destroy versioned acceptance
-- evidence (ADR 0006). Account closure is a state transition, not
-- a deletion; the application anonymizes or replaces the user
-- reference through an explicit retention flow so the attestation
-- record and its exact document version remain preserved.
ALTER TABLE "acceptances" ADD CONSTRAINT "acceptances_userAccountId_fkey" FOREIGN KEY ("userAccountId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acceptances" ADD CONSTRAINT "acceptances_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =========================================================================
--   Immutability and append-only enforcement (ADR 0005)
--
--   Published SellerProfileRevision and ServiceOfferingRevision rows
--   are immutable evidence per ADR 0005. AuditEvent rows are append-only
--   per the Audit section of the M2 spec. Both guarantees are enforced
--   at the database layer so the persistence boundary cannot silently
--   rewrite or remove evidence. The triggers RAISE EXCEPTION on any
--   UPDATE or DELETE through supported persistence paths.
-- =========================================================================

-- Enforce append-only on audit_events (BEFORE UPDATE / DELETE).
CREATE OR REPLACE FUNCTION audit_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (operation % rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- Enforce immutability on published SellerProfileRevision rows.
-- Working (draft) revisions remain mutable in principle; the published
-- kind is the historical record and is rejected for UPDATE or DELETE.
CREATE OR REPLACE FUNCTION seller_profile_revisions_published_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD."kind" = 'Published') THEN
    RAISE EXCEPTION 'seller_profile_revisions.published revisions are immutable (DELETE rejected)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (TG_OP = 'UPDATE' AND OLD."kind" = 'Published') THEN
    RAISE EXCEPTION 'seller_profile_revisions.published revisions are immutable (UPDATE rejected)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER seller_profile_revisions_no_delete_published
  BEFORE DELETE ON "seller_profile_revisions"
  FOR EACH ROW EXECUTE FUNCTION seller_profile_revisions_published_immutable();

CREATE TRIGGER seller_profile_revisions_no_update_published
  BEFORE UPDATE ON "seller_profile_revisions"
  FOR EACH ROW EXECUTE FUNCTION seller_profile_revisions_published_immutable();

-- Enforce immutability on published ServiceOfferingRevision rows.
CREATE OR REPLACE FUNCTION service_offering_revisions_published_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD."kind" = 'Published') THEN
    RAISE EXCEPTION 'service_offering_revisions.published revisions are immutable (DELETE rejected)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (TG_OP = 'UPDATE' AND OLD."kind" = 'Published') THEN
    RAISE EXCEPTION 'service_offering_revisions.published revisions are immutable (UPDATE rejected)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER service_offering_revisions_no_delete_published
  BEFORE DELETE ON "service_offering_revisions"
  FOR EACH ROW EXECUTE FUNCTION service_offering_revisions_published_immutable();

CREATE TRIGGER service_offering_revisions_no_update_published
  BEFORE UPDATE ON "service_offering_revisions"
  FOR EACH ROW EXECUTE FUNCTION service_offering_revisions_published_immutable();

-- Enforce immutability on snapshot children of a published
-- ServiceOfferingRevision. The bundled IncludedService rows are part
-- of the immutable published record.
CREATE OR REPLACE FUNCTION service_offering_revision_included_services_published_immutable()
RETURNS TRIGGER AS $$
DECLARE
  rev_kind TEXT;
BEGIN
  SELECT "kind" INTO rev_kind FROM "service_offering_revisions"
    WHERE "id" = COALESCE(NEW."serviceOfferingRevisionId", OLD."serviceOfferingRevisionId");
  IF rev_kind = 'Published' THEN
    RAISE EXCEPTION 'service_offering_revision_included_services rows belonging to a published revision are immutable (%)', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER service_offering_revision_included_services_no_delete_published
  BEFORE DELETE ON "service_offering_revision_included_services"
  FOR EACH ROW EXECUTE FUNCTION service_offering_revision_included_services_published_immutable();

CREATE TRIGGER service_offering_revision_included_services_no_update_published
  BEFORE UPDATE ON "service_offering_revision_included_services"
  FOR EACH ROW EXECUTE FUNCTION service_offering_revision_included_services_published_immutable();