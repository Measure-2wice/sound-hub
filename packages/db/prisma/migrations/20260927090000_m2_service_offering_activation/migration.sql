-- Milestone 2 (#85): ServiceOffering activation evidence + retry identity.
--
-- Adds ONE narrow append-only table for immutable activation attestation
-- (mirrors the SellerProfilePublication evidence pattern at
-- packages/db/prisma/migrations/20260925090000_m2_seller_profile_publication
-- and the DealApproval evidence pattern at packages/db/prisma/schema.prisma
-- around line 1092). Each successful activation creates one row bound to
-- the (acting UserAccount, acting Workspace, ServiceOffering,
-- SellerProfile, confirmation version, idempotencyKey, requestId).
--
-- The (offeringId, idempotencyKey) unique constraint is the second
-- defense against retries creating duplicate evidence; the first defense
-- is the application-layer pre-transaction check in
-- ServiceOfferingService.activate.
--
-- ON DELETE RESTRICT on every FK preserves the durable evidence row
-- even if the source UserAccount, Workspace, SellerProfile, or
-- ServiceOffering is ever hard-deleted. No new persistent
-- "ActivationReview" lifecycle state is added — readiness remains a
-- derived presentation computed from durable records.

CREATE TABLE "service_offering_activations" (
  "id"                  TEXT NOT NULL,
  "offeringId"          TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,
  "sellerProfileId"     TEXT NOT NULL,
  "activatedByUserId"   TEXT NOT NULL,
  "confirmationVersion" TEXT NOT NULL,
  "activatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey"      TEXT NOT NULL,
  "requestId"           TEXT NOT NULL,
  CONSTRAINT "service_offering_activations_pkey" PRIMARY KEY ("id")
);

-- Same-attempt retry convergence. A transport retry after a lost
-- response reuses the same idempotencyKey; the unique constraint
-- rejects the duplicate INSERT and the service converges on the
-- already-persisted row.
CREATE UNIQUE INDEX "service_offering_activations_offering_idem_unique_idx"
  ON "service_offering_activations"("offeringId", "idempotencyKey");

-- Latest-evidence lookup: "what is the most recent activation for
-- this offering?". ORDER BY activatedAt DESC plus this index supports
-- the editor / dashboard readiness reads.
CREATE INDEX "service_offering_activations_offering_activatedAt_idx"
  ON "service_offering_activations"("offeringId", "activatedAt" DESC);

-- Per-Workspace lookup for the future dashboard activation
-- history surface (out of #85 scope; index reserved).
CREATE INDEX "service_offering_activations_workspace_idx"
  ON "service_offering_activations"("workspaceId");

ALTER TABLE "service_offering_activations"
  ADD CONSTRAINT "service_offering_activations_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_offering_activations"
  ADD CONSTRAINT "service_offering_activations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_offering_activations"
  ADD CONSTRAINT "service_offering_activations_sellerProfileId_fkey"
  FOREIGN KEY ("sellerProfileId") REFERENCES "seller_profiles"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_offering_activations"
  ADD CONSTRAINT "service_offering_activations_activatedByUserId_fkey"
  FOREIGN KEY ("activatedByUserId") REFERENCES "user_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
