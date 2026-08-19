-- M2.0B / Issue #16: Reconcile M1.1 workspace owners.
--
-- This migration completes the residual M1.1 → M2 authority reconciliation
-- not covered by the M2.0A expand migration (#15).
--
-- The M2.0A migration backfills `authority` from `role` for EXISTING
-- memberships (Owner → Owner, Admin/Member → Editor). However, it does
-- NOT create memberships for workspaces whose `ownerUserId` is set but
-- whose corresponding (userId, workspaceId) membership row does not exist.
-- This follow-up reconciliation creates the missing Owner memberships.
--
-- For each non-null legacy Workspace.ownerUserId:
--   - If no (userId, workspaceId) active membership exists: create one with
--     role=Owner, authority=Owner, removedAt=NULL.
--   - If the membership exists with non-Owner authority: reconcile authority
--     to Owner (leaving role unchanged — role is legacy correspondence).
--   - If it is already an active Owner membership: leave stable and do not
--     duplicate.
--
-- The reconciliation is deterministic and respects the unique
-- (userId, workspaceId) membership invariant via ON CONFLICT.
--
-- This migration is idempotent: it is safe to run against already-reconciled
-- or partially reconciled state. The retry/recovery procedure is proven by
-- the issue #16 transition tests.
--
-- The M1.1 `role` column is NOT rewritten merely to mirror `authority`.
-- The legacy `role` is preserved as correspondence data.

-- Step 1: Create missing Owner memberships for workspaces that have
-- ownerUserId set but no corresponding membership row at all.
--
-- The unique constraint on (userId, workspaceId) prevents duplication.
-- The ON CONFLICT clause makes this idempotent: re-running on an
-- already-reconciled workspace is a no-op.
INSERT INTO workspace_memberships (id, "userId", "workspaceId", role, authority, "createdAt")
SELECT
    'recon-owner-' || w.id,
    w."ownerUserId",
    w.id,
    'Owner'::"WorkspaceMembershipRole",
    'Owner'::"WorkspaceMembershipAuthority",
    NOW()
FROM workspaces w
WHERE w."ownerUserId" IS NOT NULL
AND NOT EXISTS (
    SELECT 1
    FROM workspace_memberships m
    WHERE m."userId" = w."ownerUserId"
      AND m."workspaceId" = w.id
)
ON CONFLICT ("userId", "workspaceId") DO NOTHING;

-- Step 2: Reconcile memberships where ownerUserId is set but the
-- membership exists with non-Owner authority. This handles the case
-- where a workspace's owner has a membership (perhaps created by
-- a prior non-reconciled invite flow) but the authority is not Owner.
--
-- Only active memberships are reconciled (removedAt IS NULL).
-- The role column is NOT updated: it is legacy correspondence and
-- does not become the M2 authority source.
UPDATE workspace_memberships m
SET authority = 'Owner'::"WorkspaceMembershipAuthority"
FROM workspaces w
WHERE w."ownerUserId" = m."userId"
  AND w.id = m."workspaceId"
  AND m.authority != 'Owner'::"WorkspaceMembershipAuthority"
  AND m."removedAt" IS NULL;
