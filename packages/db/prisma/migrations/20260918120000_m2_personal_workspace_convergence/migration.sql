-- Milestone 2 (#82): Personal Workspace Convergence
--
-- Adds the `personalWorkspaceId` column to `user_accounts` with a UNIQUE
-- constraint and a foreign key to `workspaces.id` (ON DELETE RESTRICT).
-- The unique constraint is the durable boundary that enforces "at most
-- one Personal Workspace per UserAccount" at the DB level. The compare-
-- and-set UPDATE in PersonalWorkspaceConvergenceService (apps/api/src/
-- services/personal-workspace-convergence.service.ts) is the atomic
-- serialization point that guarantees concurrent first-auth attempts
-- converge on the same Workspace + Owner membership without orphan rows.
--
-- Backfill rule (strict — no guessing):
--   Link `personalWorkspaceId` only when exactly ONE qualifying Owner
--   Personal Workspace membership exists for the UserAccount. Zero or
--   multiple candidates → leave `personalWorkspaceId` NULL (the latter
--   is the recovery state — multiple candidates must not auto-select
--   per the M2 spec). `ownerUserId` may assist reconciliation by joining
--   to the legacy Personal Workspace (mirroring the BG1 pattern), but
--   `ownerUserId` never establishes authority by itself.
--
-- Bounded operational inventory (NOTICE block): the migration reports
-- `linked_count`, `zero_candidate_count`, and `ambiguous_count`. These
-- are bounded counts; the migration does NOT assert specific values
-- because the migration may run on a fresh DB before any seed data is
-- present. Operators inspect the NOTICE for unexpected patterns.

-- Step 1: add the column nullable (no constraint yet, so legacy rows
-- can coexist during backfill).
ALTER TABLE "user_accounts" ADD COLUMN "personalWorkspaceId" TEXT;

-- Step 2: backfill. The CTE picks each UserAccount's unique Personal
-- Workspace Owner membership. The NOT EXISTS subquery rejects any user
-- with 2+ candidates so ambiguous legacy rows are NEVER auto-linked.
UPDATE "user_accounts" AS ua
SET "personalWorkspaceId" = sub.ws_id
FROM (
  SELECT m."userId" AS uid, m."workspaceId" AS ws_id
  FROM "workspace_memberships" m
  INNER JOIN "workspaces" w ON w."id" = m."workspaceId"
  WHERE m."role" = 'Owner' AND w."type" = 'Personal'
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_memberships" m2
    INNER JOIN "workspaces" w2 ON w2."id" = m2."workspaceId"
    WHERE m2."userId" = m."userId"
      AND m2."role" = 'Owner'
      AND w2."type" = 'Personal'
      AND m2."workspaceId" != m."workspaceId"
  )
) AS sub
WHERE ua."id" = sub.uid AND ua."personalWorkspaceId" IS NULL;

-- Step 3: enforce uniqueness. The compare-and-set UPDATE in the
-- convergence service prevents duplicate creation at the application
-- layer; this index is the durable defense-in-depth boundary.
CREATE UNIQUE INDEX "user_accounts_personalWorkspaceId_key"
  ON "user_accounts"("personalWorkspaceId");

-- Step 4: enforce referential integrity. ON DELETE RESTRICT prevents
-- a Personal Workspace from being detached implicitly; explicit
-- handling is required if removal is ever authorized.
ALTER TABLE "user_accounts"
  ADD CONSTRAINT "user_accounts_personalWorkspaceId_fkey"
  FOREIGN KEY ("personalWorkspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Step 5: bounded operational inventory. The counts are reported via
-- PostgreSQL NOTICE for operator audit; the migration does NOT assert
-- specific values because it may run on a fresh DB before any seed.
DO $$
DECLARE
  linked_count INTEGER;
  zero_candidate_count INTEGER;
  ambiguous_count INTEGER;
BEGIN
  -- Count UserAccounts that were backfilled (now non-NULL).
  SELECT COUNT(*) INTO linked_count
  FROM "user_accounts"
  WHERE "personalWorkspaceId" IS NOT NULL;

  -- Count UserAccounts with zero Owner Personal memberships (no candidate).
  SELECT COUNT(*) INTO zero_candidate_count
  FROM "user_accounts" ua
  WHERE ua."personalWorkspaceId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "workspace_memberships" m
    INNER JOIN "workspaces" w ON w."id" = m."workspaceId"
    WHERE m."userId" = ua."id" AND m."role" = 'Owner' AND w."type" = 'Personal'
  );

  -- Count UserAccounts with multiple Owner Personal memberships (ambiguous).
  -- Count DISTINCT UserAccounts so a user with two candidates contributes
  -- one and a user with three also contributes one — counting membership
  -- rows over-counts the affected population.
  SELECT COUNT(DISTINCT m."userId") INTO ambiguous_count
  FROM "workspace_memberships" m
  INNER JOIN "workspaces" w ON w."id" = m."workspaceId"
  WHERE m."role" = 'Owner' AND w."type" = 'Personal'
  AND EXISTS (
    SELECT 1 FROM "workspace_memberships" m2
    INNER JOIN "workspaces" w2 ON w2."id" = m2."workspaceId"
    WHERE m2."userId" = m."userId"
      AND m2."role" = 'Owner'
      AND w2."type" = 'Personal'
      AND m2."workspaceId" != m."workspaceId"
  );

  RAISE NOTICE 'M2 personal workspace backfill: linked_count=%, zero_candidate_count=%, ambiguous_count=%',
    linked_count, zero_candidate_count, ambiguous_count;
END $$;
