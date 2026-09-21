-- Milestone 2 (#83): Intent selection and Seller participation acceptance
--
-- Adds the `seller_participation_acceptances` table that records the
-- versioned evidence a human accepted when they chose `Offer services` or
-- `Both`. Buyer capability is created without any acceptance row.
--
-- Schema-level constraints enforced at the database (not just in code):
--
--   1. `accepted_by_user_id` and `accepted_at` are NOT NULL. Every
--      acceptance row must carry an explicit human actor and a timestamp.
--
--   2. `UNIQUE (workspace_id, terms_version)` is the concurrency
--      authority. Two concurrent `Offer services` (or two concurrent
--      `Both`) submissions against the same (workspaceId, termsVersion)
--      cannot create a duplicate acceptance row. The application uses
--      `INSERT ... ON CONFLICT DO NOTHING RETURNING *` and never relies
--      on find-then-insert pre-checks for race correctness.
--
--   3. Foreign keys use ON DELETE RESTRICT so a Workspace, the accepting
--      UserAccount, or a future granting UserAccount cannot be removed
--      implicitly while the acceptance evidence still exists.
--
-- The table name itself is the DB-level restriction: this is the only
-- place Seller participation acceptance evidence is persisted. Buyer
-- capability is created without any acceptance row at any layer.
--
-- The migration creates the table; it does NOT backfill any rows. The
-- existing legacy Active offerings grandfather inventory (a later
-- milestone) handles its own pre-M2 records.

CREATE TABLE "seller_participation_acceptances" (
  "id"                  TEXT PRIMARY KEY,
  "workspace_id"        TEXT NOT NULL,
  "terms_version"       TEXT NOT NULL,
  "terms_content_hash"  TEXT NOT NULL,
  "accepted_by_user_id" TEXT NOT NULL,
  "granted_by_user_id"  TEXT NOT NULL,
  "accepted_at"         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seller_participation_acceptances_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "seller_participation_acceptances_accepted_by_user_id_fkey"
    FOREIGN KEY ("accepted_by_user_id") REFERENCES "user_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "seller_participation_acceptances_granted_by_user_id_fkey"
    FOREIGN KEY ("granted_by_user_id") REFERENCES "user_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- The unique (workspace_id, terms_version) index is the concurrency
-- authority. The application relies on `ON CONFLICT DO NOTHING` against
-- this index; a duplicate INSERT is silently absorbed and the existing
-- row is read back. A find-then-insert pre-check would not be sufficient
-- because two concurrent transactions can both pass the pre-check
-- before either INSERTs.
CREATE UNIQUE INDEX "seller_participation_acceptances_workspace_version_unique_idx"
  ON "seller_participation_acceptances"("workspace_id", "terms_version");

CREATE INDEX "seller_participation_acceptances_workspace_id_idx"
  ON "seller_participation_acceptances"("workspace_id");

CREATE INDEX "seller_participation_acceptances_accepted_by_user_id_idx"
  ON "seller_participation_acceptances"("accepted_by_user_id");
