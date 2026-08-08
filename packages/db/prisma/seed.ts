// Deterministic Milestone 1 seed.
//
// Establishes the approved controlled records (10 ServiceCategories, music
// Specialties, 6 PricingUnits) and 7 stable positive Caribbean seller
// fixtures. The seed is idempotent: the presence of a SeedMarker row makes
// the run a no-op so re-runs do not duplicate or randomize data.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/client.js";
import type {
  PricingKind,
  ServiceMode,
  ServiceOfferingStatus,
  SellerProfileStatus,
  WorkspaceType,
} from "../src/generated/enums.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run the seed");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

type ServiceCategorySeed = {
  key: string;
  name: string;
  description: string;
  bundleOnly: boolean;
};

const SERVICE_CATEGORIES: readonly ServiceCategorySeed[] = [
  {
    key: "music-production",
    name: "Music Production",
    description: "Original beat-making and track production.",
    bundleOnly: false,
  },
  {
    key: "songwriting",
    name: "Songwriting",
    description: "Original lyric and topline writing.",
    bundleOnly: false,
  },
  {
    key: "custom-composition",
    name: "Custom Composition",
    description: "Bespoke composition for briefs and placements.",
    bundleOnly: false,
  },
  {
    key: "session-vocals",
    name: "Session Vocals",
    description: "Studio vocal performance for hire.",
    bundleOnly: false,
  },
  {
    key: "session-instrument-performance",
    name: "Session Instrument Performance",
    description: "Studio instrumental performance for hire.",
    bundleOnly: false,
  },
  {
    key: "featured-artist-performance",
    name: "Featured Artist Performance",
    description: "Featured artist credit on a track.",
    bundleOnly: false,
  },
  {
    key: "mixing",
    name: "Mixing",
    description: "Multitrack mixdown and balance.",
    bundleOnly: false,
  },
  {
    key: "mastering",
    name: "Mastering",
    description: "Final loudness and tone preparation.",
    bundleOnly: false,
  },
  {
    key: "recording-engineering",
    name: "Recording Engineering",
    description: "Studio tracking and engineering.",
    bundleOnly: false,
  },
  {
    key: "live-performance",
    name: "Live Performance",
    description: "In-person and hybrid live performance.",
    bundleOnly: false,
  },
] as const;

const SPECIALTY_KEYS = ["Artist", "Producer", "Musician", "Songwriter", "SoundEngineer"] as const;

const PRICING_UNITS = [
  { key: "hour", name: "Hour" },
  { key: "track", name: "Track" },
  { key: "project", name: "Project" },
  { key: "session", name: "Session" },
  { key: "event", name: "Event" },
  { key: "day", name: "Day" },
] as const;

type SellerSeed = {
  workspaceSlug: string;
  workspaceName: string;
  workspaceType: WorkspaceType;
  ownerEmail: string;
  professionalName: string;
  bio: string;
  status: SellerProfileStatus;
  basedInCity: string | null;
  basedInRegion: string | null;
  basedInCountryCode: string;
  avatarUrl: string | null;
  caribbeanAffiliationCodes: string[];
  specialtyKeys: readonly string[];
  offerings: readonly OfferingSeed[];
};

type OfferingSeed = {
  slug: string;
  title: string;
  description: string;
  status: ServiceOfferingStatus;
  serviceMode: ServiceMode;
  primaryCategoryKey: string;
  genreTags: readonly string[];
  pricing?: {
    kind: PricingKind;
    amountMinor?: number;
    currency?: string;
    unitKey?: string;
  };
  serviceAreas: readonly { city?: string; region?: string; countryCode: string }[];
};

