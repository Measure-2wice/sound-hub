-- M2 (#85) PR-review feedback: durable creation-evidence table for
-- the lazy first-create flow.
--
-- The repository's `createDraft` opens one Prisma transaction and
-- inserts a row here alongside the new `service_offerings` row.
-- The (workspaceId, idempotencyKey) unique constraint is the
-- second defense against transport-retry duplicates; the
-- application-layer pre-check is the first. Mirrors the
-- `service_offering_activations` table from the original #85
-- implementation.
--
-- Per CLAUDE.md "Do not use `prisma db push` as a substitute for a
-- reviewed migration", this SQL is the reviewed shape.

CREATE TABLE "service_offering_creations" (
    "id"              TEXT PRIMARY KEY,
    "offeringId"      TEXT NOT NULL,
    "workspaceId"     TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey"  TEXT NOT NULL,
    "requestId"       TEXT NOT NULL,

    CONSTRAINT "service_offering_creations_offeringId_fkey"
      FOREIGN KEY ("offeringId")      REFERENCES "service_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "service_offering_creations_workspaceId_fkey"
      FOREIGN KEY ("workspaceId")     REFERENCES "workspaces"("id")       ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "service_offering_creations_createdByUserId_fkey"
      FOREIGN KEY ("createdByUserId") REFERENCES "user_accounts"("id")    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "service_offering_creations_workspace_idem_unique_idx"
  ON "service_offering_creations" ("workspaceId", "idempotencyKey");

CREATE INDEX "service_offering_creations_offering_idx"
  ON "service_offering_creations" ("offeringId");
