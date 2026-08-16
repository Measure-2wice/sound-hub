// Deterministic Milestone 1 seed.
//
// The seed runs on every invocation and converges the canonical M1.1
// fixture state to its approved values via deterministic upserts on
// stable unique keys. The canonical state is the closed set of
// 10 ServiceCategories, 5 Specialties, 6 PricingUnits, and 8 sellers
// (with their full UserAccount / Workspace / WorkspaceMembership /
// WorkspaceCapability / SellerProfile / CaribbeanAffiliation /
// SellerProfileSpecialty / ServiceOffering / ServiceOfferingServiceArea
// / ServiceOfferingPricing graph) defined by SELLERS and the
// SERVICE_CATEGORIES / SPECIALTY_KEYS / PRICING_UNITS constants.
//
// Canonical relationships are restored on every run (Workspace.ownerUserId,
// ServiceOffering.sellerProfileId, ServiceOffering.primaryCategoryId,
// WorkspaceMembership, WorkspaceCapability, SellerProfileSpecialty,
// CaribbeanAffiliation, ServiceOfferingServiceArea, ServiceOfferingPricing).
// Canonical field values are restored on every run (Workspace.status,
// SellerProfile.status, ServiceOffering.status, ServiceOffering.title, …).
//
// M1.3 adds NEGATIVE_FIXTURES: deterministic excluded-state fixtures
// (Draft profile, Suspended profile, Suspended workspace, Buyer-only
// workspace, Draft/Paused/Archived-only offerings, and sellers with
// mixed lifecycle offerings) seeded outside the canonical SELLERS
// array. The canonical snapshot assertion only checks the closed
// canonical SELLERS set; the repository integration tests reference
// the negative fixtures by stable ID.
//
// The seed does NOT delete rows that are outside the canonical state
// (extra sellers, extra categories, etc.). Such rows are simply
// untouched; the canonical-state snapshot proves that the closed
// canonical set is correct.
//
// Re-running the seed produces an identical canonical-state snapshot.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";
import type { Prisma } from "../src/generated/client.js";
import type {
  MarketplaceCapability,
  PricingKind,
  ServiceMode,
  ServiceOfferingStatus,
  SellerProfileStatus,
  WorkspaceStatus,
  WorkspaceType,
} from "../src/generated/enums.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run the seed");
}