const SELLERS: readonly SellerSeed[] = [
  {
    workspaceSlug: "creole-beats-brooklyn",
    workspaceName: "Creole Beats Brooklyn",
    workspaceType: "Personal",
    ownerEmail: "marc.andre@creolebeats.example",
    professionalName: "Marc-André Pierre",
    bio: "Brooklyn-based Haitian producer crafting dancehall, soca, and hip-hop instrumentals for diaspora artists worldwide.",
    status: "Published",
    basedInCity: "Brooklyn",
    basedInRegion: "NY",
    basedInCountryCode: "US",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["HT"],
    specialtyKeys: ["Producer", "SoundEngineer"],
    offerings: [
      {
        slug: "creole-beats-dancehall-single-remote",
        title: "Haitian dancehall single production — remote",
        description:
          "Caribbean-flavored dancehall single production for diaspora artists. Includes arrangement, recording direction, and one round of revisions.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "music-production",
        genreTags: ["Dancehall", "Soca", "Hip-Hop"],
        pricing: { kind: "StartingAt", amountMinor: 60000, currency: "USD", unitKey: "track" },
        serviceAreas: [{ countryCode: "US" }, { countryCode: "HT" }],
      },
    ],
  },
  {
    workspaceSlug: "kingson-to-songs",
    workspaceName: "Kingson TO Songs",
    workspaceType: "Personal",
    ownerEmail: "keisha@kingsontosongs.example",
    professionalName: "Keisha Williams",
    bio: "Toronto-based Jamaican songwriter specializing in R&B and afrobeats toplines for global artists.",
    status: "Published",
    basedInCity: "Toronto",
    basedInRegion: "ON",
    basedInCountryCode: "CA",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["JM"],
    specialtyKeys: ["Songwriter", "Artist"],
    offerings: [
      {
        slug: "kingson-rnb-topline",
        title: "Afrobeats and R&B topline writing — remote",
        description: "Original topline writing, hook development, and lyric editing for a single.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "songwriting",
        genreTags: ["R&B", "Afrobeats", "Pop"],
        pricing: { kind: "Fixed", amountMinor: 120000, currency: "USD", unitKey: "track" },
        serviceAreas: [{ countryCode: "CA" }, { countryCode: "US" }],
      },
    ],
  },
  {
    workspaceSlug: "aisha-london-sessions",
    workspaceName: "Aisha London Sessions",
    workspaceType: "Personal",
    ownerEmail: "aisha@aishalondonsessions.example",
    professionalName: "Aisha Mohammed",
    bio: "Trinidadian session vocalist based in London, recording lead and harmony vocals for dancehall, soca, and afrobeats releases.",
    status: "Published",
    basedInCity: "London",
    basedInRegion: null,
    basedInCountryCode: "GB",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["TT"],
    specialtyKeys: ["Artist", "Musician"],
    offerings: [
      {
        slug: "aisha-session-vocals-remote",
        title: "Remote session vocals for Caribbean releases",
        description:
          "Lead and harmony session vocals delivered as dry stems, with one revision round.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "session-vocals",
        genreTags: ["Dancehall", "Soca", "Afrobeats"],
        pricing: { kind: "StartingAt", amountMinor: 35000, currency: "USD", unitKey: "session" },
        serviceAreas: [{ countryCode: "GB" }, { countryCode: "TT" }, { countryCode: "US" }],
      },
    ],
  },
  {
    workspaceSlug: "junior-roberts-mix",
    workspaceName: "Junior Roberts Mix",
    workspaceType: "Personal",
    ownerEmail: "junior@jrrobmix.example",
    professionalName: "Junior Roberts",
    bio: "Barbadian mix engineer in Brooklyn, mixing dancehall, hip-hop, and R&B records with a focus on loud, clean masters.",
    status: "Published",
    basedInCity: "Brooklyn",
    basedInRegion: "NY",
    basedInCountryCode: "US",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["BB"],
    specialtyKeys: ["SoundEngineer", "Producer"],
    offerings: [
      {
        slug: "jrrob-dancehall-mix",
        title: "Dancehall and hip-hop mixing — remote",
        description:
          "Mixdown for a single, including basic corrective editing and stem organization.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "mixing",
        genreTags: ["Dancehall", "Hip-Hop", "R&B"],
        pricing: { kind: "StartingAt", amountMinor: 45000, currency: "USD", unitKey: "track" },
        serviceAreas: [{ countryCode: "US" }, { countryCode: "BB" }],
      },
    ],
  },
  {
    workspaceSlug: "selene-dominicana-live",
    workspaceName: "Selene Dominicana Live",
    workspaceType: "Personal",
    ownerEmail: "selene@selenedo.example",
    professionalName: "Selene García",
    bio: "Dominican bachata and merengue artist available for in-person festival and club performances across the Caribbean and Latin America.",
    status: "Published",
    basedInCity: "Santo Domingo",
    basedInRegion: null,
    basedInCountryCode: "DO",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["DO"],
    specialtyKeys: ["Artist", "Musician"],
    offerings: [
      {
        slug: "selene-bachata-live",
        title: "Bachata and merengue live performance",
        description:
          "In-person 60- to 90-minute set with a four-piece band, suitable for festivals and club dates.",
        status: "Active",
        serviceMode: "InPerson",
        primaryCategoryKey: "live-performance",
        genreTags: ["Bachata", "Merengue"],
        pricing: { kind: "ContactForQuote" },
        serviceAreas: [{ countryCode: "DO" }, { countryCode: "PR" }],
      },
    ],
  },
  {
    workspaceSlug: "marina-joseph-compositions",
    workspaceName: "Marina Joseph Compositions",
    workspaceType: "Personal",
    ownerEmail: "marina@marinajoseph.example",
    professionalName: "Marina Joseph",
    bio: "Saint Lucian composer producing original scores for short films, branded content, and sync placements.",
    status: "Published",
    basedInCity: "Castries",
    basedInRegion: null,
    basedInCountryCode: "LC",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["LC"],
    specialtyKeys: ["Songwriter", "Producer"],
    offerings: [
      {
        slug: "marina-sync-composition",
        title: "Custom film and sync composition — remote",
        description: "Original score tailored to picture, delivered as broadcast-ready stems.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "custom-composition",
        genreTags: ["Score", "Ambient", "Cinematic"],
        pricing: { kind: "StartingAt", amountMinor: 200000, currency: "USD", unitKey: "project" },
        serviceAreas: [{ countryCode: "LC" }, { countryCode: "GB" }],
      },
    ],
  },
  {
    workspaceSlug: "devon-king-bahamas-live",
    workspaceName: "Devon King Bahamas Live",
    workspaceType: "Personal",
    ownerEmail: "devon@devonking.example",
    professionalName: "Devon King",
    bio: "Bahamian live performer and music director hosting resort and festival sets across the Caribbean and the US East Coast.",
    status: "Published",
    basedInCity: "Nassau",
    basedInRegion: null,
    basedInCountryCode: "BS",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["BS"],
    specialtyKeys: ["Artist", "Musician", "Producer"],
    offerings: [
      {
        slug: "devon-live-set",
        title: "Caribbean live set and band direction",
        description:
          "Hybrid live set with band direction; available in-person in the Caribbean and remotely elsewhere.",
        status: "Active",
        serviceMode: "Hybrid",
        primaryCategoryKey: "live-performance",
        genreTags: ["Junkanoo", "Dancehall", "Calypso"],
        pricing: { kind: "ContactForQuote" },
        serviceAreas: [{ countryCode: "BS" }, { countryCode: "US" }],
      },
    ],
  },
];

