// Deterministic Milestone 1 seed.
//
// The seed runs on every invocation and converges to the approved fixture
// state via deterministic upserts on stable unique keys (UserAccount.email,
// Workspace.slug, ServiceCategory.key, Specialty.key, PricingUnit.key,
// ServiceOffering.slug). It does not depend on a marker row, an
// in-memory cache, or a previous run. After the seed completes, an
// invariant check verifies that the canonical row counts and referenced
// stable keys match the approved values.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";
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
  { key: "music-production", name: "Music Production", description: "Original beat-making and track production.", bundleOnly: false },
  { key: "songwriting", name: "Songwriting", description: "Original lyric and topline writing.", bundleOnly: false },
  { key: "custom-composition", name: "Custom Composition", description: "Bespoke composition for briefs and placements.", bundleOnly: false },
  { key: "session-vocals", name: "Session Vocals", description: "Studio vocal performance for hire.", bundleOnly: false },
  { key: "session-instrument-performance", name: "Session Instrument Performance", description: "Studio instrumental performance for hire.", bundleOnly: false },
  { key: "featured-artist-performance", name: "Featured Artist Performance", description: "Featured artist credit on a track.", bundleOnly: false },
  { key: "mixing", name: "Mixing", description: "Multitrack mixdown and balance.", bundleOnly: false },
  { key: "mastering", name: "Mastering", description: "Final loudness and tone preparation.", bundleOnly: false },
  { key: "recording-engineering", name: "Recording Engineering", description: "Studio tracking and engineering.", bundleOnly: false },
  { key: "live-performance", name: "Live Performance", description: "In-person and hybrid live performance.", bundleOnly: false },
] as const;

const SPECIALTY_KEYS = [
  "Artist",
  "Producer",
  "Musician",
  "Songwriter",
  "SoundEngineer",
] as const;

const PRICING_UNITS = [
  { key: "hour", name: "Hour" },
  { key: "track", name: "Track" },
  { key: "project", name: "Project" },
  { key: "session", name: "Session" },
  { key: "event", name: "Event" },
  { key: "day", name: "Day" },
] as const;

type SellerSeed = {
  readonly ownerEmail: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly workspaceType: WorkspaceType;
  readonly professionalName: string;
  readonly bio: string;
  readonly status: SellerProfileStatus;
  readonly basedInCity: string | null;
  readonly basedInRegion: string | null;
  readonly basedInCountryCode: string;
  readonly avatarUrl: string | null;
  readonly caribbeanAffiliationCodes: readonly string[];
  readonly specialtyKeys: readonly (typeof SPECIALTY_KEYS)[number][];
  readonly offerings: readonly OfferingSeed[];
};

type OfferingSeed = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly status: ServiceOfferingStatus;
  readonly serviceMode: ServiceMode;
  readonly primaryCategoryKey: string;
  readonly genreTags: readonly string[];
  readonly pricing?: {
    readonly kind: PricingKind;
    readonly amountMinor?: number;
    readonly currency?: string;
    readonly unitKey?: string;
  };
  readonly serviceAreas: readonly { city?: string; region?: string; countryCode: string }[];
};