// The public seller contract (packages/types/src/index.ts) requires
// `avatarUrl` to be a parseable absolute URL (`z.string().url()`). The
// canonical non-null avatar fixture is therefore seeded as an absolute
// URL composed from a configurable fixture origin plus the path under
// `apps/web/public/fixtures/...` that the Next.js static handler serves.
//
// The default origin matches the local Next.js dev server (`pnpm dev`)
// and the FRONTEND_URL that the M1 Playwright harness passes to both the
// API and the browser, so the seeded URL resolves end to end in the
// smoke-test environment. Operators and CI override it by exporting
// PUBLIC_FIXTURE_ORIGIN.
function resolveFixtureOrigin(): string {
  const raw = process.env.PUBLIC_FIXTURE_ORIGIN ?? "http://localhost:3000";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new Error(
      `PUBLIC_FIXTURE_ORIGIN is not a valid absolute URL: ${raw} (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`PUBLIC_FIXTURE_ORIGIN must use http(s): got protocol ${parsed.protocol}`);
  }
  return parsed.origin;
}

const FIXTURE_ORIGIN = resolveFixtureOrigin();

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

// Exported for the snapshot-probe regression test (see
// captureCanonicalSnapshot above). Disconnects the shared
// PrismaClient so the probe's child process can exit cleanly
// without leaving the connection pool open.
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

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

// Shared seller-graph shape used by both the canonical SELLERS array
// and the M1.3 negative eligibility fixtures. The canonical sellers
// always supply `workspaceStatus: "Active"` and
// `workspaceCapabilities: ["Seller"]`; the negative fixtures supply
// the excluded state values. The same persistence flow applies to
// both, so `applySellerGraph` (below) is the single source of truth.
type SellerGraphSeed = {
  readonly ownerEmail: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly workspaceType: WorkspaceType;
  readonly workspaceStatus: WorkspaceStatus;
  readonly workspaceCapabilities: readonly MarketplaceCapability[];
  readonly professionalName: string;
  readonly bio: string;
  readonly profileStatus: SellerProfileStatus;
  readonly basedInCity: string | null;
  readonly basedInRegion: string | null;
  readonly basedInCountryCode: string;
  readonly avatarUrl: string | null;
  readonly caribbeanAffiliationCodes: readonly string[];
  readonly specialtyKeys: readonly (typeof SPECIALTY_KEYS)[number][];
  readonly offerings: readonly OfferingSeed[];
};

type SellerSeed = SellerGraphSeed;

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
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Marc-André Pierre",
    bio: "Brooklyn-based Haitian producer crafting dancehall, soca, and hip-hop instrumentals for diaspora artists worldwide.",
    profileStatus: "Published",
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
        serviceAreas: [
          { city: "Brooklyn", region: "NY", countryCode: "US" },
          { countryCode: "HT" },
        ],
      },
    ],
  },
  {
    ownerEmail: "keisha@kingsontosongs.example",
    workspaceSlug: "kingson-to-songs",
    workspaceName: "Kingson TO Songs",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Keisha Williams",
    bio: "Toronto-based Jamaican songwriter specializing in R&B and afrobeats toplines for global artists.",
    profileStatus: "Published",
    basedInCity: "Toronto",
    basedInRegion: "ON",
    basedInCountryCode: "CA",
    // Edge fixture: `avatarUrl` is an approved optional field of the public
    // seller contract, so the non-null case is a distinct public
    // professional-identity presentation. Every other seeded seller leaves it
    // null, which kept the rendered-avatar path unproven end to end. The URL
    // is stored as an absolute URL (contract: `z.string().url()`) composed
    // from a configurable fixture origin plus the path under
    // `apps/web/public/fixtures/...` that the Next.js static handler
    // serves. The default origin matches the local Next.js dev server and
    // the FRONTEND_URL that the M1 Playwright harness passes to both the
    // API and the browser, so the seeded URL resolves end to end in the
    // smoke-test environment.
    avatarUrl: `${FIXTURE_ORIGIN}/fixtures/sellers/keisha-williams/avatar.svg`,
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
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Aisha Mohammed",
    bio: "Trinidadian session vocalist based in London, recording lead and harmony vocals for dancehall, soca, and afrobeats releases.",
    profileStatus: "Published",
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
        serviceAreas: [
          { city: "London", region: null, countryCode: "GB" },
          { countryCode: "TT" },
          { countryCode: "US" },
        ],
      },
    ],
  },
  {
    ownerEmail: "junior@jrrobmix.example",
    workspaceSlug: "junior-roberts-mix",
    workspaceName: "Junior Roberts Mix",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Junior Roberts",
    bio: "Barbadian mix engineer in Brooklyn, mixing dancehall, hip-hop, and R&B records with a focus on loud, clean masters.",
    profileStatus: "Published",
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
    ownerEmail: "selene@selenedo.example",
    workspaceSlug: "selene-dominicana-live",
    workspaceName: "Selene Dominicana Live",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Selene García",
    bio: "Dominican bachata and merengue artist available for in-person festival and club performances across the Caribbean and Latin America.",
    profileStatus: "Published",
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
    ownerEmail: "marina@marinajoseph.example",
    workspaceSlug: "marina-joseph-compositions",
    workspaceName: "Marina Joseph Compositions",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Marina Joseph",
    bio: "Saint Lucian composer producing original scores for short films, branded content, and sync placements.",
    profileStatus: "Published",
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
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Devon King",
    bio: "Bahamian live performer and music director hosting resort and festival sets across the Caribbean and the US East Coast.",
    profileStatus: "Published",
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
  {
    // Edge fixture: an Active, fully eligible offering that advertises no
    // pricing at all. The public contract makes `pricing` optional, so the
    // absent case is a distinct buyer-facing presentation alongside
    // StartingAt, Fixed, and ContactForQuote. Seeding it keeps that path
    // exercised end to end instead of only in unit fixtures.
    ownerEmail: "anika@anikacharles.example",
    workspaceSlug: "anika-charles-mastering",
    workspaceName: "Anika Charles Mastering",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Anika Charles",
    bio: "Grenadian mastering engineer preparing streaming-ready masters for independent Caribbean labels.",
    profileStatus: "Published",
    basedInCity: "St. George's",
    basedInRegion: null,
    basedInCountryCode: "GD",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["GD"],
    specialtyKeys: ["SoundEngineer"],
    offerings: [
      {
        slug: "anika-streaming-master",
        title: "Streaming-ready mastering for Caribbean releases",
        description:
          "Loudness-matched masters delivered for streaming platforms; pricing is discussed per release.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "mastering",
        genreTags: ["Soca", "Calypso", "Reggae"],
        serviceAreas: [{ countryCode: "GD" }, { countryCode: "TT" }],
      },
    ],
  },
];

// Negative eligibility fixtures (M1.3).
//
// These fixtures intentionally cover every excluded state called out by
// issue #4 ("Exclude ineligible sellers and unavailable offerings"):
//
//   - SellerProfile.status = Draft and Suspended
//   - Workspace.status = Suspended
//   - Workspace without the Seller capability (Buyer-only)
//   - ServiceOffering.status = Draft, Paused, and Archived
//   - A seller with mixed Active + Paused offerings (only Active surfaces)
//   - A seller with mixed Active + Archived offerings (only Active surfaces)
//   - A seller with only Paused offerings (entire seller excluded)
//   - A seller with only Archived offerings (entire seller excluded)
//
// They are seeded by `applySeed` outside the canonical `SELLERS` array so
// the canonical snapshot assertion remains unchanged. The canonical-state
// snapshot proves the closed canonical SELLERS set is correct, and these
// fixtures add rows that prove the eligibility filters work; the
// repository integration tests assert the latter.
type NegativeFixture = SellerGraphSeed;

const NEGATIVE_FIXTURES: readonly NegativeFixture[] = [
  {
    // Draft SellerProfile: the seller has never published, so even though
    // the workspace is eligible and the offering is Active, the profile
    // must not surface in search results.
    ownerEmail: "draft.profile@ineligible.example",
    workspaceSlug: "negative-draft-profile",
    workspaceName: "Negative Draft Profile",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Draft Profile Seller",
    bio: "Seller profile that has never been published.",
    profileStatus: "Draft",
    basedInCity: "Kingston",
    basedInRegion: null,
    basedInCountryCode: "JM",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["JM"],
    specialtyKeys: ["Producer"],
    offerings: [
      {
        slug: "negative-draft-profile-active-offering",
        title: "Hidden active offering behind draft profile",
        description: "Active offering whose seller profile is still in Draft.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "music-production",
        genreTags: ["Dancehall"],
        serviceAreas: [{ countryCode: "JM" }],
      },
    ],
  },
  {
    // Suspended SellerProfile: the workspace is Active and Seller-capable,
    // but the profile is suspended. The seller must not surface.
    ownerEmail: "suspended.profile@ineligible.example",
    workspaceSlug: "negative-suspended-profile",
    workspaceName: "Negative Suspended Profile",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Suspended Profile Seller",
    bio: "Seller profile that has been suspended by moderation.",
    profileStatus: "Suspended",
    basedInCity: "Port of Spain",
    basedInRegion: null,
    basedInCountryCode: "TT",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["TT"],
    specialtyKeys: ["Artist"],
    offerings: [
      {
        slug: "negative-suspended-profile-active-offering",
        title: "Active offering behind suspended profile",
        description: "Active offering that must be hidden by profile status.",
        status: "Active",
        serviceMode: "Hybrid",
        primaryCategoryKey: "live-performance",
        genreTags: ["Soca"],
        serviceAreas: [{ countryCode: "TT" }],
      },
    ],
  },
  {
    // Suspended Workspace: the workspace has been suspended. Even though
    // the profile is Published and the offering is Active, the workspace
    // status excludes the seller.
    ownerEmail: "suspended.workspace@ineligible.example",
    workspaceSlug: "negative-suspended-workspace",
    workspaceName: "Negative Suspended Workspace",
    workspaceType: "Personal",
    workspaceStatus: "Suspended",
    workspaceCapabilities: ["Seller"],
    professionalName: "Suspended Workspace Seller",
    bio: "Seller whose workspace has been suspended.",
    profileStatus: "Published",
    basedInCity: "Bridgetown",
    basedInRegion: null,
    basedInCountryCode: "BB",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["BB"],
    specialtyKeys: ["Musician"],
    offerings: [
      {
        slug: "negative-suspended-workspace-active-offering",
        title: "Active offering under a suspended workspace",
        description: "Active offering that must be hidden by workspace status.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "mixing",
        genreTags: ["Soca"],
        serviceAreas: [{ countryCode: "BB" }],
      },
    ],
  },
  {
    // Buyer-only workspace: no Seller capability. The profile is
    // Published and the offering is Active, but the seller cannot sell.
    ownerEmail: "buyer.only@ineligible.example",
    workspaceSlug: "negative-buyer-only",
    workspaceName: "Negative Buyer-Only Workspace",
    workspaceType: "Organization",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Buyer"],
    professionalName: "Buyer-Only Seller Profile",
    bio: "Seller profile on a buyer-only workspace.",
    profileStatus: "Published",
    basedInCity: "Georgetown",
    basedInRegion: null,
    basedInCountryCode: "GY",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["GY"],
    specialtyKeys: ["Producer"],
    offerings: [
      {
        slug: "negative-buyer-only-active-offering",
        title: "Active offering on a buyer-only workspace",
        description: "Active offering that must be hidden by missing Seller capability.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "music-production",
        genreTags: ["Reggae"],
        serviceAreas: [{ countryCode: "GY" }],
      },
    ],
  },
  {
    // Draft-only offerings: the seller is fully eligible, but every
    // offering is still in Draft. The seller must not surface.
    ownerEmail: "draft.offerings@ineligible.example",
    workspaceSlug: "negative-draft-offerings",
    workspaceName: "Negative Draft Offerings",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Draft-Only Offerings Seller",
    bio: "Seller whose offerings are all in Draft.",
    profileStatus: "Published",
    basedInCity: "Roseau",
    basedInRegion: null,
    basedInCountryCode: "DM",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["DM"],
    specialtyKeys: ["Songwriter"],
    offerings: [
      {
        slug: "negative-draft-offerings-offering-a",
        title: "Draft writing offering",
        description: "Draft offering that must be hidden by lifecycle status.",
        status: "Draft",
        serviceMode: "Remote",
        primaryCategoryKey: "songwriting",
        genreTags: ["Reggae"],
        serviceAreas: [{ countryCode: "DM" }],
      },
    ],
  },
  {
    // Paused-only offerings: every offering is Paused. The seller is
    // eligible, but no offering is Active; the seller must not surface.
    ownerEmail: "paused.offerings@ineligible.example",
    workspaceSlug: "negative-paused-offerings",
    workspaceName: "Negative Paused Offerings",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Paused-Only Offerings Seller",
    bio: "Seller whose offerings are all Paused.",
    profileStatus: "Published",
    basedInCity: "Saint John's",
    basedInRegion: null,
    basedInCountryCode: "AG",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["AG"],
    specialtyKeys: ["Producer"],
    offerings: [
      {
        slug: "negative-paused-offerings-offering-a",
        title: "Paused production offering",
        description: "Paused offering that must be hidden by lifecycle status.",
        status: "Paused",
        serviceMode: "Remote",
        primaryCategoryKey: "music-production",
        genreTags: ["Dancehall"],
        serviceAreas: [{ countryCode: "AG" }],
      },
    ],
  },
  {
    // Archived-only offerings: every offering is Archived. The seller
    // is eligible, but no offering is Active; the seller must not surface.
    ownerEmail: "archived.offerings@ineligible.example",
    workspaceSlug: "negative-archived-offerings",
    workspaceName: "Negative Archived Offerings",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Archived-Only Offerings Seller",
    bio: "Seller whose offerings are all Archived.",
    profileStatus: "Published",
    basedInCity: "Castries",
    basedInRegion: null,
    basedInCountryCode: "LC",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["LC"],
    specialtyKeys: ["SoundEngineer"],
    offerings: [
      {
        slug: "negative-archived-offerings-offering-a",
        title: "Archived mixing offering",
        description: "Archived offering that must be hidden by lifecycle status.",
        status: "Archived",
        serviceMode: "Remote",
        primaryCategoryKey: "mixing",
        genreTags: ["Calypso"],
        serviceAreas: [{ countryCode: "LC" }],
      },
    ],
  },
  {
    // Mixed lifecycle: one Active offering and one Paused offering. Only
    // the Active offering must surface; the Paused offering is hidden but
    // the seller remains discoverable. The Paused offering's lifecycle
    // proves the distinction between Paused (recoverable) and Archived
    // (terminal).
    ownerEmail: "mixed.paused@ineligible.example",
    workspaceSlug: "negative-mixed-paused-offerings",
    workspaceName: "Negative Mixed Paused Offerings",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Mixed Paused Seller",
    bio: "Seller with both Active and Paused offerings.",
    profileStatus: "Published",
    basedInCity: "Basseterre",
    basedInRegion: null,
    basedInCountryCode: "KN",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["KN"],
    specialtyKeys: ["Artist", "Musician"],
    offerings: [
      {
        slug: "negative-mixed-paused-offering-active",
        title: "Active session vocals for Caribbean releases",
        description: "Active offering that must surface.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "session-vocals",
        genreTags: ["Dancehall", "Soca"],
        serviceAreas: [{ countryCode: "KN" }],
      },
      {
        slug: "negative-mixed-paused-offering-paused",
        title: "Paused songwriting add-on",
        description: "Paused offering that must be hidden but the seller stays discoverable.",
        status: "Paused",
        serviceMode: "Remote",
        primaryCategoryKey: "songwriting",
        genreTags: ["Dancehall"],
        serviceAreas: [{ countryCode: "KN" }],
      },
    ],
  },
  {
    // Mixed lifecycle: one Active offering and one Archived offering.
    // Only the Active offering must surface; the Archived offering is
    // hidden and the seller remains discoverable.
    ownerEmail: "mixed.archived@ineligible.example",
    workspaceSlug: "negative-mixed-archived-offerings",
    workspaceName: "Negative Mixed Archived Offerings",
    workspaceType: "Personal",
    workspaceStatus: "Active",
    workspaceCapabilities: ["Seller"],
    professionalName: "Mixed Archived Seller",
    bio: "Seller with both Active and Archived offerings.",
    profileStatus: "Published",
    basedInCity: "Kingstown",
    basedInRegion: null,
    basedInCountryCode: "VC",
    avatarUrl: null,
    caribbeanAffiliationCodes: ["VC"],
    specialtyKeys: ["Songwriter"],
    offerings: [
      {
        slug: "negative-mixed-archived-offering-active",
        title: "Active custom composition for releases",
        description: "Active offering that must surface.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryKey: "custom-composition",
        genreTags: ["Calypso"],
        serviceAreas: [{ countryCode: "VC" }],
      },
      {
        slug: "negative-mixed-archived-offering-archived",
        title: "Archived production offering",
        description: "Archived offering that must be hidden but the seller stays discoverable.",
        status: "Archived",
        serviceMode: "Remote",
        primaryCategoryKey: "music-production",
        genreTags: ["Calypso"],
        serviceAreas: [{ countryCode: "VC" }],
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

// applySellerGraph: the single source of truth for persisting a full
// seller graph (UserAccount → Workspace → WorkspaceMembership →
// WorkspaceCapability → SellerProfile → CaribbeanAffiliation →
// SellerProfileSpecialty → ServiceOffering → ServiceOfferingServiceArea
// → ServiceOfferingPricing; includedService rows are reset to empty
// to match the M1.1 fixture).
//
// Both the canonical SELLERS (workspaceStatus "Active" + Seller
// capability) and the M1.3 negative eligibility fixtures (deliberately
// excluded states) flow through this helper. The differences are
// captured by the `workspaceStatus` and `workspaceCapabilities` fields
// on the seed plus the `profileStatus` field on the profile.
//
// The capability set is replaced (deleteMany + recreate) on every run
// so a stale capability mutation from a previous fixture does not
// persist. The same idempotent upsert pattern applies to the
// CaribbeanAffiliation and SellerProfileSpecialty join rows.
async function applySellerGraph(
  tx: Prisma.TransactionClient,
  seller: SellerGraphSeed,
): Promise<void> {
  const userId = toUserId(seller.ownerEmail);
  const workspaceId = toWorkspaceId(seller.workspaceSlug);
  const sellerProfileId = toSellerProfileId(seller.workspaceSlug);

  const owner = await tx.userAccount.upsert({
    where: { id: userId },
    create: { id: userId, email: seller.ownerEmail },
    // Restore the canonical email on every run so a stale email
    // mutation is restored.
    update: { email: seller.ownerEmail },
  });

  const workspace = await tx.workspace.upsert({
    where: { slug: seller.workspaceSlug },
    create: {
      id: workspaceId,
      slug: seller.workspaceSlug,
      name: seller.workspaceName,
      type: seller.workspaceType,
      status: seller.workspaceStatus,
      ownerUserId: owner.id,
    },
    // Restore the canonical ownerUserId and other fields on every run
    // so a stale update cannot persist.
    update: {
      name: seller.workspaceName,
      type: seller.workspaceType,
      status: seller.workspaceStatus,
      ownerUserId: owner.id,
    },
  });

  await tx.workspaceMembership.upsert({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    create: {
      userId: owner.id,
      workspaceId: workspace.id,
      role: "Owner",
      // M2.0A: the canonical authority is now `authority` (Owner | Editor).
      // Every canonical M1.1 fixture is owned by the seller themselves, so
      // the membership authority is `Owner`. The migration backfills this
      // for existing rows; new memberships created by the seed must supply
      // it explicitly.
      authority: "Owner",
    },
    update: {
      role: "Owner",
      // Restore the canonical authority on every run so a stale mutation
      // (e.g. a test that flipped it to Editor) cannot persist.
      authority: "Owner",
    },
  });

  // Replace the canonical capability set so re-running the seed
  // converges on the approved capability set (canonical: ["Seller"];
  // negative fixtures: ["Buyer"] or whatever the excluded state needs).
  await tx.workspaceCapability.deleteMany({ where: { workspaceId: workspace.id } });
  for (const capability of seller.workspaceCapabilities) {
    await tx.workspaceCapability.create({
      data: { workspaceId: workspace.id, capability },
    });
  }

  const profile = await tx.sellerProfile.upsert({
    where: { workspaceId: workspace.id },
    create: {
      id: sellerProfileId,
      workspaceId: workspace.id,
      professionalName: seller.professionalName,
      bio: seller.bio,
      status: seller.profileStatus,
      basedInCity: seller.basedInCity,
      basedInRegion: seller.basedInRegion,
      basedInCountryCode: seller.basedInCountryCode,
      avatarUrl: seller.avatarUrl,
    },
    update: {
      professionalName: seller.professionalName,
      bio: seller.bio,
      status: seller.profileStatus,
      basedInCity: seller.basedInCity,
      basedInRegion: seller.basedInRegion,
      basedInCountryCode: seller.basedInCountryCode,
      avatarUrl: seller.avatarUrl,
    },
  });

  // Caribbean affiliations: replace the canonical set, keyed on the
  // (sellerProfileId, countryCode) unique constraint.
  await tx.caribbeanAffiliation.deleteMany({ where: { sellerProfileId: profile.id } });
  for (const countryCode of seller.caribbeanAffiliationCodes) {
    await tx.caribbeanAffiliation.upsert({
      where: { sellerProfileId_countryCode: { sellerProfileId: profile.id, countryCode } },
      create: { sellerProfileId: profile.id, countryCode },
      update: {},
    });
  }

  // Specialties: replace the canonical set, keyed on the
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
      // Restore the canonical sellerProfileId and primaryCategoryId on
      // every run so a stale update cannot persist.
      update: {
        title: offering.title,
        description: offering.description,
        status: offering.status,
        serviceMode: offering.serviceMode,
        sellerProfileId: profile.id,
        primaryCategoryId: category.id,
        genreTags: [...offering.genreTags],
      },
    });

    const persisted = await tx.serviceOffering.findUnique({ where: { slug: offering.slug } });
    if (!persisted) {
      throw new Error(`Failed to persist offering ${offering.slug}`);
    }

    // Service areas: replace the canonical set.
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

    // Pricing: replace the canonical single-row record.
    await tx.serviceOfferingPricing.deleteMany({ where: { offeringId: persisted.id } });
    if (offering.pricing) {
      let unitId: string | null = null;
      if (offering.pricing.unitKey) {
        const unit = await tx.pricingUnit.findUnique({
          where: { key: offering.pricing.unitKey },
        });
        if (!unit) {
          throw new Error(
            `PricingUnit ${offering.pricing.unitKey} missing from controlled records`,
          );
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

    // M2.0A: upsert the initial published SellerProfileRevision and
    // ServiceOfferingRevision for this canonical fixture. The migration
    // backfills the same state when run against an already-populated M1.1
    // database; the test environment starts empty and the seed is the
    // authoritative source of the canonical fixture. Re-running the seed
    // converges on the same deterministic revision id
    // (`rev-{parentId}-1`) and the same immutable Published kind so the
    // canonical state is reproducible across runs.
    await applyInitialPublishedRevisions(tx, profile.id, persisted.id, seller, offering);
  }
}

// applyInitialPublishedRevisions: create the canonical initial
// published revision (revisionNumber = 1, kind = "Published") for a
// canonical SellerProfile / ServiceOffering pair. Mirrors the migration
// backfill SQL so the canonical fixture in the test environment matches
// the post-migration canonical state of a populated production
// database.
async function applyInitialPublishedRevisions(
  tx: Prisma.TransactionClient,
  sellerProfileId: string,
  serviceOfferingId: string,
  seller: SellerGraphSeed,
  offering: OfferingSeed,
): Promise<void> {
  const profile = await tx.sellerProfile.findUniqueOrThrow({
    where: { id: sellerProfileId },
  });
  const revisionId = `rev-${sellerProfileId}-1`;
  // Resolve primary category id for the offering.
  const primaryCategory = await tx.serviceCategory.findUniqueOrThrow({
    where: { key: offering.primaryCategoryKey },
  });
  // Resolve pricing unit id (if any).
  let pricingUnitId: string | null = null;
  if (offering.pricing?.unitKey) {
    const unit = await tx.pricingUnit.findUniqueOrThrow({
      where: { key: offering.pricing.unitKey },
    });
    pricingUnitId = unit.id;
  }

  // SellerProfileRevision (replace + recreate).
  await tx.sellerProfileRevision.deleteMany({ where: { sellerProfileId } });
  await tx.sellerProfileRevision.create({
    data: {
      id: revisionId,
      sellerProfileId,
      revisionNumber: 1,
      kind: "Published",
      professionalName: profile.professionalName,
      bio: profile.bio,
      basedInCity: profile.basedInCity,
      basedInRegion: profile.basedInRegion,
      basedInCountryCode: profile.basedInCountryCode,
      avatarUrl: profile.avatarUrl,
      publishedAt: new Date(),
    },
  });

  // Replace the canonical specialty set on the initial revision.
  await tx.sellerProfileRevisionSpecialty.deleteMany({
    where: { sellerProfileRevisionId: revisionId },
  });
  for (const specialtyKey of seller.specialtyKeys) {
    const specialty = await tx.specialty.findUniqueOrThrow({ where: { key: specialtyKey } });
    await tx.sellerProfileRevisionSpecialty.create({
      data: { sellerProfileRevisionId: revisionId, specialtyId: specialty.id },
    });
  }

  // Replace the canonical Caribbean affiliation set on the initial revision.
  await tx.sellerProfileRevisionCaribbeanAffiliation.deleteMany({
    where: { sellerProfileRevisionId: revisionId },
  });
  for (const countryCode of seller.caribbeanAffiliationCodes) {
    await tx.sellerProfileRevisionCaribbeanAffiliation.create({
      data: { sellerProfileRevisionId: revisionId, countryCode },
    });
  }

  // ServiceOfferingRevision (replace + recreate).
  const offeringRevisionId = `rev-${serviceOfferingId}-1`;
  await tx.serviceOfferingRevision.deleteMany({ where: { serviceOfferingId } });
  await tx.serviceOfferingRevision.create({
    data: {
      id: offeringRevisionId,
      serviceOfferingId,
      revisionNumber: 1,
      kind: "Published",
      title: offering.title,
      description: offering.description,
      serviceMode: offering.serviceMode,
      primaryCategoryId: primaryCategory.id,
      genreTags: [...offering.genreTags],
      pricingKind: offering.pricing?.kind ?? null,
      pricingAmountMinor: offering.pricing?.amountMinor ?? null,
      pricingCurrency: offering.pricing?.currency ?? null,
      pricingUnitId,
      publishedAt: new Date(),
    },
  });

  // Replace the canonical service-area set on the initial revision.
  await tx.serviceOfferingRevisionServiceArea.deleteMany({
    where: { serviceOfferingRevisionId: offeringRevisionId },
  });
  for (const area of offering.serviceAreas) {
    await tx.serviceOfferingRevisionServiceArea.create({
      data: {
        serviceOfferingRevisionId: offeringRevisionId,
        city: area.city ?? null,
        region: area.region ?? null,
        countryCode: area.countryCode,
      },
    });
  }
}

async function applySeed(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Controlled records (categorical taxonomies).
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

    // Sellers and their full relationship graph. The canonical SELLERS
    // and the M1.3 negative fixtures share the same persistence flow;
    // `applySellerGraph` (below) is the single source of truth and
    // handles both sets.
    for (const seller of SELLERS) {
      await applySellerGraph(tx, seller);
    }

    // M1.3 negative eligibility fixtures. These deliberately cover every
    // excluded state called out by issue #4 and are seeded with stable
    // IDs so repository integration tests can reference them by primary
    // M1.3 negative eligibility fixtures. These deliberately cover every
    // excluded state called out by issue #4 and are seeded with stable
    // IDs so repository integration tests can reference them by primary
    // key. They are NOT included in the canonical SELLERS array, so the
    // canonical snapshot assertion is unchanged.
    for (const fixture of NEGATIVE_FIXTURES) {
      await applySellerGraph(tx, fixture);
    }
  });
}

// Canonical state snapshot. Proves the closed canonical set is present
// and correct, not that no other rows exist. The snapshot is JSON-stable
// (keys are emitted in declaration order) so two runs produce byte-equal
// strings for the comparison below.
//
// Every material field the seed owns is captured here. The seed does
// not own fields outside this set (e.g., random user data, audit
// fields, etc.); those are intentionally outside the convergence
// contract.
interface CanonicalSnapshot {
  readonly categories: readonly {
    readonly key: string;
    readonly name: string;
    readonly description: string;
    readonly bundleOnly: boolean;
  }[];
  readonly specialties: readonly { readonly key: string; readonly name: string }[];
  readonly pricingUnits: readonly { readonly key: string; readonly name: string }[];
  readonly sellers: readonly {
    readonly userEmail: string;
    readonly userId: string;
    readonly workspaceSlug: string;
    readonly workspaceId: string;
    readonly workspaceName: string;
    readonly workspaceType: string;
    readonly workspaceStatus: string;
    readonly ownerUserId: string;
    readonly membershipRole: string;
    readonly sellerCapability: string;
    readonly sellerProfileId: string;
    readonly professionalName: string;
    readonly bio: string;
    readonly avatarUrl: string | null;
    readonly status: string;
    readonly basedInCity: string | null;
    readonly basedInRegion: string | null;
    readonly basedInCountryCode: string;
    readonly caribbeanAffiliationCodes: readonly string[];
    readonly specialtyKeys: readonly string[];
    readonly offerings: readonly {
      readonly id: string;
      readonly slug: string;
      readonly sellerProfileId: string;
      readonly primaryCategoryKey: string;
      readonly primaryCategoryName: string;
      readonly primaryCategoryBundleOnly: boolean;
      readonly title: string;
      readonly description: string;
      readonly status: string;
      readonly serviceMode: string;
      readonly genreTags: readonly string[];
      readonly includedServiceKeys: readonly string[];
      readonly serviceAreas: readonly {
        readonly city: string | null;
        readonly region: string | null;
        readonly countryCode: string;
      }[];
      readonly pricing: {
        readonly kind: string;
        readonly amountMinor: number | null;
        readonly currency: string | null;
        readonly unitKey: string | null;
      } | null;
    }[];
  }[];
}

// Exported for the snapshot-probe regression test
// (packages/db/prisma/snapshot-probe.ts). The probe runs only
// the snapshot capture and the canonical assertion, without
// running applySeed()'s canonical-state cleanup, so the
// assertion's strictness can be verified directly.
export async function captureCanonicalSnapshot(): Promise<CanonicalSnapshot> {
  const categories = await prisma.serviceCategory.findMany({
    where: { key: { in: SERVICE_CATEGORIES.map((c) => c.key) } },
    orderBy: { key: "asc" },
  });
  const specialties = await prisma.specialty.findMany({
    where: { key: { in: [...SPECIALTY_KEYS] } },
    orderBy: { key: "asc" },
  });
  const pricingUnits = await prisma.pricingUnit.findMany({
    where: { key: { in: PRICING_UNITS.map((u) => u.key) } },
    orderBy: { key: "asc" },
  });

  const sellers: CanonicalSnapshot["sellers"][number][] = [];
  for (const seller of SELLERS) {
    const user = await prisma.userAccount.findUnique({ where: { email: seller.ownerEmail } });
    if (!user) {
      throw new Error(`Canonical user ${seller.ownerEmail} missing after seed`);
    }
    const workspace = await prisma.workspace.findUnique({
      where: { slug: seller.workspaceSlug },
    });
    if (!workspace) {
      throw new Error(`Canonical workspace ${seller.workspaceSlug} missing after seed`);
    }
    const membership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    });
    const capability = await prisma.workspaceCapability.findUnique({
      where: {
        workspaceId_capability: { workspaceId: workspace.id, capability: "Seller" },
      },
    });
    const profile = await prisma.sellerProfile.findUnique({
      where: { workspaceId: workspace.id },
    });
    if (!profile) {
      throw new Error(`Canonical seller profile ${seller.workspaceSlug} missing after seed`);
    }
    const affiliations = await prisma.caribbeanAffiliation.findMany({
      where: { sellerProfileId: profile.id },
      orderBy: { countryCode: "asc" },
    });
    const specialtiesForProfile = await prisma.sellerProfileSpecialty.findMany({
      where: { sellerProfileId: profile.id },
      include: { specialty: true },
      orderBy: { specialtyId: "asc" },
    });
    const offerings = await prisma.serviceOffering.findMany({
      where: { sellerProfileId: profile.id },
      include: {
        primaryCategory: true,
        serviceAreas: { orderBy: { id: "asc" } },
        pricing: { include: { unit: true } },
        // Observe the actual IncludedService relation from
        // PostgreSQL. The canonical snapshot must read this
        // relationship so the assertion can verify it is the
        // empty set, instead of asserting against a fabricated
        // hardcoded value.
        includedServices: { include: { category: true }, orderBy: { id: "asc" } },
      },
      orderBy: { slug: "asc" },
    });

    sellers.push({
      userEmail: user.email,
      userId: user.id,
      workspaceSlug: workspace.slug,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceType: workspace.type,
      workspaceStatus: workspace.status,
      ownerUserId: workspace.ownerUserId,
      membershipRole: membership?.role ?? null,
      sellerCapability: capability?.capability ?? null,
      sellerProfileId: profile.id,
      professionalName: profile.professionalName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      status: profile.status,
      basedInCity: profile.basedInCity,
      basedInRegion: profile.basedInRegion,
      basedInCountryCode: profile.basedInCountryCode,
      caribbeanAffiliationCodes: affiliations.map((a) => a.countryCode),
      specialtyKeys: specialtiesForProfile.map((row) => row.specialty.key),
      offerings: offerings.map((offering) => ({
        id: offering.id,
        slug: offering.slug,
        sellerProfileId: offering.sellerProfileId,
        primaryCategoryKey: offering.primaryCategory.key,
        primaryCategoryName: offering.primaryCategory.name,
        primaryCategoryBundleOnly: offering.primaryCategory.bundleOnly,
        title: offering.title,
        description: offering.description,
        status: offering.status,
        serviceMode: offering.serviceMode,
        genreTags: [...offering.genreTags],
        // M1.1 ships with no bundles: every canonical offering's
        // includedServices relation must be the empty set in
        // PostgreSQL. The keys are derived from the observed
        // relationship (category.key per row) rather than from a
        // hardcoded array; the assertion compares the observed
        // keys with the canonical expected empty set.
        includedServiceKeys: offering.includedServices.map((is) => is.category.key),
        serviceAreas: offering.serviceAreas.map((area) => ({
          city: area.city,
          region: area.region,
          countryCode: area.countryCode,
        })),
        pricing: offering.pricing
          ? {
              kind: offering.pricing.kind,
              amountMinor: offering.pricing.amountMinor,
              currency: offering.pricing.currency,
              unitKey: offering.pricing.unit?.key ?? null,
            }
          : null,
      })),
    });
  }

  return {
    categories: categories.map((c) => ({
      key: c.key,
      name: c.name,
      description: c.description ?? "",
      bundleOnly: c.bundleOnly,
    })),
    specialties: specialties.map((s) => ({ key: s.key, name: s.name })),
    pricingUnits: pricingUnits.map((u) => ({ key: u.key, name: u.name })),
    sellers: sellers as unknown as CanonicalSnapshot["sellers"],
  };
}

// Exported for the snapshot-probe regression test (see
// captureCanonicalSnapshot above).
export function assertCanonicalSnapshotCorrect(snapshot: CanonicalSnapshot): void {
  // 1. Controlled taxonomies.
  if (snapshot.categories.length !== SERVICE_CATEGORIES.length) {
    throw new Error(
      `ServiceCategory count mismatch: expected ${SERVICE_CATEGORIES.length}, got ${snapshot.categories.length}`,
    );
  }
  for (let i = 0; i < SERVICE_CATEGORIES.length; i += 1) {
    const expected = SERVICE_CATEGORIES[i]!;
    const actual = snapshot.categories.find((c) => c.key === expected.key);
    if (!actual) {
      throw new Error(`ServiceCategory ${expected.key} missing from canonical snapshot`);
    }
    if (
      actual.name !== expected.name ||
      actual.description !== expected.description ||
      actual.bundleOnly !== expected.bundleOnly
    ) {
      throw new Error(
        `ServiceCategory ${expected.key} values drifted: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
      );
    }
  }

  if (snapshot.specialties.length !== SPECIALTY_KEYS.length) {
    throw new Error(
      `Specialty count mismatch: expected ${SPECIALTY_KEYS.length}, got ${snapshot.specialties.length}`,
    );
  }
  for (const key of SPECIALTY_KEYS) {
    const actual = snapshot.specialties.find((s) => s.key === key);
    if (!actual) {
      throw new Error(`Specialty ${key} missing from canonical snapshot`);
    }
  }

  if (snapshot.pricingUnits.length !== PRICING_UNITS.length) {
    throw new Error(
      `PricingUnit count mismatch: expected ${PRICING_UNITS.length}, got ${snapshot.pricingUnits.length}`,
    );
  }
  for (const expected of PRICING_UNITS) {
    const actual = snapshot.pricingUnits.find((u) => u.key === expected.key);
    if (!actual) {
      throw new Error(`PricingUnit ${expected.key} missing from canonical snapshot`);
    }
    if (actual.name !== expected.name) {
      throw new Error(`PricingUnit ${expected.key} name drifted: ${actual.name}`);
    }
  }

  // 2. Sellers and full relationship graph.
  if (snapshot.sellers.length !== SELLERS.length) {
    throw new Error(
      `Seller count mismatch: expected ${SELLERS.length}, got ${snapshot.sellers.length}`,
    );
  }
  for (const seller of SELLERS) {
    const actual = snapshot.sellers.find((s) => s.workspaceSlug === seller.workspaceSlug);
    if (!actual) {
      throw new Error(`Canonical seller ${seller.workspaceSlug} missing from snapshot`);
    }
    // Critical relationship fields.
    if (actual.ownerUserId !== toUserId(seller.ownerEmail)) {
      throw new Error(
        `Workspace ${seller.workspaceSlug}.ownerUserId drifted: expected ${toUserId(seller.ownerEmail)} got ${actual.ownerUserId}`,
      );
    }
    if (actual.sellerProfileId !== toSellerProfileId(seller.workspaceSlug)) {
      throw new Error(
        `Workspace ${seller.workspaceSlug}.sellerProfileId drifted: expected ${toSellerProfileId(seller.workspaceSlug)} got ${actual.sellerProfileId}`,
      );
    }
    if (actual.membershipRole !== "Owner") {
      throw new Error(
        `WorkspaceMembership for ${seller.workspaceSlug} role drifted: expected Owner got ${actual.membershipRole}`,
      );
    }
    if (actual.sellerCapability !== "Seller") {
      throw new Error(
        `WorkspaceCapability for ${seller.workspaceSlug} drifted: expected Seller got ${actual.sellerCapability}`,
      );
    }
    // Stable field values.
    if (actual.userEmail !== seller.ownerEmail) {
      throw new Error(
        `UserAccount email drifted for ${seller.workspaceSlug}: expected ${seller.ownerEmail} got ${actual.userEmail}`,
      );
    }
    if (actual.userId !== toUserId(seller.ownerEmail)) {
      throw new Error(
        `UserAccount id drifted for ${seller.workspaceSlug}: expected ${toUserId(seller.ownerEmail)} got ${actual.userId}`,
      );
    }
    if (actual.workspaceSlug !== seller.workspaceSlug) {
      throw new Error(
        `Workspace slug drifted: expected ${seller.workspaceSlug} got ${actual.workspaceSlug}`,
      );
    }
    if (actual.workspaceId !== toWorkspaceId(seller.workspaceSlug)) {
      throw new Error(
        `Workspace id drifted: expected ${toWorkspaceId(seller.workspaceSlug)} got ${actual.workspaceId}`,
      );
    }
    if (actual.workspaceName !== seller.workspaceName) {
      throw new Error(
        `Workspace name drifted: expected ${seller.workspaceName} got ${actual.workspaceName}`,
      );
    }
    if (actual.workspaceType !== seller.workspaceType) {
      throw new Error(
        `Workspace type drifted: expected ${seller.workspaceType} got ${actual.workspaceType}`,
      );
    }
    if (actual.workspaceStatus !== "Active") {
      throw new Error(
        `Workspace ${seller.workspaceSlug}.status drifted: expected Active got ${actual.workspaceStatus}`,
      );
    }
    if (actual.professionalName !== seller.professionalName) {
      throw new Error(
        `SellerProfile.professionalName drifted: expected ${seller.professionalName} got ${actual.professionalName}`,
      );
    }
    if (actual.bio !== seller.bio) {
      throw new Error(`SellerProfile.bio drifted for ${seller.workspaceSlug}`);
    }
    if (actual.avatarUrl !== seller.avatarUrl) {
      throw new Error(
        `SellerProfile.avatarUrl drifted for ${seller.workspaceSlug}: expected ${JSON.stringify(seller.avatarUrl)} got ${JSON.stringify(actual.avatarUrl)}`,
      );
    }
    if (actual.status !== seller.profileStatus) {
      throw new Error(
        `SellerProfile ${seller.workspaceSlug}.status drifted: expected ${seller.profileStatus} got ${actual.status}`,
      );
    }
    if (actual.basedInCity !== seller.basedInCity) {
      throw new Error(
        `SellerProfile ${seller.workspaceSlug}.basedInCity drifted: expected ${JSON.stringify(seller.basedInCity)} got ${JSON.stringify(actual.basedInCity)}`,
      );
    }
    if (actual.basedInRegion !== seller.basedInRegion) {
      throw new Error(
        `SellerProfile ${seller.workspaceSlug}.basedInRegion drifted: expected ${JSON.stringify(seller.basedInRegion)} got ${JSON.stringify(actual.basedInRegion)}`,
      );
    }
    if (actual.basedInCountryCode !== seller.basedInCountryCode) {
      throw new Error(`SellerProfile ${seller.workspaceSlug}.basedInCountryCode drifted`);
    }
    if (
      JSON.stringify([...actual.caribbeanAffiliationCodes].sort()) !==
      JSON.stringify([...seller.caribbeanAffiliationCodes].sort())
    ) {
      throw new Error(
        `CaribbeanAffiliations for ${seller.workspaceSlug} drifted: expected ${JSON.stringify(seller.caribbeanAffiliationCodes)} got ${JSON.stringify(actual.caribbeanAffiliationCodes)}`,
      );
    }
    if (
      JSON.stringify([...actual.specialtyKeys].sort()) !==
      JSON.stringify([...seller.specialtyKeys].sort())
    ) {
      throw new Error(`Specialties for ${seller.workspaceSlug} drifted`);
    }
    // Offerings and their canonical fields.
    if (actual.offerings.length !== seller.offerings.length) {
      throw new Error(
        `Offerings for ${seller.workspaceSlug} count drifted: expected ${seller.offerings.length} got ${actual.offerings.length}`,
      );
    }
    for (const offering of seller.offerings) {
      const actualOffering = actual.offerings.find((o) => o.slug === offering.slug);
      if (!actualOffering) {
        throw new Error(
          `Offering ${offering.slug} missing from canonical snapshot for ${seller.workspaceSlug}`,
        );
      }
      if (actualOffering.id !== toOfferingId(offering.slug)) {
        throw new Error(
          `ServiceOffering ${offering.slug}.id drifted: expected ${toOfferingId(offering.slug)} got ${actualOffering.id}`,
        );
      }
      if (actualOffering.slug !== offering.slug) {
        throw new Error(
          `ServiceOffering ${offering.slug}.slug drifted: expected ${offering.slug} got ${actualOffering.slug}`,
        );
      }
      if (actualOffering.sellerProfileId !== toSellerProfileId(seller.workspaceSlug)) {
        throw new Error(
          `ServiceOffering ${offering.slug}.sellerProfileId drifted: expected ${toSellerProfileId(seller.workspaceSlug)} got ${actualOffering.sellerProfileId}`,
        );
      }
      if (actualOffering.title !== offering.title) {
        throw new Error(`ServiceOffering ${offering.slug}.title drifted`);
      }
      if (actualOffering.description !== offering.description) {
        throw new Error(`ServiceOffering ${offering.slug}.description drifted`);
      }
      if (actualOffering.status !== offering.status) {
        throw new Error(`ServiceOffering ${offering.slug}.status drifted`);
      }
      if (actualOffering.serviceMode !== offering.serviceMode) {
        throw new Error(`ServiceOffering ${offering.slug}.serviceMode drifted`);
      }
      // Primary category: the M1 fixture has no `bundleOnly: true`
      // categories in the canonical SELLERS data, so we assert
      // `false` and also verify the M1.1 contract that there are no
      // canonical bundle-only categories.
      if (actualOffering.primaryCategoryKey !== offering.primaryCategoryKey) {
        throw new Error(
          `ServiceOffering ${offering.slug}.primaryCategoryKey drifted: expected ${offering.primaryCategoryKey} got ${actualOffering.primaryCategoryKey}`,
        );
      }
      const expectedCategory = SERVICE_CATEGORIES.find(
        (c) => c.key === offering.primaryCategoryKey,
      );
      if (!expectedCategory) {
        throw new Error(
          `ServiceOffering ${offering.slug} references unknown category ${offering.primaryCategoryKey}`,
        );
      }
      if (actualOffering.primaryCategoryName !== expectedCategory.name) {
        throw new Error(
          `ServiceOffering ${offering.slug}.primaryCategoryName drifted: expected ${expectedCategory.name} got ${actualOffering.primaryCategoryName}`,
        );
      }
      if (actualOffering.primaryCategoryBundleOnly !== false) {
        throw new Error(
          `ServiceOffering ${offering.slug}.primaryCategory.bundleOnly must be false in the M1.1 fixture but is ${actualOffering.primaryCategoryBundleOnly}`,
        );
      }
      // The M1.1 canonical seed owns zero bundle-only IncludedService
      // rows. Future tickets that add bundles must extend the seed
      // and update this assertion accordingly.
      if (actualOffering.includedServiceKeys.length !== 0) {
        throw new Error(
          `ServiceOffering ${offering.slug}.includedServices must be empty in the M1.1 fixture but has ${actualOffering.includedServiceKeys.length} rows`,
        );
      }
      if (
        JSON.stringify([...actualOffering.genreTags].sort()) !==
        JSON.stringify([...offering.genreTags].sort())
      ) {
        throw new Error(`ServiceOffering ${offering.slug}.genreTags drifted`);
      }
      if (actualOffering.serviceAreas.length !== offering.serviceAreas.length) {
        throw new Error(
          `ServiceOffering ${offering.slug}.serviceAreas count drifted: expected ${offering.serviceAreas.length} got ${actualOffering.serviceAreas.length}`,
        );
      }
      const expectedAreas = [...offering.serviceAreas]
        .map((a) => `${a.city ?? ""}|${a.region ?? ""}|${a.countryCode}`)
        .sort();
      const actualAreas = actualOffering.serviceAreas
        .map((a) => `${a.city ?? ""}|${a.region ?? ""}|${a.countryCode}`)
        .sort();
      if (JSON.stringify(expectedAreas) !== JSON.stringify(actualAreas)) {
        throw new Error(
          `ServiceOffering ${offering.slug}.serviceAreas drifted: expected ${JSON.stringify(expectedAreas)} got ${JSON.stringify(actualAreas)}`,
        );
      }
      if ((offering.pricing === undefined) !== (actualOffering.pricing === null)) {
        throw new Error(
          `ServiceOffering ${offering.slug} pricing presence drifted: expected ${offering.pricing === undefined ? "no pricing" : "pricing row"} got ${actualOffering.pricing ? "pricing row" : "no pricing"}`,
        );
      }
      if (offering.pricing && actualOffering.pricing) {
        if (actualOffering.pricing.kind !== offering.pricing.kind) {
          throw new Error(
            `ServiceOffering ${offering.slug} pricing.kind drifted: expected ${offering.pricing.kind} got ${actualOffering.pricing.kind}`,
          );
        }
        if (actualOffering.pricing.amountMinor !== (offering.pricing.amountMinor ?? null)) {
          throw new Error(
            `ServiceOffering ${offering.slug} pricing.amountMinor drifted: expected ${offering.pricing.amountMinor ?? null} got ${actualOffering.pricing.amountMinor}`,
          );
        }
        if (actualOffering.pricing.currency !== (offering.pricing.currency ?? null)) {
          throw new Error(
            `ServiceOffering ${offering.slug} pricing.currency drifted: expected ${offering.pricing.currency ?? null} got ${actualOffering.pricing.currency}`,
          );
        }
        if (actualOffering.pricing.unitKey !== (offering.pricing.unitKey ?? null)) {
          throw new Error(
            `ServiceOffering ${offering.slug} pricing.unitKey drifted: expected ${offering.pricing.unitKey ?? null} got ${actualOffering.pricing.unitKey}`,
          );
        }
      }
    }
  }
}

