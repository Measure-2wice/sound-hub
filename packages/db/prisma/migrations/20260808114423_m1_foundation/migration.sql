-- CreateEnum
CREATE TYPE "WorkspaceType" AS ENUM ('Personal', 'Organization');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('Active', 'Suspended');

-- CreateEnum
CREATE TYPE "WorkspaceMembershipRole" AS ENUM ('Owner', 'Admin', 'Member');

-- CreateEnum
CREATE TYPE "MarketplaceCapability" AS ENUM ('Buyer', 'Seller');

-- CreateEnum
CREATE TYPE "SellerProfileStatus" AS ENUM ('Draft', 'Published', 'Suspended');

-- CreateEnum
CREATE TYPE "ServiceOfferingStatus" AS ENUM ('Draft', 'Active', 'Paused', 'Archived');

-- CreateEnum
CREATE TYPE "ServiceMode" AS ENUM ('Remote', 'InPerson', 'Hybrid');

-- CreateEnum
CREATE TYPE "PricingKind" AS ENUM ('StartingAt', 'Fixed', 'ContactForQuote');

-- CreateEnum
CREATE TYPE "PurchaseMode" AS ENUM ('BundleOnly');

-- CreateTable
CREATE TABLE "user_accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WorkspaceType" NOT NULL,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'Active',
    "ownerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" "WorkspaceMembershipRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_capabilities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "capability" "MarketplaceCapability" NOT NULL,

    CONSTRAINT "workspace_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_profiles" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "professionalName" TEXT NOT NULL,
    "bio" TEXT NOT NULL,
    "status" "SellerProfileStatus" NOT NULL DEFAULT 'Draft',
    "basedInCity" TEXT,
    "basedInRegion" TEXT,
    "basedInCountryCode" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialties" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "specialties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_profile_specialties" (
    "sellerProfileId" TEXT NOT NULL,
    "specialtyId" TEXT NOT NULL,

    CONSTRAINT "seller_profile_specialties_pkey" PRIMARY KEY ("sellerProfileId","specialtyId")
);

-- CreateTable
CREATE TABLE "caribbean_affiliations" (
    "id" TEXT NOT NULL,
    "sellerProfileId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,

    CONSTRAINT "caribbean_affiliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_categories" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "bundleOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_units" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_offerings" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sellerProfileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ServiceOfferingStatus" NOT NULL DEFAULT 'Draft',
    "serviceMode" "ServiceMode" NOT NULL,
    "primaryCategoryId" TEXT NOT NULL,
    "genreTags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "included_services" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "purchaseMode" "PurchaseMode" NOT NULL,

    CONSTRAINT "included_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offering_service_areas" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "city" TEXT,
    "region" TEXT,
    "countryCode" TEXT NOT NULL,

    CONSTRAINT "offering_service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offering_pricing" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "kind" "PricingKind" NOT NULL,
    "amountMinor" INTEGER,
    "currency" TEXT,
    "unitId" TEXT,

    CONSTRAINT "offering_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seed_markers" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "seededAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seed_markers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_accounts_email_key" ON "user_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_memberships_userId_workspaceId_key" ON "workspace_memberships"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_capabilities_workspaceId_capability_key" ON "workspace_capabilities"("workspaceId", "capability");

-- CreateIndex
CREATE UNIQUE INDEX "seller_profiles_workspaceId_key" ON "seller_profiles"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "specialties_key_key" ON "specialties"("key");

-- CreateIndex
CREATE INDEX "caribbean_affiliations_countryCode_idx" ON "caribbean_affiliations"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "caribbean_affiliations_sellerProfileId_countryCode_key" ON "caribbean_affiliations"("sellerProfileId", "countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_key_key" ON "service_categories"("key");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_units_key_key" ON "pricing_units"("key");

-- CreateIndex
CREATE UNIQUE INDEX "service_offerings_slug_key" ON "service_offerings"("slug");

-- CreateIndex
CREATE INDEX "service_offerings_sellerProfileId_idx" ON "service_offerings"("sellerProfileId");

-- CreateIndex
CREATE INDEX "service_offerings_primaryCategoryId_idx" ON "service_offerings"("primaryCategoryId");

-- CreateIndex
CREATE INDEX "service_offerings_status_idx" ON "service_offerings"("status");

-- CreateIndex
CREATE UNIQUE INDEX "included_services_offeringId_categoryId_key" ON "included_services"("offeringId", "categoryId");

-- CreateIndex
CREATE INDEX "offering_service_areas_offeringId_idx" ON "offering_service_areas"("offeringId");

-- CreateIndex
CREATE INDEX "offering_service_areas_countryCode_idx" ON "offering_service_areas"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "offering_pricing_offeringId_key" ON "offering_pricing"("offeringId");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_capabilities" ADD CONSTRAINT "workspace_capabilities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_profile_specialties" ADD CONSTRAINT "seller_profile_specialties_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_profile_specialties" ADD CONSTRAINT "seller_profile_specialties_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "caribbean_affiliations" ADD CONSTRAINT "caribbean_affiliations_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offerings" ADD CONSTRAINT "service_offerings_sellerProfileId_fkey" FOREIGN KEY ("sellerProfileId") REFERENCES "seller_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_offerings" ADD CONSTRAINT "service_offerings_primaryCategoryId_fkey" FOREIGN KEY ("primaryCategoryId") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "included_services" ADD CONSTRAINT "included_services_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "included_services" ADD CONSTRAINT "included_services_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_service_areas" ADD CONSTRAINT "offering_service_areas_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_pricing" ADD CONSTRAINT "offering_pricing_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "service_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_pricing" ADD CONSTRAINT "offering_pricing_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "pricing_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
