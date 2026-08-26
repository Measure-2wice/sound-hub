-- Buildathon Golden Slice 3 (BG3) follow-up: persist the
-- Matchmaker criteria `query` axis alongside the required /
-- preferred / non-search columns so a brief whose validated
-- criteria carry only a query (e.g. the deterministic fallback when
-- the buyer named no recognised category / location / service
-- mode) round-trips through the BG3 schema without dropping the
-- axis. Without this column, toPersistedBrief reconstructs an
-- invalid criteria object and both POST and GET /api/matchmaker/brief
-- return MATCHMAKER_FAILED for query-only briefs.
ALTER TABLE "project_briefs" ADD COLUMN "criteriaQueryJson" JSONB;
