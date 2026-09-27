-- Milestone 2 (#85): make serviceMode and primaryCategoryId nullable
-- on ServiceOffering so a Draft can save with neither chosen yet.
-- Activation still requires both (the trusted boundary enforces it
-- via the STRICT activate schema) and the M1 search filter already
-- restricts Active offerings to the canonical taxonomy, so the
-- Active-row nullable constraint never produced search results.
ALTER TABLE "service_offerings"
  ALTER COLUMN "serviceMode" DROP NOT NULL;
ALTER TABLE "service_offerings"
  ALTER COLUMN "primaryCategoryId" DROP NOT NULL;
