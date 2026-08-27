-- Buildathon Golden Slice 4 (BG4): restrict cascades that erased consent.
--
-- Per the Codex review of ticket #62 (P1-004), the original BG4
-- migration declared `ON DELETE CASCADE` for the Workspace foreign
-- keys on both `project_requests` and `deals`, plus `ON DELETE SET
-- NULL` for `project_requests.sellerDecisionByUserId`. Those
-- cascade rules could destroy accepted ProjectRequests, their
-- associated Deals, and the explicit seller-consent attribution
-- whenever the owning Workspace or deciding UserAccount was
-- removed. CONTEXT.md requires preserving immutable terms,
-- approvals, delivery versions, and audit evidence in later
-- milestones; the slice must fail closed rather than erase them.
--
-- This migration replaces those cascade rules with `RESTRICT` so
-- removing a referenced Workspace, ProjectRequest, or deciding
-- UserAccount fails at the database boundary and the application
-- must explicitly close any consequential records before deletion.
-- Workspace removal is out-of-scope for the buildathon; archival
-- semantics will land in a later ticket.

-- Drop the Workspace-cascading FKs on project_requests and recreate
-- them with ON DELETE RESTRICT.
ALTER TABLE "project_requests" DROP CONSTRAINT "project_requests_buyerWorkspaceId_fkey";
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_buyerWorkspaceId_fkey"
  FOREIGN KEY ("buyerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_requests" DROP CONSTRAINT "project_requests_sellerWorkspaceId_fkey";
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_sellerWorkspaceId_fkey"
  FOREIGN KEY ("sellerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Replace SET NULL with RESTRICT so the deciding UserAccount cannot
-- be removed while the ProjectRequest still records the consent
-- attribution.
ALTER TABLE "project_requests" DROP CONSTRAINT "project_requests_sellerDecisionByUserId_fkey";
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_sellerDecisionByUserId_fkey"
  FOREIGN KEY ("sellerDecisionByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Drop the Workspace-cascading FKs on deals and recreate them with
-- ON DELETE RESTRICT.
ALTER TABLE "deals" DROP CONSTRAINT "deals_buyerWorkspaceId_fkey";
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyerWorkspaceId_fkey"
  FOREIGN KEY ("buyerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deals" DROP CONSTRAINT "deals_sellerWorkspaceId_fkey";
ALTER TABLE "deals" ADD CONSTRAINT "deals_sellerWorkspaceId_fkey"
  FOREIGN KEY ("sellerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Replace ProjectRequest → Deal CASCADE with RESTRICT so the
-- accepted engagement cannot be erased by deleting the originating
-- request.
ALTER TABLE "deals" DROP CONSTRAINT "deals_projectRequestId_fkey";
ALTER TABLE "deals" ADD CONSTRAINT "deals_projectRequestId_fkey"
  FOREIGN KEY ("projectRequestId") REFERENCES "project_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;