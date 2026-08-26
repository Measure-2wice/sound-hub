-- Buildathon Golden Slice 3 (BG3) persistence migration.
--
-- Adds the ProjectBrief + BriefSearchResult tables that own the
-- Matchmaker vertical slice. Per ticket #60 the brief is a
-- Workspace-owned record of the buyer's natural-language creative
-- need, including the validated required + preferred criteria the
-- AI boundary produced and the eligibility-determined search
-- results. Briefs are immutable so the ProjectRequest revalidation
-- step can rely on the persisted snapshot without trusting any
-- later mutation.
--
-- The required-criteria column is JSON because the M1 shared Zod
-- schema is the executable contract; the API layer validates the
-- stored JSON against `talentSearchRequiredCriteriaV1Schema` (and
-- the preferred counterpart) before reading any value back into a
-- service call. This keeps the persistence layer ignorant of the
-- schema's specific shape while letting the schema evolve.
--
-- Workspace.ownerUserId remains structurally present (BG1 leaves it
-- for M1.1 backward compatibility) but is NEVER consulted by the
-- authorization path; the brief is owned by the buyer Workspace
-- (GS 4 / GS 5 / GS 6) and a membership lookup at write time is the
-- only authority check the BG3 slice performs.

-- CreateTable
CREATE TABLE "project_briefs" (
    "id" TEXT NOT NULL,
    "buyerWorkspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "originalText" TEXT NOT NULL,
    "requiredCriteriaJson" JSONB NOT NULL,
    "preferredCriteriaJson" JSONB,
    "nonSearchRequirementsJson" JSONB,
    "aiProvider" TEXT NOT NULL,
    "aiModelId" TEXT,
    "aiFallbackUsed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief_search_results" (
    "id" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "resultPosition" INTEGER NOT NULL,
    "sellerId" TEXT NOT NULL,
    "sellerSnapshotJson" JSONB NOT NULL,
    "bestOfferingId" TEXT NOT NULL,
    "bestOfferingSnapshotJson" JSONB NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL,
    "matchReason" TEXT NOT NULL,
    "preferenceCoverageJson" JSONB,
    "textCoverageJson" JSONB,

    CONSTRAINT "brief_search_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_briefs_buyerWorkspaceId_createdAt_idx" ON "project_briefs"("buyerWorkspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "brief_search_results_briefId_resultPosition_key" ON "brief_search_results"("briefId", "resultPosition");

-- CreateIndex
CREATE INDEX "brief_search_results_briefId_idx" ON "brief_search_results"("briefId");

-- CreateIndex
CREATE INDEX "brief_search_results_sellerId_idx" ON "brief_search_results"("sellerId");

-- AddForeignKey
ALTER TABLE "project_briefs" ADD CONSTRAINT "project_briefs_buyerWorkspaceId_fkey" FOREIGN KEY ("buyerWorkspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_briefs" ADD CONSTRAINT "project_briefs_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_search_results" ADD CONSTRAINT "brief_search_results_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "project_briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