async function main(): Promise<void> {
  console.log("🌱 Seeding SoundHub Milestone 1 fixture…");

  const existing = await prisma.seedMarker.findUnique({ where: { id: 1 } });
  if (existing) {
    console.log("✅ Seed marker present; the fixture is already applied. Skipping.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Controlled records
    for (const category of SERVICE_CATEGORIES) {
      await tx.serviceCategory.upsert({
        where: { key: category.key },
        create: category,
        update: {
          name: category.name,
          description: category.description,
          bundleOnly: category.bundleOnly,
        },
      });
    }
    for (const key of SPECIALTY_KEYS) {
      await tx.specialty.upsert({
        where: { key },
        create: { key, name: key },
        update: { name: key },
      });
    }
    for (const unit of PRICING_UNITS) {
      await tx.pricingUnit.upsert({
        where: { key: unit.key },
        create: unit,
        update: { name: unit.name },
      });
    }

    // Sellers
    for (const seller of SELLERS) {
      const owner = await tx.userAccount.upsert({
        where: { email: seller.ownerEmail },
        create: { email: seller.ownerEmail },
        update: {},
      });

      const workspace = await tx.workspace.upsert({
        where: { slug: seller.workspaceSlug },
        create: {
          slug: seller.workspaceSlug,
          name: seller.workspaceName,
          type: seller.workspaceType,
          status: "Active",
          ownerUserId: owner.id,
        },
        update: { name: seller.workspaceName, type: seller.workspaceType, status: "Active" },
      });

      // Owner is always a member with role Owner.
      await tx.workspaceMembership.upsert({
        where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
        create: {
          userId: owner.id,
          workspaceId: workspace.id,
          role: "Owner",
        },
        update: { role: "Owner" },
      });

      await tx.workspaceCapability.upsert({
        where: { workspaceId_capability: { workspaceId: workspace.id, capability: "Seller" } },
        create: { workspaceId: workspace.id, capability: "Seller" },
        update: {},
      });

      const profile = await tx.sellerProfile.upsert({
        where: { workspaceId: workspace.id },
        create: {
          workspaceId: workspace.id,
          professionalName: seller.professionalName,
          bio: seller.bio,
          status: seller.status,
          basedInCity: seller.basedInCity,
          basedInRegion: seller.basedInRegion,
          basedInCountryCode: seller.basedInCountryCode,
          avatarUrl: seller.avatarUrl,
        },
        update: {
          professionalName: seller.professionalName,
          bio: seller.bio,
          status: seller.status,
          basedInCity: seller.basedInCity,
          basedInRegion: seller.basedInRegion,
          basedInCountryCode: seller.basedInCountryCode,
          avatarUrl: seller.avatarUrl,
        },
      });

      // Replace Caribbean affiliations with the deterministic set.
      await tx.caribbeanAffiliation.deleteMany({ where: { sellerProfileId: profile.id } });
      if (seller.caribbeanAffiliationCodes.length > 0) {
        await tx.caribbeanAffiliation.createMany({
          data: seller.caribbeanAffiliationCodes.map((countryCode) => ({
            sellerProfileId: profile.id,
            countryCode,
          })),
          skipDuplicates: true,
        });
      }

      // Replace specialty join rows with the deterministic set.
      await tx.sellerProfileSpecialty.deleteMany({ where: { sellerProfileId: profile.id } });
      for (const specialtyKey of seller.specialtyKeys) {
        const specialty = await tx.specialty.findUnique({ where: { key: specialtyKey } });
        if (!specialty) {
          throw new Error(`Specialty ${specialtyKey} missing from seed`);
        }
        await tx.sellerProfileSpecialty.create({
          data: { sellerProfileId: profile.id, specialtyId: specialty.id },
        });
      }

      for (const offering of seller.offerings) {
        const category = await tx.serviceCategory.findUnique({
          where: { key: offering.primaryCategoryKey },
        });
        if (!category) {
          throw new Error(`ServiceCategory ${offering.primaryCategoryKey} missing from seed`);
        }

        const offeringData: Prisma.ServiceOfferingUncheckedCreateInput = {
          slug: offering.slug,
          sellerProfileId: profile.id,
          title: offering.title,
          description: offering.description,
          status: offering.status,
          serviceMode: offering.serviceMode,
          primaryCategoryId: category.id,
          genreTags: [...offering.genreTags],
        };

        await tx.serviceOffering.upsert({
          where: { slug: offering.slug },
          create: offeringData,
          update: {
            title: offering.title,
            description: offering.description,
            status: offering.status,
            serviceMode: offering.serviceMode,
            primaryCategoryId: category.id,
            genreTags: [...offering.genreTags],
          },
        });

        const persisted = await tx.serviceOffering.findUnique({ where: { slug: offering.slug } });
        if (!persisted) {
          throw new Error(`Failed to persist offering ${offering.slug}`);
        }

        // Service areas
        await tx.serviceOfferingServiceArea.deleteMany({ where: { offeringId: persisted.id } });
        for (const area of offering.serviceAreas) {
          await tx.serviceOfferingServiceArea.create({
            data: {
              offeringId: persisted.id,
              city: area.city ?? null,
              region: area.region ?? null,
              countryCode: area.countryCode,
            },
          });
        }

        // Pricing
        await tx.serviceOfferingPricing.deleteMany({ where: { offeringId: persisted.id } });
        if (offering.pricing) {
          let unitId: string | null = null;
          if (offering.pricing.unitKey) {
            const unit = await tx.pricingUnit.findUnique({
              where: { key: offering.pricing.unitKey },
            });
            if (!unit) {
              throw new Error(`PricingUnit ${offering.pricing.unitKey} missing from seed`);
            }
            unitId = unit.id;
          }
          await tx.serviceOfferingPricing.create({
            data: {
              offeringId: persisted.id,
              kind: offering.pricing.kind,
              amountMinor: offering.pricing.amountMinor ?? null,
              currency: offering.pricing.currency ?? null,
              unitId,
            },
          });
        }

        // Reset bundle-only IncludedServices (M1.1 ships with no bundles so
        // search has no bundle-only artifacts to deal with; future tickets
        // will add them).
        await tx.includedService.deleteMany({ where: { offeringId: persisted.id } });
      }
    }

    // Idempotence marker
    await tx.seedMarker.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: { seededAt: new Date() },
    });
  });

  // Verify the deterministic shape: 7 sellers and 7 active offerings.
  const [sellerCount, offeringCount, categoryCount, specialtyCount, pricingUnitCount] =
    await Promise.all([
      prisma.sellerProfile.count(),
      prisma.serviceOffering.count({ where: { status: "Active" } }),
      prisma.serviceCategory.count(),
      prisma.specialty.count(),
      prisma.pricingUnit.count(),
    ]);
  console.log(
    `✅ Seed complete: ${sellerCount} seller profiles, ${offeringCount} active offerings, ${categoryCount} categories, ${specialtyCount} specialties, ${pricingUnitCount} pricing units.`,
  );
  if (sellerCount !== SELLERS.length) {
    throw new Error(`Expected ${SELLERS.length} seller profiles, got ${sellerCount}`);
  }
  if (categoryCount !== SERVICE_CATEGORIES.length) {
    throw new Error(
      `Expected ${SERVICE_CATEGORIES.length} service categories, got ${categoryCount}`,
    );
  }
  if (specialtyCount !== SPECIALTY_KEYS.length) {
    throw new Error(`Expected ${SPECIALTY_KEYS.length} specialties, got ${specialtyCount}`);
  }
  if (pricingUnitCount !== PRICING_UNITS.length) {
    throw new Error(`Expected ${PRICING_UNITS.length} pricing units, got ${pricingUnitCount}`);
  }
}

main()
  .catch((err) => {
    console.error("❌ Error seeding database:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
