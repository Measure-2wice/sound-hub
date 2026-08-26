-- Buildathon Golden Slice 1 (BG1) identity and authority migration.
--
-- Adds the durable identity mapping table, the server-issued session
-- table, and makes UserAccount.email nullable so a managed provider may
-- not surface an email at all. WorkspaceMembership remains the only
-- authority source for Golden Slice commands; Workspace.ownerUserId is
-- intentionally left untouched and the GS 5 contract rule (legacy
-- ownerUserId grants no authority) is enforced by the application
-- service, not by the schema.

-- AlterTable
ALTER TABLE "user_accounts" ALTER COLUMN "email" DROP NOT NULL;

-- CreateTable
CREATE TABLE "identity_providers" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "providerEmail" TEXT,
    "userAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identity_providers_provider_subject_key" ON "identity_providers"("provider", "subject");

-- CreateIndex
CREATE INDEX "identity_providers_userAccountId_idx" ON "identity_providers"("userAccountId");

-- CreateIndex
CREATE INDEX "auth_sessions_userAccountId_idx" ON "auth_sessions"("userAccountId");

-- AddForeignKey
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_userAccountId_fkey" FOREIGN KEY ("userAccountId") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userAccountId_fkey" FOREIGN KEY ("userAccountId") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;