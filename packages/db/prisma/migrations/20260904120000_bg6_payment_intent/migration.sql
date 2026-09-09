-- Buildathon Golden Slice 6 (BG6) — PaymentIntent + activation evidence.
-- See ticket #64. Provider-neutral escrow interface; only the
-- deterministic mock is wired for the buildathon. Real stablecoin
-- movement, production Polkadot integration, and wallet verification
-- are explicitly out of scope.

-- CreateEnum: PaymentIntentProviderState closed lifecycle.
--
--   Created   — SoundHub durably persisted the intent; provider not yet called.
--   Confirmed — Provider returned a matching confirmation; reference persisted.
--   Failed    — Provider threw or returned a non-matching confirmation.
CREATE TYPE "PaymentIntentProviderState" AS ENUM ('Created', 'Confirmed', 'Failed');

-- CreateEnum: PaymentIntentFailureReasonCode closed sanitized codes.
--
-- The persisted column carries ONLY this enum value; the closed
-- failure-detail category lives in payment_intents.failureDetailCategory.
-- Raw exception text is NEVER persisted — server-side logs retain
-- it only (ticket #64 P1-004).
CREATE TYPE "PaymentIntentFailureReasonCode" AS ENUM (
  'EscrowProviderUnavailable',
  'EscrowConfirmationAmountMismatch',
  'EscrowConfirmationCurrencyMismatch',
  'EscrowConfirmationVersionMismatch'
);

-- CreateEnum: PaymentIntentFailureDetailCategory closed sanitized category.
--
-- The persisted column carries ONLY this enum value. Raw provider
-- exception text, stack traces, hostnames, secrets, or stack-frame
-- diagnostics are NEVER persisted (ticket #64 P1-004).
CREATE TYPE "PaymentIntentFailureDetailCategory" AS ENUM (
  'PROVIDER_UNAVAILABLE',
  'CONFIRMATION_INVALID',
  'CONFIRMATION_MISMATCH'
);

-- CreateTable: PaymentIntent durable SoundHub-owned record.
--
-- Per ticket #64 the intent exists BEFORE the provider call. The row
-- captures the exact Deal, the pinned current TermsVersion, the
-- expected amount/currency, truthful asset/network/environment labels,
-- a SoundHub-owned opaque correlationId, and the closed providerState.
-- The providerReference is nullable; the unique index is partial so
-- the column may remain NULL while providerState = "Created".
--
-- Per CONTEXT.md ("Preserve immutable terms, approvals, delivery
-- versions, and audit evidence in later milestones.") every
-- consequential reference uses ON DELETE RESTRICT.
CREATE TABLE "payment_intents" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "termsVersionId" TEXT NOT NULL,
    "actingWorkspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "expectedAmountMinor" INTEGER NOT NULL,
    "expectedCurrency" TEXT NOT NULL,
    "assetLabel" TEXT NOT NULL,
    "networkLabel" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "environmentLabel" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "providerReference" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "failureReasonCode" "PaymentIntentFailureReasonCode",
    "failureDetailCategory" "PaymentIntentFailureDetailCategory",
    "providerState" "PaymentIntentProviderState" NOT NULL DEFAULT 'Created',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: SoundHub-owned correlation identity (always present).
CREATE UNIQUE INDEX "payment_intents_correlationId_unique_idx"
  ON "payment_intents"("correlationId");

-- CreateIndex: Natural uniqueness — one durable intent per
-- (dealId, termsVersionId). A retried fundDeal command for the same
-- tuple converges on this row via find-or-create.
CREATE UNIQUE INDEX "payment_intents_deal_version_unique_idx"
  ON "payment_intents"("dealId", "termsVersionId");

-- CreateIndex: Provider reference uniqueness — partial unique so the
-- column may remain NULL while providerState = "Created". Two
-- confirmations with the same providerReference are blocked by this
-- index as the second defense against retry-driven duplicates.
CREATE UNIQUE INDEX "payment_intents_provider_reference_unique_idx"
  ON "payment_intents"("providerReference")
  WHERE "providerReference" IS NOT NULL;

-- CreateIndex: Lookup helpers.
CREATE INDEX "payment_intents_dealId_createdAt_idx" ON "payment_intents"("dealId", "createdAt");
CREATE INDEX "payment_intents_termsVersionId_idx" ON "payment_intents"("termsVersionId");
CREATE INDEX "payment_intents_actingWorkspaceId_idx" ON "payment_intents"("actingWorkspaceId");

-- AddForeignKey: PaymentIntent.deal → Deal
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_dealId_fkey"
  FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: PaymentIntent.termsVersion → TermsVersion
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_termsVersionId_fkey"
  FOREIGN KEY ("termsVersionId") REFERENCES "terms_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: PaymentIntent.actingWorkspace → Workspace
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_actingWorkspaceId_fkey"
  FOREIGN KEY ("actingWorkspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: PaymentIntent.createdByUser → UserAccount
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
