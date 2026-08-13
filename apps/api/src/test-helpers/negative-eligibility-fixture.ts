// Shared negative eligibility fixture for the in-memory test layers.
//
// The M1.3 acceptance criteria require every excluded state to be
// covered: Draft / Suspended SellerProfile, Suspended Workspace,
// Buyer-only Workspace (no Seller capability), Draft / Paused /
// Archived-only offerings, and mixed Active+Paused / Active+Archived
// sellers (only the Active offering must surface). The same nine
// cases must be exercised at the service boundary
// (talent-search.service.test.ts) and the route boundary
// (search.test.ts). Re-declaring the fixture in both layers created
// drift risk; this builder is the single source of truth for the
// in-memory fixture.
//
// The browser e2e test (apps/web/e2e/negative-eligibility.spec.ts)
// is out of scope: it observes the real PostgreSQL-seeded data
// (packages/db/prisma/seed.ts NEGATIVE_FIXTURES) and uses the
// stable IDs from the canonical seed. The in-memory fixture mirrors
// the seed's excluded-state coverage but uses in-memory IDs of the
// form `neg-*` / `neg-off-*` so the two layers can be reasoned
// about independently.

import type {
  InMemoryFixture,
  InMemoryOffering,
} from "../repositories/in-memory-talent-search.repository.js";

// Offering row used by every excluded-state fixture whose exclusion
// reason is NOT the offering's status. Differentiated copies
// (NEG_OFF_DRAFT / NEG_OFF_PAUSED / NEG_OFF_ARCHIVED) flip the
// `status` field for the lifecycle-only exclusion cases.
const NEG_OFF_REMOTE: InMemoryOffering = {
  offeringId: "neg-off-remote",
  title: "Hidden Caribbean production offering",
  description: "Used as the offering row on every excluded-state fixture.",
  status: "Active",
  serviceMode: "Remote",
  primaryCategory: { key: "music-production", name: "Music Production", bundleOnly: false },
  includedServices: [],
  genreTags: ["Dancehall"],
  serviceAreas: [{ city: null, region: null, countryCode: "JM" }],
  pricing: null,
};

const NEG_OFF_DRAFT: InMemoryOffering = {
  ...NEG_OFF_REMOTE,
  offeringId: "neg-off-draft",
  status: "Draft",
};
const NEG_OFF_PAUSED: InMemoryOffering = {
  ...NEG_OFF_REMOTE,
  offeringId: "neg-off-paused",
  status: "Paused",
};
const NEG_OFF_ARCHIVED: InMemoryOffering = {
  ...NEG_OFF_REMOTE,
  offeringId: "neg-off-archived",
  status: "Archived",
};

// The controlled-key surface must match the canonical seed (M1
// controlled records) so the in-memory repository's controlled-key
// validation agrees with the Prisma adapter. The set is closed; the
// service-category keys are the canonical 10, and the specialty and
// pricing-unit keys are the canonical 5 and 6 respectively.
const CONTROLLED_KEYS: InMemoryFixture["controlledKeys"] = {
  serviceCategoryKeys: [
    "music-production",
    "songwriting",
    "custom-composition",
    "session-vocals",
    "session-instrument-performance",
    "featured-artist-performance",
    "mixing",
    "mastering",
    "recording-engineering",
    "live-performance",
  ],
  specialtyKeys: ["Artist", "Producer", "Musician", "Songwriter", "SoundEngineer"],
  pricingUnitKeys: ["hour", "track", "project", "session", "event", "day"],
};

export function buildNegativeEligibilityFixture(): InMemoryFixture {
  return {
    sellers: [
      {
        sellerId: "neg-draft-profile",
        workspaceId: "neg-ws-draft-profile",
        professionalName: "Draft Profile Seller",
        bio: "",
        status: "Draft",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "JM",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [NEG_OFF_REMOTE],
      },
      {
        sellerId: "neg-suspended-profile",
        workspaceId: "neg-ws-suspended-profile",
        professionalName: "Suspended Profile Seller",
        bio: "",
        status: "Suspended",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "TT",
        avatarUrl: null,
        specialtyKeys: ["Artist"],
        caribbeanAffiliationCodes: ["TT"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [NEG_OFF_REMOTE],
      },
      {
        sellerId: "neg-suspended-workspace",
        workspaceId: "neg-ws-suspended-workspace",
        professionalName: "Suspended Workspace Seller",
        bio: "",
        status: "Published",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "BB",
        avatarUrl: null,
        specialtyKeys: ["Musician"],
        caribbeanAffiliationCodes: ["BB"],
        workspaceStatus: "Suspended",
        workspaceHasSellerCapability: true,
        offerings: [NEG_OFF_REMOTE],
      },
      {
        sellerId: "neg-buyer-only",
        workspaceId: "neg-ws-buyer-only",
        professionalName: "Buyer-Only Seller",
        bio: "",
        status: "Published",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "GY",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["GY"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: false,
        offerings: [NEG_OFF_REMOTE],
      },
      {
        sellerId: "neg-draft-offerings",
        workspaceId: "neg-ws-draft-offerings",
        professionalName: "Draft-Only Seller",
        bio: "",
        status: "Published",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "DM",
        avatarUrl: null,
        specialtyKeys: ["Songwriter"],
        caribbeanAffiliationCodes: ["DM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [NEG_OFF_DRAFT],
      },
      {
        sellerId: "neg-paused-offerings",
        workspaceId: "neg-ws-paused-offerings",
        professionalName: "Paused-Only Seller",
        bio: "",
        status: "Published",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "AG",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["AG"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [NEG_OFF_PAUSED],
      },
      {
        sellerId: "neg-archived-offerings",
        workspaceId: "neg-ws-archived-offerings",
        professionalName: "Archived-Only Seller",
        bio: "",
        status: "Published",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "LC",
        avatarUrl: null,
        specialtyKeys: ["SoundEngineer"],
        caribbeanAffiliationCodes: ["LC"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [NEG_OFF_ARCHIVED],
      },
      {
        sellerId: "neg-mixed-paused",
        workspaceId: "neg-ws-mixed-paused",
        professionalName: "Mixed Paused Seller",
        bio: "",
        status: "Published",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "KN",
        avatarUrl: null,
        specialtyKeys: ["Artist", "Musician"],
        caribbeanAffiliationCodes: ["KN"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          NEG_OFF_REMOTE,
          { ...NEG_OFF_PAUSED, offeringId: "neg-off-mixed-paused-paused" },
        ],
      },
      {
        sellerId: "neg-mixed-archived",
        workspaceId: "neg-ws-mixed-archived",
        professionalName: "Mixed Archived Seller",
        bio: "",
        status: "Published",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "VC",
        avatarUrl: null,
        specialtyKeys: ["Songwriter"],
        caribbeanAffiliationCodes: ["VC"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          NEG_OFF_REMOTE,
          { ...NEG_OFF_ARCHIVED, offeringId: "neg-off-mixed-archived-archived" },
        ],
      },
    ],
    controlledKeys: CONTROLLED_KEYS,
  };
}
