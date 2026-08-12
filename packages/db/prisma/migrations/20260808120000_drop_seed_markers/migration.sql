-- Drop the SeedMarker table; the deterministic seed no longer uses a
-- marker row. Idempotence is provided by deterministic upserts on stable
-- unique keys plus an invariant check at the end of the seed.
DROP TABLE IF EXISTS "seed_markers";