const SELLERS: readonly SellerSeed[] = [
  {
    ownerEmail: "marc.andre@creolebeats.example",
    workspaceSlug: "creole-beats-brooklyn",
    workspaceName: "Creole Beats Brooklyn",
    workspaceType: "Personal",
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
    ownerEmail: "keisha@kingsontosongs.example",
    workspaceSlug: "kingson-to-songs",
    workspaceName: "Kingson TO Songs",
    workspaceType: "Personal",
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
    ownerEmail: "aisha@aishalondonsessions.example",
    workspaceSlug: "aisha-london-sessions",
    workspaceName: "Aisha London Sessions",
    workspaceType: "Personal",
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
        description: "Lead and harmony session vocals delivered as dry stems, with one revision round.",
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
    ownerEmail: "junior@jrrobmix.example",
    workspaceSlug: "junior-roberts-mix",
    workspaceName: "Junior Roberts Mix",
    workspaceType: "Personal",
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
        description: "Mixdown for a single, including basic corrective editing and stem organization.",
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
    ownerEmail: "selene@selenedo.example",
    workspaceSlug: "selene-dominicana-live",
    workspaceName: "Selene Dominicana Live",
    workspaceType: "Personal",
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
        description: "In-person 60- to 90-minute set with a four-piece band, suitable for festivals and club dates.",
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
    ownerEmail: "marina@marinajoseph.example",
    workspaceSlug: "marina-joseph-compositions",
    workspaceName: "Marina Joseph Compositions",
    workspaceType: "Personal",
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
    ownerEmail: "devon@devonking.example",
    workspaceSlug: "devon-king-bahamas-live",
    workspaceName: "Devon King Bahamas Live",
    workspaceType: "Personal",
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
        description: "Hybrid live set with band direction; available in-person in the Caribbean and remotely elsewhere.",
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

// Deterministic ID helpers so repository tests can rely on stable IDs
// across runs (the unique keys already enforce uniqueness; explicit IDs
// make the seed run on any Prisma client without re-issuing cuids).
function toUserId(email: string): string {
  const local = email.split("@")[0]?.replace(/[^a-z0-9]+/gi, "-") ?? "user";
  return `user-${local}`;
}

function toWorkspaceId(slug: string): string {
  return `ws-${slug}`;
}

function toSellerProfileId(slug: string): string {
  return `sp-${slug}`;
}

function toOfferingId(slug: string): string {
  return `of-${slug}`;
}

async function applySeed(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Controlled records: deterministic upserts by stable key.
    for (const category of SERVICE_CATEGORIES) {
      await tx.serviceCategory.upsert({
        where: { key: category.key },
        create: category,
        update: { name: category.name, description: category.description, bundleOnly: category.bundleOnly },
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

    // Sellers: deterministic upserts by stable keys (email, slug).
    for (const seller of SELLERS) {
      const owner = await tx.userAccount.upsert({
        where: { email: seller.ownerEmail },
        create: { id: toUserId(seller.ownerEmail), email: seller.ownerEmail },
        update: {},
      });

      const workspace = await tx.workspace.upsert({
        where: { slug: seller.workspaceSlug },
        create: {
          id: toWorkspaceId(seller.workspaceSlug),
          slug: seller.workspaceSlug,
          name: seller.workspaceName,
          type: seller.workspaceType,
          status: "Active",
          ownerUserId: owner.id,
        },
        update: { name: seller.workspaceName, type: seller.workspaceType, status: "Active" },
      });

      await tx.workspaceMembership.upsert({
        where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
        create: { userId: owner.id, workspaceId: workspace.id, role: "Owner" },
        update: { role: "Owner" },
      });

      await tx.workspaceCapability.upsert({
        where: {
          workspaceId_capability: { workspaceId: workspace.id, capability: "Seller" },
        },
        create: { workspaceId: workspace.id, capability: "Seller" },
        update: {},
      });

      const profile = await tx.sellerProfile.upsert({
        where: { workspaceId: workspace.id },
        create: {
          id: toSellerProfileId(seller.workspaceSlug),
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

      // Caribbean affiliations: replace with the deterministic set keyed
      // on the (sellerProfileId, countryCode) unique constraint.
      await tx.caribbeanAffiliation.deleteMany({ where: { sellerProfileId: profile.id } });
      for (const countryCode of seller.caribbeanAffiliationCodes) {
        await tx.caribbeanAffiliation.upsert({
          where: { sellerProfileId_countryCode: { sellerProfileId: profile.id, countryCode } },
          create: { sellerProfileId: profile.id, countryCode },
          update: {},
        });
      }

      // Specialties: replace with the deterministic set keyed on the
      // (sellerProfileId, specialtyId) composite key.
      await tx.sellerProfileSpecialty.deleteMany({ where: { sellerProfileId: profile.id } });
      for (const specialtyKey of seller.specialtyKeys) {
        const specialty = await tx.specialty.findUnique({ where: { key: specialtyKey } });
        if (!specialty) {
          throw new Error(`Specialty ${specialtyKey} missing from controlled records`);
        }
        await tx.sellerProfileSpecialty.upsert({
          where: {
            sellerProfileId_specialtyId: {
              sellerProfileId: profile.id,
              specialtyId: specialty.id,
            },
          },
          create: { sellerProfileId: profile.id, specialtyId: specialty.id },
          update: {},
        });
      }

      for (const offering of seller.offerings) {
        const category = await tx.serviceCategory.findUnique({
          where: { key: offering.primaryCategoryKey },
        });
        if (!category) {
          throw new Error(
            `ServiceCategory ${offering.primaryCategoryKey} missing from controlled records`,
          );
        }

        await tx.serviceOffering.upsert({
          where: { slug: offering.slug },
          create: {
            id: toOfferingId(offering.slug),
            slug: offering.slug,
            sellerProfileId: profile.id,
            title: offering.title,
            description: offering.description,
            status: offering.status,
            serviceMode: offering.serviceMode,
            primaryCategoryId: category.id,
            genreTags: [...offering.genreTags],
          },
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

        // Service areas: replace with the deterministic set.
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

        // Pricing: replace with the deterministic single-row record.
        await tx.serviceOfferingPricing.deleteMany({ where: { offeringId: persisted.id } });
        if (offering.pricing) {
          let unitId: string | null = null;
          if (offering.pricing.unitKey) {
            const unit = await tx.pricingUnit.findUnique({ where: { key: offering.pricing.unitKey } });
            if (!unit) {
              throw new Error(`PricingUnit ${offering.pricing.unitKey} missing from controlled records`);
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

        // Reset bundle-only IncludedServices (M1.1 ships with no bundles;
        // future tickets will add them).
        await tx.includedService.deleteMany({ where: { offeringId: persisted.id } });
      }
    }
  });
}

async function assertInvariants(): Promise<{
  sellers: number;
  offerings: number;
  categories: number;
  specialties: number;
  pricingUnits: number;
  categoryKeys: string[];
  affiliationCodes: string[];
}> {
  const [sellerCount, offeringCount, categoryCount, specialtyCount, pricingUnitCount, categories, affiliations] =
    await Promise.all([
      prisma.sellerProfile.count(),
      prisma.serviceOffering.count({ where: { status: "Active" } }),
      prisma.serviceCategory.count(),
      prisma.specialty.count(),
      prisma.pricingUnit.count(),
      prisma.serviceCategory.findMany({ orderBy: { key: "asc" } }),
      prisma.caribbeanAffiliation.findMany(),
    ]);
  return {
    sellers: sellerCount,
    offerings: offeringCount,
    categories: categoryCount,
    specialties: specialtyCount,
    pricingUnits: pricingUnitCount,
    categoryKeys: categories.map((c) => c.key),
    affiliationCodes: [...new Set(affiliations.map((a) => a.countryCode))].sort(),
  };
}

function assertInvariantsMatchExpected(snapshot: Awaited<ReturnType<typeof assertInvariants>>): void {
  const expectedCategoryKeys = SERVICE_CATEGORIES.map((c) => c.key).sort();
  if (
    snapshot.sellers !== SELLERS.length ||
    snapshot.offerings !== SELLERS.length ||
    snapshot.categories !== SERVICE_CATEGORIES.length ||
    snapshot.specialties !== SPECIALTY_KEYS.length ||
    snapshot.pricingUnits !== PRICING_UNITS.length
  ) {
    throw new Error(
      `Seed invariants failed: sellers=${snapshot.sellers}/${SELLERS.length}, ` +
        `offerings=${snapshot.offerings}/${SELLERS.length}, ` +
        `categories=${snapshot.categories}/${SERVICE_CATEGORIES.length}, ` +
        `specialties=${snapshot.specialties}/${SPECIALTY_KEYS.length}, ` +
        `pricingUnits=${snapshot.pricingUnits}/${PRICING_UNITS.length}.`,
    );
  }
  const actualCategoryKeys = [...snapshot.categoryKeys].sort();
  if (actualCategoryKeys.length !== expectedCategoryKeys.length) {
    throw new Error(
      `Seed category key count mismatch: expected ${expectedCategoryKeys.length}, got ${actualCategoryKeys.length}.`,
    );
  }
  for (let i = 0; i < expectedCategoryKeys.length; i += 1) {
    if (actualCategoryKeys[i] !== expectedCategoryKeys[i]) {
      throw new Error(
        `Seed category key mismatch at index ${i}: expected ${expectedCategoryKeys[i]}, got ${actualCategoryKeys[i]}.`,
      );
    }
  }
}

async function main(): Promise<void> {
  console.log("🌱 Applying deterministic M1.1 seed (upserts on stable unique keys)…");
  await applySeed();
  const firstSnapshot = await assertInvariants();
  assertInvariantsMatchExpected(firstSnapshot);
  console.log(
    `✅ First pass converged: ${firstSnapshot.sellers} sellers, ${firstSnapshot.offerings} active offerings, ` +
      `${firstSnapshot.categories} categories, ${firstSnapshot.specialties} specialties, ` +
      `${firstSnapshot.pricingUnits} pricing units.`,
  );

  // Re-apply and assert identical state to prove the upsert path is idempotent.
  await applySeed();
  const secondSnapshot = await assertInvariants();
  assertInvariantsMatchExpected(secondSnapshot);
  if (
    firstSnapshot.sellers !== secondSnapshot.sellers ||
    firstSnapshot.offerings !== secondSnapshot.offerings ||
    firstSnapshot.categories !== secondSnapshot.categories ||
    firstSnapshot.specialties !== secondSnapshot.specialties ||
    firstSnapshot.pricingUnits !== secondSnapshot.pricingUnits
  ) {
    throw new Error(
      `Idempotence check failed: first=${JSON.stringify(firstSnapshot)} second=${JSON.stringify(secondSnapshot)}`,
    );
  }
  console.log("✅ Second pass produced an identical invariant snapshot.");
}

main()
  .catch((err) => {
    console.error("❌ Error seeding database:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
