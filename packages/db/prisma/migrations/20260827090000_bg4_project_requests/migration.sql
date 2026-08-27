-- Buildathon Golden Slice 4 (BG4) persistence migration.
--
-- Adds ProjectRequest and Deal. Per ticket #62 the ProjectRequest is
-- the buyer Workspace's invitation to a seller Workspace; the Deal is
-- created atomically when the seller accepts. The slice deliberately
-- does NOT introduce a generalized idempotency framework, messaging
-- infrastructure, or ProjectBrief revisions — the natural uniqueness
-- constraints and guarded state transitions below are sufficient.
--
-- ProjectRequest holds:
--   - buyerWorkspaceId / sellerWorkspaceId / serviceOfferingId / projectBriefId
--     (the durable selection identity)
--   - createdByUserId (the acting human who submitted the request)
--   - status (Pending | Accepted | Declined; Pending is the only
--     non-terminal state)
--   - sellerDecisionAt / sellerDecisionByUserId / sellerConsentAt
--     (seller response audit)
--
-- The partial unique index on Pending rows prevents retries from
-- creating inappropriate duplicate ProjectRequests (GS 26). Accepted
-- and Declined rows are terminal; a buyer who wants to re-engage the
-- same seller for the same brief and offering can submit a new
-- ProjectRequest without colliding with the terminal rows.
--
-- Deal holds:
--   - buyerWorkspaceId / sellerWorkspaceId / serviceOfferingId / projectBriefId
--     (copied from the accepted ProjectRequest so authorization can
--     revalidate them without joining through ProjectRequest)
--   - projectRequestId UNIQUE — exactly one Deal per accepted
--     ProjectRequest, regardless of retries.
--   - status (Negotiating | Active). BG4 only ever sets Negotiating.
--     The activation invariant is owned by a later ticket.
--   - activatedAt nullable; always null in BG4.
--
-- Both tables reference Workspace with Cascade delete so a deleted
-- Workspace removes its own ProjectRequests / Deals. References to
-- ServiceOffering and ProjectBrief use Restrict so an offering or
-- brief cannot be removed while requests still reference it.

-- CreateEnum
CREATE TYPE "ProjectRequestStatus" AS ENUM ('Pending', 'Accepted', 'Declined');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('Negotiating', 'Active');

-- CreateTable
CREATE TABLE "project_requests" (
    "id" TEXT NOT NULL,
    "buyerWorkspaceId" TEXT NOT NULL,
    "sellerWorkspaceId" TEXT NOT NULL,
    "serviceOfferingId" TEXT NOT NULL,
    "projectBriefId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "status" "ProjectRequestStatus" NOT NULL DEFAULT 'Pending',
    "sellerDecisionAt" TIMESTAMP(3),
    "sellerDecisionByUserId" TEXT,
    "sellerConsentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "buyerWorkspaceId" TEXT NOT NULL,
    "sellerWorkspaceId" TEXT NOT NULL,
    "serviceOfferingId" TEXT NOT NULL,
    "projectBriefId" TEXT NOT NULL,
    "projectRequestId" TEXT NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'Negotiating',
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_requests_buyerWorkspaceId_status_createdAt_idx" ON "project_requests"("buyerWorkspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "project_requests_sellerWorkspaceId_status_createdAt_idx" ON "project_requests"("sellerWorkspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "project_requests_serviceOfferingId_idx" ON "project_requests"("serviceOfferingId");

-- CreateIndex
CREATE INDEX "project_requests_projectBriefId_idx" ON "project_requests"("projectBriefId");

-- Partial unique index: prevent duplicate Pending ProjectRequests for
-- the same (buyer, seller, offering, brief) tuple. Terminal rows are
-- excluded so the buyer may re-engage after Accept/Decline without
-- colliding with the historical rows.
CREATE UNIQUE INDEX "project_requests_pending_unique_idx"
  ON "project_requests"("buyerWorkspaceId", "sellerWorkspaceId", "serviceOfferingId", "projectBriefId")
  WHERE "status" = 'Pending';

-- CreateIndex
CREATE UNIQUE INDEX "deals_projectRequestId_key" ON "deals"("projectRequestId");

-- CreateIndex
CREATE INDEX "deals_buyerWorkspaceId_status_createdAt_idx" ON "deals"("buyerWorkspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "deals_sellerWorkspaceId_status_createdAt_idx" ON "deals"("sellerWorkspaceId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_buyerWorkspaceId_fkey" FOREIGN KEY ("buyerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_sellerWorkspaceId_fkey" FOREIGN KEY ("sellerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_serviceOfferingId_fkey" FOREIGN KEY ("serviceOfferingId") REFERENCES "service_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_projectBriefId_fkey" FOREIGN KEY ("projectBriefId") REFERENCES "project_briefs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_sellerDecisionByUserId_fkey" FOREIGN KEY ("sellerDecisionByUserId") REFERENCES "user_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyerWorkspaceId_fkey" FOREIGN KEY ("buyerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_sellerWorkspaceId_fkey" FOREIGN KEY ("sellerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_serviceOfferingId_fkey" FOREIGN KEY ("serviceOfferingId") REFERENCES "service_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_projectBriefId_fkey" FOREIGN KEY ("projectBriefId") REFERENCES "project_briefs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_projectRequestId_fkey" FOREIGN KEY ("projectRequestId") REFERENCES "project_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;