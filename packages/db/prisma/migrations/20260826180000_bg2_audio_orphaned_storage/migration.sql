-- Buildathon Golden Slice 2 (BG2) orphaned-storage-locator migration.
--
-- Per ticket #61 follow-up review (P1-002): when an upload succeeds
-- in storage but the DB counterpart never persists and the immediate
-- storage-delete also fails, the storage reference would otherwise be
-- lost. This table is the durable recovery record: a row keyed by
-- `storageRef` carries the offering id and a bounded retry counter so
-- the next operation against the offering can discover and complete
-- the storage-side cleanup. Rows are deleted when the storage-side
-- delete confirms success or the storage object is reported
-- already-gone.
--
-- The migration is forward-compatible: existing rows do not exist.
-- The application writes a row only when the orphan condition is
-- observed at the trusted boundary, so a healthy deployment never
-- produces rows here.

-- CreateTable
CREATE TABLE "audio_sample_orphaned_storage" (
    "storageRef" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
    "cleanupLastFailureAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audio_sample_orphaned_storage_pkey" PRIMARY KEY ("storageRef")
);

-- CreateIndex
CREATE INDEX "audio_sample_orphaned_storage_offeringId_idx" ON "audio_sample_orphaned_storage"("offeringId");

-- AddForeignKey
ALTER TABLE "audio_sample_orphaned_storage" ADD CONSTRAINT "audio_sample_orphaned_storage_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