function assertSnapshotsEqual(a: CanonicalSnapshot, b: CanonicalSnapshot): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `Canonical snapshot drift between runs:\nfirst=${JSON.stringify(a, null, 2)}\nsecond=${JSON.stringify(b, null, 2)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log("🌱 Applying deterministic M1.1 seed (canonical relationships and fields)…");
  await applySeed();
  const first = await captureCanonicalSnapshot();
  assertCanonicalSnapshotCorrect(first);
  console.log(
    `✅ First pass converged: ${first.sellers.length} sellers, ${first.sellers.reduce((n, s) => n + s.offerings.length, 0)} active offerings, ` +
      `${first.categories.length} categories, ${first.specialties.length} specialties, ${first.pricingUnits.length} pricing units.`,
  );

  await applySeed();
  const second = await captureCanonicalSnapshot();
  assertCanonicalSnapshotCorrect(second);
  assertSnapshotsEqual(first, second);
  console.log("✅ Second pass produced an identical canonical snapshot.");
}

// Only run the seed main() when this file is invoked directly,
// not when it is imported by another module (e.g. the
// snapshot-probe regression test). When the entry point is the
// seed file itself, process.argv[1] ends with `seed.ts`.
const isDirectInvocation = (() => {
  if (typeof process === "undefined") return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("/seed.ts") || entry.endsWith("/seed.js");
})();

if (isDirectInvocation) {
  main()
    .catch((err) => {
      console.error("❌ Error seeding database:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
