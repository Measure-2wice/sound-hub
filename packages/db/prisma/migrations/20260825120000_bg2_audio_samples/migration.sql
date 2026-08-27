-- Buildathon Golden Slice 2 (BG2) audio discovery samples migration.
--
-- Adds `offering_audio_samples` for ticket #61. A ServiceOffering owns
-- zero through three MP3 discovery samples. PostgreSQL is canonical
-- for the metadata; the bounded object bytes live in replaceable
-- external storage (Supabase Storage in production; deterministic
-- fixtures in tests) referenced by an opaque `storageRef`. The
-- application enforces the 3-sample cap, the audio/mpeg-only content
-- type, and the 25 MB size cap at the trusted boundary; this schema
-- captures the values and the ownership graph.
--
-- The column-level constraints intentionally do NOT re-encode the
-- application rules above. PostgreSQL is the source of truth for the
-- data; the application boundary is the source of truth for the
-- limits. The opaque `storageRef` is opaque to the database (TEXT,
-- unbounded length) so a future adapter cannot be constrained away by
-- schema drift.

-- CreateTable
CREATE TABLE "offering_audio_samples" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "storageRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offering_audio_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offering_audio_samples_offeringId_idx" ON "offering_audio_samples"("offeringId");

-- AddForeignKey
ALTER TABLE "offering_audio_samples" ADD CONSTRAINT "offering_audio_samples_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;