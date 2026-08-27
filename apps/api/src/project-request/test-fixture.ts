// BG4 repository-test fixture helper.
//
// Background: the Prisma adapter integration tests run against a
// real disposable PostgreSQL database and need a known buyer /
// seller / offering / brief tuple to seed. Rather than depend on
// the deterministic seed (which only provisions the BG1 demo
// buyer and a single canonical seller), this helper creates its
// own stable IDs and is idempotent across test runs.
//
// The fixture is intentionally separate from the production seed
// so the repository tests can exercise every combination (e.g.,
// multiple ProjectBrief rows, multiple offerings, multiple buyer
// Workspaces) without polluting the canonical M1 fixture.

import type { PrismaClient } from "@soundhub/db";

export interface ProjectRequestFixture {
  readonly buyerUser: { readonly id: string; readonly email: string };
  readonly buyerWorkspace: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  };
  readonly sellerUser: { readonly id: string; readonly email: string };
  readonly sellerWorkspace: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
  };
  readonly sellerProfile: { readonly id: string };
  readonly offering: { readonly id: string; readonly slug: string };
  readonly brief: { readonly id: string };
}

const BUYER_USER_ID = "user-bg4-test-buyer";
const BUYER_EMAIL = "bg4-test-buyer@example.com";
const BUYER_WORKSPACE_ID = "ws-bg4-test-buyer";
const BUYER_WORKSPACE_SLUG = "bg4-test-buyer";

const SELLER_USER_ID = "user-bg4-test-seller";
const SELLER_EMAIL = "bg4-test-seller@example.com";
const SELLER_WORKSPACE_ID = "ws-bg4-test-seller";
const SELLER_WORKSPACE_SLUG = "bg4-test-seller";

const SELLER_PROFILE_ID = "sp-bg4-test-seller";
const OFFERING_ID = "of-bg4-test-seller";
const OFFERING_SLUG = "bg4-test-seller-offering";
const BRIEF_ID = "brief-bg4-test-1";

export async function loadOrCreateFixture(prisma: PrismaClient): Promise<ProjectRequestFixture> {
  // Ensure a single deterministic ProjectCategory exists so the
  // ServiceOffering primaryCategory FK is satisfiable. The
  // canonical M1 seed also provisions this row; the upsert here is
  // idempotent regardless of which seed ran first.
  const category = await prisma.serviceCategory.upsert({
    where: { key: "music-production" },
    create: {
      key: "music-production",
      name: "Music Production",
      description: "Test category for BG4 repository tests.",
      bundleOnly: false,
    },
    update: {},
  });

  const buyerUser = await prisma.userAccount.upsert({
    where: { id: BUYER_USER_ID },
    create: { id: BUYER_USER_ID, email: BUYER_EMAIL },
    update: { email: BUYER_EMAIL },
  });

  const buyerWorkspace = await prisma.workspace.upsert({
    where: { slug: BUYER_WORKSPACE_SLUG },
    create: {
      id: BUYER_WORKSPACE_ID,
      slug: BUYER_WORKSPACE_SLUG,
      name: "BG4 Test Buyer",
      type: "Personal",
      status: "Active",
      ownerUserId: buyerUser.id,
    },
    update: { status: "Active", ownerUserId: buyerUser.id },
  });
  await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: {
        userId: buyerUser.id,
        workspaceId: buyerWorkspace.id,
      },
    },
    create: {
      userId: buyerUser.id,
      workspaceId: buyerWorkspace.id,
      role: "Owner",
    },
    update: { role: "Owner" },
  });
  await prisma.workspaceCapability.deleteMany({
    where: { workspaceId: buyerWorkspace.id },
  });
  await prisma.workspaceCapability.create({
    data: { workspaceId: buyerWorkspace.id, capability: "Buyer" },
  });

  const sellerUser = await prisma.userAccount.upsert({
    where: { id: SELLER_USER_ID },
    create: { id: SELLER_USER_ID, email: SELLER_EMAIL },
    update: { email: SELLER_EMAIL },
  });

  const sellerWorkspace = await prisma.workspace.upsert({
    where: { slug: SELLER_WORKSPACE_SLUG },
    create: {
      id: SELLER_WORKSPACE_ID,
      slug: SELLER_WORKSPACE_SLUG,
      name: "BG4 Test Seller",
      type: "Personal",
      status: "Active",
      ownerUserId: sellerUser.id,
    },
    update: { status: "Active", ownerUserId: sellerUser.id },
  });
  await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: {
        userId: sellerUser.id,
        workspaceId: sellerWorkspace.id,
      },
    },
    create: {
      userId: sellerUser.id,
      workspaceId: sellerWorkspace.id,
      role: "Owner",
    },
    update: { role: "Owner" },
  });
  await prisma.workspaceCapability.deleteMany({
    where: { workspaceId: sellerWorkspace.id },
  });
  await prisma.workspaceCapability.create({
    data: { workspaceId: sellerWorkspace.id, capability: "Seller" },
  });

  const sellerProfile = await prisma.sellerProfile.upsert({
    where: { workspaceId: sellerWorkspace.id },
    create: {
      id: SELLER_PROFILE_ID,
      workspaceId: sellerWorkspace.id,
      professionalName: "BG4 Test Seller",
      bio: "Test seller for BG4 repository tests.",
      status: "Published",
      basedInCity: "Brooklyn",
      basedInRegion: "NY",
      basedInCountryCode: "US",
      avatarUrl: null,
    },
    update: { status: "Published" },
  });

  const offering = await prisma.serviceOffering.upsert({
    where: { slug: OFFERING_SLUG },
    create: {
      id: OFFERING_ID,
      slug: OFFERING_SLUG,
      sellerProfileId: sellerProfile.id,
      title: "BG4 Test Offering",
      description: "Test offering for BG4 repository tests.",
      status: "Active",
      serviceMode: "Remote",
      primaryCategoryId: category.id,
      genreTags: [],
    },
    update: { status: "Active", sellerProfileId: sellerProfile.id, primaryCategoryId: category.id },
  });

  const brief = await prisma.projectBrief.upsert({
    where: { id: BRIEF_ID },
    create: {
      id: BRIEF_ID,
      buyerWorkspaceId: buyerWorkspace.id,
      createdByUserId: buyerUser.id,
      originalText: "Test brief for BG4 repository tests.",
      requiredCriteriaJson: { primaryCategoryKeys: ["music-production"] },
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
    },
    update: {},
  });

  return {
    buyerUser: { id: buyerUser.id, email: buyerUser.email ?? BUYER_EMAIL },
    buyerWorkspace: {
      id: buyerWorkspace.id,
      slug: buyerWorkspace.slug,
      name: buyerWorkspace.name,
    },
    sellerUser: { id: sellerUser.id, email: sellerUser.email ?? SELLER_EMAIL },
    sellerWorkspace: {
      id: sellerWorkspace.id,
      slug: sellerWorkspace.slug,
      name: sellerWorkspace.name,
    },
    sellerProfile: { id: sellerProfile.id },
    offering: { id: offering.id, slug: offering.slug },
    brief: { id: brief.id },
  };
}
