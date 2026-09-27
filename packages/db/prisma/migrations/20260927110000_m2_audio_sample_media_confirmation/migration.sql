-- M2 (#85) PR-review feedback: durable media-use confirmation per audio sample.
--
-- Per ticket #85 acceptance criterion "Each upload records current
-- versioned media-use confirmation; customer copy states that
-- confirmation neither proves nor transfers ownership", each uploaded
-- audio sample must carry a durable record of the seller's
-- confirmation version, the actor who confirmed it, and the timestamp
-- of the confirmation. The previous schema captured none of these
-- fields; the editor rendered a pre-checked checkbox that submitted
-- nothing, and the upload accepted any sample without a confirmation
-- record. Activation then counted those samples without evidence.
--
-- This migration adds three columns to `offering_audio_samples`:
--   - `confirmationVersion` (TEXT) — the closed enum value the seller
--     confirmed against (e.g. `m2-audio-confirmation-v1`).
--   - `confirmedByUserId`   (TEXT, FK -> user_accounts.id, RESTRICT) —
--     the acting human who clicked the confirmation checkbox. The
--     FK preserves audit attribution even if the user is later
--     hard-deleted (the activation invariant re-validates current
--     membership, so a deleted user does not authorize a future
--     upload — but the historical confirmation stays durable).
--   - `confirmedAt` (TIMESTAMPTZ(3)) — when the confirmation was
--     recorded. Defaults to NULL on existing rows because pre-migration
--     samples have no recorded confirmation; the activation completeness
--     check counts only samples where `confirmationVersion IS NOT NULL`
--     AND `confirmedAt IS NOT NULL`, so legacy samples do not satisfy
--     the activation gate without an explicit re-upload.
--
-- A partial index covers the activation recheck:
--   - Filtered to Live samples so the activation read stays narrow.
--   - Two-column so the rare "wrong-version confirmation" lookup
--     stays bounded without scanning the table.
--
-- Per CLAUDE.md "Do not use `prisma db push` as a substitute for a
-- reviewed migration", this SQL is the reviewed shape.

ALTER TABLE "offering_audio_samples"
  ADD COLUMN "confirmationVersion" TEXT;

ALTER TABLE "offering_audio_samples"
  ADD COLUMN "confirmedByUserId" TEXT;

ALTER TABLE "offering_audio_samples"
  ADD COLUMN "confirmedAt" TIMESTAMP(3);

ALTER TABLE "offering_audio_samples"
  ADD CONSTRAINT "offering_audio_samples_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "user_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "offering_audio_samples_confirmation_idx"
  ON "offering_audio_samples" ("offeringId", "confirmationVersion")
  WHERE "cleanupStatus" = 'Live';
