-- M2 (#86): ServiceOfferingPause + ServiceOfferingUpdate evidence tables.
--
-- This migration is purely additive. No existing rows are rewritten,
-- no fabricated pricing / audio / confirmation / attestation data is
-- inserted, and no grandfathering flag is added. The grandfathered
-- Active nonconformance derivation lives in the application layer and
-- is computed at read time.
--
-- The two new tables follow the existing narrow append-only evidence
-- pattern (`service_offering_activations`, `service_offering_creations`,
-- `seller_profile_publications`). Each successful lifecycle command
-- produces ONE row; same-attempt retry transport duplicates are rejected
-- by the (offeringId, idempotencyKey) unique constraint.
--
-- ON DELETE RESTRICT on every FK preserves the durable evidence row
-- even if the source UserAccount, Workspace, or SellerProfile is
-- hard-deleted.
--
-- Per CLAUDE.md "Do not use `prisma db push` as a substitute for a
-- reviewed migration", this SQL is the reviewed shape.

-- ---------- Closed enum: ServiceOfferingPauseReason ----------
--
-- The closed set of reasons a ServiceOfferingPause evidence row can
-- carry. `user_initiated` covers explicit seller Pause commands; the
-- `final_sample_removal` reason records the automatic Active → Paused
-- transition triggered by removing the last qualifying sample from an
-- Active offering. The closed set prevents fabrication of alternative
-- reasons.
CREATE TYPE "ServiceOfferingPauseReason" AS ENUM (
  'user_initiated',
  'final_sample_removal'
);

-- ---------- ServiceOfferingPause ----------
--
-- Pause authorization is INDEPENDENT of activation completeness —
-- a grandfathered nonconforming Active offering must remain pausable.
-- Pause therefore records only the facts established by the Pause
-- command and does NOT carry an activation `confirmationVersion`
-- column. Fabricating such a column would invent an attestation the
-- Pause command did not invoke.
CREATE TABLE "service_offering_pauses" (
  "id"              TEXT NOT NULL,
  "offeringId"      TEXT NOT NULL,
  "workspaceId"     TEXT NOT NULL,
  "sellerProfileId" TEXT NOT NULL,
  "pausedByUserId"  TEXT NOT NULL,
  "pausedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason"          "ServiceOfferingPauseReason" NOT NULL,
  "idempotencyKey"  TEXT NOT NULL,
  "requestId"       TEXT NOT NULL,

  CONSTRAINT "service_offering_pauses_pkey" PRIMARY KEY ("id")
);

-- Same-attempt retry convergence. A transport retry after a lost
-- response reuses the same idempotencyKey; the unique constraint
-- rejects the duplicate INSERT and the service converges on the
-- already-persisted row.
CREATE UNIQUE INDEX "service_offering_pauses_offering_idem_unique_idx"
  ON "service_offering_pauses" ("offeringId", "idempotencyKey");

-- Latest-evidence lookup: "what is the most recent pause for this
-- offering?". ORDER BY pausedAt DESC plus this index supports the
-- editor on-mount reads and the audit surface.
CREATE INDEX "service_offering_pauses_offering_pausedAt_idx"
  ON "service_offering_pauses" ("offeringId", "pausedAt" DESC);

-- Workspace scope index for membership-validated read paths.
CREATE INDEX "service_offering_pauses_workspace_idx"
  ON "service_offering_pauses" ("workspaceId");

-- Foreign keys. ON DELETE RESTRICT preserves the durable evidence row.
ALTER TABLE "service_offering_pauses"
  ADD CONSTRAINT "service_offering_pauses_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_offering_pauses"
  ADD CONSTRAINT "service_offering_pauses_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_offering_pauses"
  ADD CONSTRAINT "service_offering_pauses_sellerProfileId_fkey"
  FOREIGN KEY ("sellerProfileId") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_offering_pauses"
  ADD CONSTRAINT "service_offering_pauses_pausedByUserId_fkey"
  FOREIGN KEY ("pausedByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- ServiceOfferingUpdate ----------
--
-- Required for durable same-idempotency-key retry convergence on the
-- `updateActive` command. A successful Active → Active update does
-- NOT rewrite or create ServiceOfferingActivation evidence; the
-- activation timestamp from the original Draft → Active transition
-- is preserved verbatim per ADR 0008.
--
-- `confirmationVersion` carries the same closed enum value as
-- activation ("m2-service-activation-v1") because `updateActive`
-- re-runs the complete activation contract.
CREATE TABLE "service_offering_updates" (
  "id"                  TEXT NOT NULL,
  "offeringId"          TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,
  "sellerProfileId"     TEXT NOT NULL,
  "updatedByUserId"     TEXT NOT NULL,
  "confirmationVersion" TEXT NOT NULL,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey"      TEXT NOT NULL,
  "requestId"           TEXT NOT NULL,

  CONSTRAINT "service_offering_updates_pkey" PRIMARY KEY ("id")
);

-- Same-attempt retry convergence. A transport retry after a lost
-- response reuses the same idempotencyKey; the unique constraint
-- rejects the duplicate INSERT and the service converges on the
-- already-persisted row.
CREATE UNIQUE INDEX "service_offering_updates_offering_idem_unique_idx"
  ON "service_offering_updates" ("offeringId", "idempotencyKey");

-- Latest-evidence lookup: "what is the most recent update for this
-- offering?". ORDER BY updatedAt DESC plus this index supports the
-- editor on-mount reads and the audit surface.
CREATE INDEX "service_offering_updates_offering_updatedAt_idx"
  ON "service_offering_updates" ("offeringId", "updatedAt" DESC);

-- Workspace scope index for membership-validated read paths.
CREATE INDEX "service_offering_updates_workspace_idx"
  ON "service_offering_updates" ("workspaceId");

-- Foreign keys. ON DELETE RESTRICT preserves the durable evidence row.
ALTER TABLE "service_offering_updates"
  ADD CONSTRAINT "service_offering_updates_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_offering_updates"
  ADD CONSTRAINT "service_offering_updates_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_offering_updates"
  ADD CONSTRAINT "service_offering_updates_sellerProfileId_fkey"
  FOREIGN KEY ("sellerProfileId") REFERENCES "seller_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_offering_updates"
  ADD CONSTRAINT "service_offering_updates_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
