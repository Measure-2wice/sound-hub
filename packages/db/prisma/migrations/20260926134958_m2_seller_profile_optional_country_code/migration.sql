-- Milestone 2 (#84): allow SellerProfile.basedInCountryCode to be
-- unset on a partial Draft.
--
-- Per M2 #84 "Incomplete pre-publication Drafts remain private,
-- resumable, absent from public DTOs, and presented as Private
-- draft." A seller must be able to save a Draft without ever
-- selecting a country (and without the editor fabricating an
-- "US" default). Publish / update completeness continues to
-- enforce a country at the trusted Zod boundary.
--
-- The column stays on the table — existing rows retain their
-- values; only the NOT NULL constraint is dropped. New Drafts can
-- have NULL basedInCountryCode until the seller chooses one.

ALTER TABLE "seller_profiles" ALTER COLUMN "basedInCountryCode" DROP NOT NULL;
