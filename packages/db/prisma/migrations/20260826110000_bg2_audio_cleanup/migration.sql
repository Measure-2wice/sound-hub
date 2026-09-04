-- Buildathon Golden Slice 2 (BG2) audio-cleanup lifecycle migration.
--
-- Per ticket #61 follow-up review (P1-005), removal must hide the
-- sample from discovery immediately while durably retaining enough
-- information to retry object deletion if the storage provider is
-- unavailable. Adds a bounded cleanup-lifecycle column to
-- `offering_audio_samples` and an index that lets a future bounded
-- retry query find pending samples efficiently.
--
-- The migration is forward-compatible: existing rows default to
-- `Live` with zero attempts and no recorded failure. The bounded
-- retry path that consumes these columns is implemented in the
-- application service (no generalized job infrastructure).

-- CreateEnum
CREATE TYPE "AudioSampleCleanupStatus" AS ENUM ('Live', 'PendingCleanup', 'Removed');

-- AlterTable
ALTER TABLE "offering_audio_samples"
  ADD COLUMN "cleanupStatus" "AudioSampleCleanupStatus" NOT NULL DEFAULT 'Live',
  ADD COLUMN "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cleanupLastFailureAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "offering_audio_samples_cleanupStatus_idx" ON "offering_audio_samples"("cleanupStatus");