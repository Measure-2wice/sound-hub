-- Buildathon Golden Slice 3 (BG3) follow-up: persist up to two
-- additional matching offerings per BriefSearchResult. The
-- TalentSearchService returns up to two standalone matching
-- offerings per seller alongside the best match; without this
-- column the application layer discards them and the buyer only
-- sees the best matching offering in the results view.
ALTER TABLE "brief_search_results" ADD COLUMN "additionalOfferingsJson" JSONB NOT NULL DEFAULT '[]'::jsonb;
