/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TalentSearchService } from "./talent-search.service.js";
import {
  InMemoryTalentSearchRepository,
  type InMemoryFixture,
  type InMemoryOffering,
  type InMemorySeller,
} from "../repositories/in-memory-talent-search.repository.js";
import {
  talentSearchRequestV1Schema,
  talentSearchResponseV1Schema,
  type SellerProfileStatusV1,
  type ServiceOfferingStatusV1,
  type WorkspaceStatusV1,
} from "@soundhub/types";

void (null as unknown as SellerProfileStatusV1 | ServiceOfferingStatusV1 | WorkspaceStatusV1);

const REMOTE_PRODUCTION: InMemoryOffering = {
  offeringId: "offering-remote-production",
  title: "Haitian dancehall single production — remote",
  description: "Caribbean-flavored dancehall single production for diaspora artists.",
  status: "Active",
  serviceMode: "Remote",
  primaryCategory: { key: "music-production", name: "Music Production", bundleOnly: false },
  includedServices: [],
  genreTags: ["Dancehall", "Soca", "Hip-Hop"],
  serviceAreas: [{ city: "Brooklyn", region: "NY", countryCode: "US" }],
  pricing: {
    kind: "StartingAt",
    amountMinor: 60000,
    currency: "USD",
    unitKey: "track",
  },
};

const INPERSON_LIVE: InMemoryOffering = {
  offeringId: "offering-inperson-live",
  title: "Caribbean live set and band direction",
  description: "Hybrid live set with band direction.",
  status: "Active",
  serviceMode: "InPerson",
  primaryCategory: { key: "live-performance", name: "Live Performance", bundleOnly: false },
  includedServices: [],
  genreTags: ["Junkanoo", "Dancehall"],
  serviceAreas: [{ city: "Nassau", region: null, countryCode: "BS" }],
  pricing: null,
};

const BUNDLE_ONLY: InMemoryOffering = {
  offeringId: "offering-bundle-only",
  title: "Add-on songwriting deliverable",
  description: "Bundle-only songwriting add-on that is not independently purchasable.",
  status: "Active",
  serviceMode: "Remote",
  primaryCategory: { key: "songwriting", name: "Songwriting", bundleOnly: true },
  includedServices: [],
  genreTags: [],
  serviceAreas: [{ city: null, region: null, countryCode: "US" }],
  pricing: null,
};

const DRAFT_OFFERING: InMemoryOffering = {
  offeringId: "offering-draft-music-production",
  title: "Draft production offering",
  description: "Should be excluded from search results.",
  status: "Draft",
  serviceMode: "Remote",
  primaryCategory: { key: "music-production", name: "Music Production", bundleOnly: false },
  includedServices: [],
  genreTags: [],
  serviceAreas: [{ city: null, region: null, countryCode: "US" }],
  pricing: null,
};

const TRINIDAD_SESSION: InMemoryOffering = {
  offeringId: "offering-trinidad-session",
  title: "Remote session vocals",
  description: "Remote session vocals based in London.",
  status: "Active",
  serviceMode: "Remote",
  primaryCategory: { key: "session-vocals", name: "Session Vocals", bundleOnly: false },
  includedServices: [],
  genreTags: [],
  serviceAreas: [{ city: "London", region: null, countryCode: "GB" }],
  pricing: null,
};

const LONDON_GB_SELLER: InMemorySeller = {
  sellerId: "seller-london-gb",
  workspaceId: "workspace-london",
  professionalName: "London Seller",
  bio: "London-based seller.",
  status: "Published",
  basedInCity: "London",
  basedInRegion: null,
  basedInCountryCode: "GB",
  avatarUrl: null,
  specialtyKeys: ["Artist"],
  caribbeanAffiliationCodes: ["TT"],
  workspaceStatus: "Active",
  workspaceHasSellerCapability: true,
  offerings: [TRINIDAD_SESSION],
};

const BUNDLE_ONLY_SELLER: InMemorySeller = {
  sellerId: "seller-bundle-only",
  workspaceId: "workspace-bundle-only",
  professionalName: "Bundle Only Seller",
  bio: "Offers only bundle-only services.",
  status: "Published",
  basedInCity: "Brooklyn",
  basedInRegion: "NY",
  basedInCountryCode: "US",
  avatarUrl: null,
  specialtyKeys: ["Producer"],
  caribbeanAffiliationCodes: ["JM"],
  workspaceStatus: "Active",
  workspaceHasSellerCapability: true,
  offerings: [BUNDLE_ONLY],
};

function buildFixture(): InMemoryFixture {
  const sellers: InMemorySeller[] = [
    {
      sellerId: "seller-haitian-brooklyn",
      workspaceId: "workspace-creole-beats",
      professionalName: "Marc-André Pierre",
      bio: "Brooklyn-based Haitian producer.",
      status: "Published",
      basedInCity: "Brooklyn",
      basedInRegion: "NY",
      basedInCountryCode: "US",
      avatarUrl: null,
      specialtyKeys: ["Producer"],
      caribbeanAffiliationCodes: ["HT"],
      workspaceStatus: "Active",
      workspaceHasSellerCapability: true,
      offerings: [REMOTE_PRODUCTION],
    },
    {
      sellerId: "seller-bahamian-live",
      workspaceId: "workspace-devon-king",
      professionalName: "Devon King",
      bio: "Bahamian live performer.",
      status: "Published",
      basedInCity: "Nassau",
      basedInRegion: null,
      basedInCountryCode: "BS",
      avatarUrl: null,
      specialtyKeys: ["Artist"],
      caribbeanAffiliationCodes: ["BS"],
      workspaceStatus: "Active",
      workspaceHasSellerCapability: true,
      offerings: [INPERSON_LIVE],
    },
    {
      sellerId: "seller-draft-only",
      workspaceId: "workspace-draft",
      professionalName: "Draft Seller",
      bio: "Has a draft offering only.",
      status: "Published",
      basedInCity: "Miami",
      basedInRegion: "FL",
      basedInCountryCode: "US",
      avatarUrl: null,
      specialtyKeys: ["Producer"],
      caribbeanAffiliationCodes: ["HT"],
      workspaceStatus: "Active",
      workspaceHasSellerCapability: true,
      offerings: [DRAFT_OFFERING],
    },
    LONDON_GB_SELLER,
    BUNDLE_ONLY_SELLER,
  ];
  return {
    sellers,
    controlledKeys: {
      // Mirror the canonical seed state so the in-memory repository's
      // getControlledKeys returns the same set the Prisma adapter reads
      // from soundhub_m1_test.
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
    },
  };
}

describe("TalentSearchService", () => {
  test("returns a deterministic best offering for the M1.1 happy path", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "Haitian dancehall single production" });

    assert.equal(response.results.length, 1);
    const [result] = response.results;
    assert.ok(result);
    assert.equal(result.seller.sellerId, "seller-haitian-brooklyn");
    assert.equal(result.bestMatchingOffering.offeringId, "offering-remote-production");
    assert.deepEqual(result.additionalMatchingOfferings, []);
    assert.equal(response.metadata.strategy, "postgres-text-v1");
    assert.equal(response.metadata.totalResults, 1);
    assert.ok(result.matchReason.includes("offering title"));
  });

  test("matches primary category tokens and reports category fields in matchReason", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "production" });
    assert.equal(response.results.length, 1);
    const [result] = response.results;
    assert.ok(result);
    assert.equal(result.bestMatchingOffering.offeringId, "offering-remote-production");
    assert.ok(
      result.matchReason.includes("category key") || result.matchReason.includes("category name"),
    );
  });

  test("relevanceScore is bounded from zero through one and equals matched/queried tokens", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "Haitian dancehall single production" });
    const [result] = response.results;
    assert.ok(result);
    assert.ok(result.relevanceScore >= 0 && result.relevanceScore <= 1);
    assert.ok(Number.isFinite(result.relevanceScore));
    assert.ok(Math.abs(result.relevanceScore - 4 / 4) < 1e-9);
  });

  test("ties on relevanceScore are broken by stable sellerId ascending", async () => {
    const sellers: InMemorySeller[] = [
      {
        sellerId: "seller-z",
        workspaceId: "w-z",
        professionalName: "Z Seller",
        bio: "",
        status: "Published",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          {
            ...REMOTE_PRODUCTION,
            offeringId: "offering-z",
            title: "Dancehall production package",
          },
        ],
      },
      {
        sellerId: "seller-a",
        workspaceId: "w-a",
        professionalName: "A Seller",
        bio: "",
        status: "Published",
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          {
            ...REMOTE_PRODUCTION,
            offeringId: "offering-a",
            title: "Dancehall production package",
          },
        ],
      },
    ];
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        sellers,
        controlledKeys: {
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
        },
      }),
    );
    const response = await service.search({ query: "dancehall production" });
    assert.deepEqual(
      response.results.map((r) => r.seller.sellerId),
      ["seller-a", "seller-z"],
    );
  });

  test("required serviceMode excludes ineligible offerings", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({
      required: { serviceModes: ["Remote"], primaryCategoryKeys: ["music-production"] },
    });
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.seller.sellerId, "seller-haitian-brooklyn");
  });

  test("required primaryCategoryKeys filters out non-matching categories", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({
      required: { primaryCategoryKeys: ["live-performance"] },
    });
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.bestMatchingOffering.primaryCategory.key, "live-performance");
  });

  test("draft and ineligible sellers are excluded", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const draftOnly = await service.search({
      required: { primaryCategoryKeys: ["music-production"] },
    });
    assert.equal(draftOnly.results.length, 1);
    assert.equal(draftOnly.results[0]?.seller.sellerId, "seller-haitian-brooklyn");
  });

  test("required basedIn filter restricts results to sellers in matching country", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ required: { basedIn: { countryCode: "BS" } } });
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.seller.sellerId, "seller-bahamian-live");
  });

  test("required basedIn.city filter restricts results to the matching city", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ required: { basedIn: { city: "Brooklyn" } } });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(sellerIds.includes("seller-haitian-brooklyn"));
    assert.ok(!sellerIds.includes("seller-london-gb"));
  });

  test("required basedIn.region filter restricts results to the matching region", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ required: { basedIn: { region: "NY" } } });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(sellerIds.includes("seller-haitian-brooklyn"));
    assert.ok(!sellerIds.includes("seller-bahamian-live"));
  });

  test("required serviceArea filter restricts results to offerings with matching service area", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ required: { serviceArea: { countryCode: "GB" } } });
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.seller.sellerId, "seller-london-gb");
  });

  test("required serviceArea.city filter restricts results to offerings with matching city", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ required: { serviceArea: { city: "Brooklyn" } } });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(sellerIds.includes("seller-haitian-brooklyn"));
    assert.ok(!sellerIds.includes("seller-london-gb"));
  });

  test("required independentlyPurchasableServiceKeys excludes bundle-only offerings", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    // The bundle-only seller's primary category is "songwriting" with
    // bundleOnly=true. Even if the user lists it in
    // independentlyPurchasableServiceKeys, the service must reject the
    // bundle-only offering.
    const response = await service.search({
      required: { independentlyPurchasableServiceKeys: ["songwriting"] },
    });
    assert.equal(
      response.results.find((r) => r.seller.sellerId === "seller-bundle-only"),
      undefined,
      "bundle-only seller must be excluded from independentlyPurchasableServiceKeys",
    );
  });

  test("required independentlyPurchasableServiceKeys accepts the matching independently-purchasable category", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({
      required: { independentlyPurchasableServiceKeys: ["music-production"] },
    });
    assert.ok(response.results.some((r) => r.seller.sellerId === "seller-haitian-brooklyn"));
    assert.ok(!response.results.some((r) => r.seller.sellerId === "seller-bundle-only"));
  });

  test("required constraints on the same offering compound (AND, not OR)", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({
      required: {
        serviceModes: ["Remote"],
        independentlyPurchasableServiceKeys: ["music-production"],
      },
    });
    assert.ok(response.results.every((r) => r.bestMatchingOffering.serviceMode === "Remote"));
    assert.ok(
      response.results.every(
        (r) => r.bestMatchingOffering.primaryCategory.key === "music-production",
      ),
    );
  });

  test("preferred criteria do not exclude otherwise eligible results", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    // A non-empty preferred.basedIn with a country code that no seller
    // matches must NOT filter the candidate set (preferred is rank-free
    // inclusion, per issue #6 ownership).
    const response = await service.search({
      preferred: { basedIn: { countryCode: "FR" } },
    });
    assert.ok(response.results.length >= 1, "preferred must not exclude");
  });

  test("preferred caribbeanAffiliationCodes does not exclude (supported code)", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({
      preferred: { caribbeanAffiliationCodes: ["JM"] },
    });
    assert.ok(response.results.length >= 1);
  });

  test("unknown supported-Caribbean code in preferred returns INVALID_SEARCH_CRITERIA", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    await assert.rejects(
      () => service.search({ preferred: { caribbeanAffiliationCodes: ["ZZ"] } }),
      (err: unknown) => err instanceof Error && /Unsupported Caribbean/.test(err.message),
    );
  });

  test("unknown service category key in required.primaryCategoryKeys returns INVALID_SEARCH_CRITERIA", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    await assert.rejects(
      () => service.search({ required: { primaryCategoryKeys: ["non-existent-category"] } }),
      (err: unknown) =>
        err instanceof Error && /Unsupported service category key/.test(err.message),
    );
  });

  test("unknown service category key in required.independentlyPurchasableServiceKeys returns INVALID_SEARCH_CRITERIA", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    await assert.rejects(
      () => service.search({ required: { independentlyPurchasableServiceKeys: ["non-existent"] } }),
      (err: unknown) =>
        err instanceof Error && /Unsupported service category key/.test(err.message),
    );
  });

  test("unknown service category key in preferred.categoryKeys returns INVALID_SEARCH_CRITERIA", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    await assert.rejects(
      () => service.search({ preferred: { categoryKeys: ["nope"] } }),
      (err: unknown) =>
        err instanceof Error && /Unsupported service category key/.test(err.message),
    );
  });

  test("unknown service category key in preferred.includedServiceKeys returns INVALID_SEARCH_CRITERIA", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    await assert.rejects(
      () => service.search({ preferred: { includedServiceKeys: ["nope"] } }),
      (err: unknown) =>
        err instanceof Error && /Unsupported service category key/.test(err.message),
    );
  });

  test("unknown specialty key in preferred.specialties returns INVALID_SEARCH_CRITERIA", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    await assert.rejects(
      () => service.search({ preferred: { specialties: ["DJ"] } }),
      (err: unknown) => err instanceof Error && /Unsupported specialty key/.test(err.message),
    );
  });

  test("a service category key listed in the in-memory controlledKeys is accepted (proves the repository is canonical)", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        sellers: [],
        controlledKeys: {
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
            "newly-added-canonical-key",
          ],
          specialtyKeys: ["Producer"],
          pricingUnitKeys: ["track"],
        },
      }),
    );
    // The new key is in the fixture's controlled set; the search
    // should not throw "Unsupported". With no sellers, the result
    // set is empty, but the validation passes.
    const response = await service.search({
      required: { primaryCategoryKeys: ["newly-added-canonical-key"] },
    });
    assert.equal(response.results.length, 0);
    assert.equal(
      response.metadata.appliedRequiredCriteria.primaryCategoryKeys?.[0],
      "newly-added-canonical-key",
    );
  });

  test("a whitespace-only array element is rejected as INVALID_SEARCH_CRITERIA", () => {
    const result = talentSearchRequestV1Schema.safeParse({
      required: { primaryCategoryKeys: ["music-production", " "] },
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(
        result.error.issues.some((issue) =>
          /shorter than 1 non-whitespace character/.test(issue.message),
        ),
      );
    }
  });

  test("a whitespace-only preferred.basedIn.city is rejected at the schema layer", () => {
    const result = talentSearchRequestV1Schema.safeParse({
      required: { basedIn: { city: "Brooklyn" } },
      preferred: { basedIn: { city: "   " } },
    });
    // The required.basedIn.city is meaningful, so the request is usable
    // overall. The preferred.basedIn.city field must still fail the
    // schema layer (whitespace-only is rejected).
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.error.issues.some((issue) => /city/.test(issue.message)));
    }
  });

  test("a whitespace-only required.basedIn.city is rejected at the schema layer", () => {
    const result = talentSearchRequestV1Schema.safeParse({
      required: { basedIn: { city: "   " } },
    });
    assert.equal(result.success, false);
  });

  test("a whitespace-only required.basedIn.region is rejected at the schema layer", () => {
    const result = talentSearchRequestV1Schema.safeParse({
      required: { basedIn: { region: "   " } },
    });
    assert.equal(result.success, false);
  });

  test("a whitespace-only required.basedIn.countryCode is rejected at the schema layer", () => {
    const result = talentSearchRequestV1Schema.safeParse({
      required: { basedIn: { countryCode: "  " } },
    });
    assert.equal(result.success, false);
  });

  test("a required location filter with all whitespace fields is unusable and the request is rejected", () => {
    const result = talentSearchRequestV1Schema.safeParse({
      required: { basedIn: { city: "   ", region: "   ", countryCode: "  " } },
    });
    assert.equal(result.success, false);
  });

  test("a mixed valid+invalid array element is rejected at the schema layer", () => {
    const result = talentSearchRequestV1Schema.safeParse({
      required: { primaryCategoryKeys: ["music-production", "\t"] },
    });
    assert.equal(result.success, false);
  });

  test("a structured request whose only apparent criterion normalizes to empty is rejected", () => {
    // The required primaryCategoryKeys is whitespace-only; after
    // normalization it is empty, the array collapses to undefined, and
    // the request has no usable criteria.
    const result = talentSearchRequestV1Schema.safeParse({
      required: { primaryCategoryKeys: [" "] },
    });
    assert.equal(result.success, false);
  });

  test("a required basedIn whose all fields are whitespace normalizes to no usable criteria", () => {
    const result = talentSearchRequestV1Schema.safeParse({
      required: { basedIn: { city: "   " } },
      preferred: { basedIn: { city: "   " } },
    });
    // The required.basedIn.city is whitespace, so the location filter
    // fails the schema layer; the request has no usable required or
    // preferred criteria, so the usability check fails too.
    assert.equal(result.success, false);
  });

  test("normalized query is exposed in metadata and trimmed/lower-cased", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "  HAITIAN   Dancehall  " });
    assert.equal(response.metadata.normalizedQuery, "haitian dancehall");
  });

  test("a punctuation-only query is rejected as INVALID_SEARCH_CRITERIA at the schema layer", () => {
    const result = talentSearchRequestV1Schema.safeParse({ query: "!!!" });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(
        result.error.issues.some((issue) => /at least one letter or digit/.test(issue.message)),
      );
    }
  });

  test("a whitespace-only query is rejected as INVALID_SEARCH_CRITERIA at the schema layer", () => {
    const result = talentSearchRequestV1Schema.safeParse({ query: "   " });
    assert.equal(result.success, false);
  });

  test("an empty request is rejected as INVALID_SEARCH_CRITERIA at the schema layer", () => {
    const result = talentSearchRequestV1Schema.safeParse({});
    assert.equal(result.success, false);
  });

  test("a request whose only arrays are empty is rejected as INVALID_SEARCH_CRITERIA", () => {
    const result = talentSearchRequestV1Schema.safeParse({
      required: { primaryCategoryKeys: [] },
      preferred: { specialties: [] },
    });
    assert.equal(result.success, false);
  });

  test("a request with an unknown supported-Caribbean code is rejected at the service layer", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    await assert.rejects(
      () =>
        service.search({
          preferred: { caribbeanAffiliationCodes: ["ZZ"] as string[] },
        }),
      (err: unknown) => err instanceof Error && /Unsupported Caribbean/.test(err.message),
    );
  });

  test("applied required and preferred criteria are echoed in metadata", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({
      required: { serviceModes: ["Remote"] },
      preferred: { caribbeanAffiliationCodes: ["HT"] },
    });
    assert.deepEqual(response.metadata.appliedRequiredCriteria, { serviceModes: ["Remote"] });
    assert.deepEqual(response.metadata.appliedPreferredCriteria, {
      caribbeanAffiliationCodes: ["HT"],
    });
  });

  test("matchReason is factual and never names AI or confidence", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "Haitian dancehall single production" });
    const reason = response.results[0]?.matchReason ?? "";
    assert.ok(reason.length > 0);
    assert.doesNotMatch(reason, /ai|artificial|intelligence|confidence|guarantee|quality/i);
  });

  // The public DTO boundary is an allow-list, not a deny-list. Asserting that a
  // handful of guessed private names are `undefined` passes vacuously for any
  // field nobody thought to guess. These tests instead pin the key sets and
  // prove that private data present on the internal candidate cannot reach the
  // response even when the repository supplies it.
  //
  // The invariant is "no key outside the allow-list, and every required key
  // present" rather than one exact key list, because optional fields
  // (avatarUrl, pricing, basedIn.city/region) are legitimately absent for some
  // fixtures. Pinning one exact list would couple these tests to whichever
  // seller happens to rank first and would break when issue #6 changes ranking,
  // without that failure meaning anything leaked.

  const REQUIRED_SELLER_KEYS = [
    "basedIn",
    "bio",
    "caribbeanAffiliationCodes",
    "professionalName",
    "sellerId",
    "specialties",
  ] as const;
  const OPTIONAL_SELLER_KEYS = ["avatarUrl"] as const;

  const REQUIRED_OFFERING_KEYS = [
    "description",
    "genreTags",
    "includedServices",
    "offeringId",
    "primaryCategory",
    "serviceAreas",
    "serviceMode",
    "title",
  ] as const;
  const OPTIONAL_OFFERING_KEYS = ["pricing"] as const;

  function assertKeysWithinAllowList(
    actual: object,
    required: readonly string[],
    optional: readonly string[],
    label: string,
  ): void {
    const keys = Object.keys(actual);
    const allowed = new Set<string>([...required, ...optional]);
    for (const key of keys) {
      assert.ok(allowed.has(key), `${label} exposed non-allow-listed key ${key}`);
    }
    for (const key of required) {
      assert.ok(keys.includes(key), `${label} is missing required public key ${key}`);
    }
  }

  test("every public seller DTO exposes only allow-listed keys", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "Haitian dancehall single production" });
    assert.ok(response.results.length > 0);
    for (const result of response.results) {
      assertKeysWithinAllowList(
        result.seller,
        REQUIRED_SELLER_KEYS,
        OPTIONAL_SELLER_KEYS,
        "seller DTO",
      );
      assertKeysWithinAllowList(
        result.seller.basedIn,
        ["countryCode"],
        ["city", "region"],
        "seller basedIn",
      );
    }
  });

  test("every public offering DTO exposes only allow-listed keys", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "Haitian dancehall single production" });
    assert.ok(response.results.length > 0);
    for (const result of response.results) {
      for (const offering of [result.bestMatchingOffering, ...result.additionalMatchingOfferings]) {
        assertKeysWithinAllowList(
          offering,
          REQUIRED_OFFERING_KEYS,
          OPTIONAL_OFFERING_KEYS,
          "offering DTO",
        );
        for (const area of offering.serviceAreas) {
          assertKeysWithinAllowList(area, ["countryCode"], ["city", "region"], "serviceArea");
        }
      }
    }
  });

  test("account, membership, wallet, embedding, storage, and private timestamp fields cannot leak", async () => {
    // Poison the internal candidate with every private field class named by the
    // contract's privacy boundary. The repository type does not declare these,
    // so the cast models a persistence layer that over-selects.
    const fixture = buildFixture();
    const poisoned = {
      ...fixture.sellers[0]!,
      email: "private@example.com",
      passwordHash: "hashed-secret",
      ownerUserId: "user-private",
      memberships: [{ userId: "user-private", role: "Owner" }],
      walletAddress: "0xdeadbeef",
      walletAuthorization: { challenge: "nonce" },
      embedding: [0.1, 0.2, 0.3],
      vectorMetadata: { namespace: "sellers" },
      s3Key: "private/bucket/key.wav",
      storageLocation: "s3://private/key",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-02T00:00:00.000Z"),
      offerings: fixture.sellers[0]!.offerings.map((offering) => ({
        ...offering,
        embedding: [0.4, 0.5],
        s3Key: "private/offering.wav",
        createdAt: new Date("2020-01-03T00:00:00.000Z"),
        updatedAt: new Date("2020-01-04T00:00:00.000Z"),
        internalCostMinor: 1234,
      })),
    } as unknown as InMemorySeller;

    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        ...fixture,
        sellers: [poisoned, ...fixture.sellers.slice(1)],
      }),
    );
    const response = await service.search({ query: "Haitian dancehall single production" });
    assert.ok(response.results.length > 0);

    // Serializing the whole response is the real leak surface: it catches a
    // private value nested anywhere, not just at the top level.
    const serialized = JSON.stringify(response);
    for (const secret of [
      "private@example.com",
      "hashed-secret",
      "user-private",
      "0xdeadbeef",
      "nonce",
      "vectorMetadata",
      "private/bucket/key.wav",
      "s3://private/key",
      "private/offering.wav",
      "internalCostMinor",
      "2020-01-01",
      "2020-01-03",
    ]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `private value ${secret} leaked into the public response`,
      );
    }

    // Key-level proof for the field classes the contract names explicitly.
    const seller = response.results[0]!.seller as unknown as Record<string, unknown>;
    const offering = response.results[0]!.bestMatchingOffering as unknown as Record<
      string,
      unknown
    >;
    for (const key of [
      "email",
      "passwordHash",
      "ownerUserId",
      "workspaceId",
      "memberships",
      "walletAddress",
      "walletAuthorization",
      "embedding",
      "vectorMetadata",
      "s3Key",
      "storageLocation",
      "createdAt",
      "updatedAt",
      "status",
    ]) {
      assert.equal(key in seller, false, `seller DTO exposed private key ${key}`);
      assert.equal(key in offering, false, `offering DTO exposed private key ${key}`);
    }
  });

  test("empty results return 200 with empty array and do not relax constraints", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "obscure-thing-with-no-match" });
    assert.equal(response.results.length, 0);
    assert.equal(response.metadata.totalResults, 0);
  });

  test("results are stable across identical runs", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const a = await service.search({ query: "Haitian dancehall single production" });
    const b = await service.search({ query: "Haitian dancehall single production" });
    assert.equal(a.metadata.totalResults, b.metadata.totalResults);
    assert.equal(a.metadata.normalizedQuery, b.metadata.normalizedQuery);
    assert.equal(a.metadata.strategy, b.metadata.strategy);
    assert.deepEqual(
      a.results.map((r) => ({
        sellerId: r.seller.sellerId,
        offeringId: r.bestMatchingOffering.offeringId,
        score: r.relevanceScore,
        reason: r.matchReason,
      })),
      b.results.map((r) => ({
        sellerId: r.seller.sellerId,
        offeringId: r.bestMatchingOffering.offeringId,
        score: r.relevanceScore,
        reason: r.matchReason,
      })),
    );
  });

  test("offering with no token overlap is excluded", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "obscure-thing" });
    assert.equal(response.results.length, 0);
  });

  // M1.2 regression: `avatarUrl` is an approved optional field of the public
  // seller contract, and the schema requires `z.string().url()` (an absolute
  // URL). The deterministic seed stores the canonical non-null avatar
  // fixture as an absolute URL composed from PUBLIC_FIXTURE_ORIGIN plus the
  // path under `apps/web/public/fixtures/...`. This test pins the public
  // DTO boundary end to end: a non-null absolute avatar URL passes through
  // the service and the entire response validates against the strict
  // public schema.
  test("a non-null absolute avatarUrl survives the public DTO mapping and validates against the schema", async () => {
    const absoluteAvatarUrl = "http://localhost:3000/fixtures/sellers/keisha-williams/avatar.svg";
    const keishaOffering: InMemoryOffering = {
      offeringId: "offering-keisha-topline",
      title: "Afrobeats and R&B topline writing — remote",
      description: "Original topline writing for a single.",
      status: "Active",
      serviceMode: "Remote",
      primaryCategory: { key: "songwriting", name: "Songwriting", bundleOnly: false },
      includedServices: [],
      genreTags: ["R&B", "Afrobeats", "Pop"],
      serviceAreas: [{ city: null, region: null, countryCode: "CA" }],
      pricing: {
        kind: "Fixed",
        amountMinor: 120000,
        currency: "USD",
        unitKey: "track",
      },
    };
    const keisha: InMemorySeller = {
      sellerId: "seller-keisha-toronto",
      workspaceId: "workspace-keisha",
      professionalName: "Keisha Williams",
      bio: "Toronto-based Jamaican songwriter.",
      status: "Published",
      basedInCity: "Toronto",
      basedInRegion: "ON",
      basedInCountryCode: "CA",
      avatarUrl: absoluteAvatarUrl,
      specialtyKeys: ["Songwriter", "Artist"],
      caribbeanAffiliationCodes: ["JM"],
      workspaceStatus: "Active",
      workspaceHasSellerCapability: true,
      offerings: [keishaOffering],
    };
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        sellers: [keisha],
        controlledKeys: {
          serviceCategoryKeys: ["songwriting"],
          specialtyKeys: ["Songwriter", "Artist"],
          pricingUnitKeys: ["track"],
        },
      }),
    );

    const response = await service.search({ query: "Afrobeats topline writing" });
    assert.equal(response.results.length, 1);
    const [result] = response.results;
    assert.ok(result);
    assert.equal(result.seller.avatarUrl, absoluteAvatarUrl);

    // The whole response (including the non-null avatar) must parse
    // against the strict public schema. Without an absolute URL, this
    // safeParse would fail with a `z.string().url()` issue and the
    // route would return SEARCH_FAILED 500.
    const parsed = talentSearchResponseV1Schema.safeParse(response);
    assert.equal(
      parsed.success,
      true,
      `public response failed schema validation: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`,
    );
    if (parsed.success) {
      const seller = parsed.data.results[0]?.seller;
      assert.ok(seller);
      // Schema is `.strict()`, so the avatarUrl must round-trip exactly.
      assert.equal(seller.avatarUrl, absoluteAvatarUrl);
    }

    // Independent URL parse check: the seeded value is an absolute URL,
    // not a relative path like `/fixtures/sellers/...`.
    const url = new URL(absoluteAvatarUrl);
    assert.equal(url.protocol, "http:");
    assert.equal(url.pathname, "/fixtures/sellers/keisha-williams/avatar.svg");
  });

  // M1.2 negative regression: if a seller ever leaks a relative URL
  // through to the public DTO, the strict `z.string().url()` schema must
  // reject it. Pinning this contract prevents the canonical non-null
  // avatar fixture from silently regressing back to a relative path.
  test("a relative avatarUrl is rejected by the strict public schema", () => {
    const relativeAvatar = "/fixtures/sellers/keisha-williams/avatar.svg";
    const parsed = talentSearchResponseV1Schema.safeParse({
      results: [
        {
          seller: {
            sellerId: "seller-x",
            professionalName: "Test Seller",
            specialties: ["Songwriter"],
            bio: "",
            basedIn: { countryCode: "CA" },
            caribbeanAffiliationCodes: ["JM"],
            avatarUrl: relativeAvatar,
          },
          bestMatchingOffering: {
            offeringId: "of-x",
            title: "X",
            description: "",
            primaryCategory: { key: "songwriting", name: "Songwriting" },
            includedServices: [],
            genreTags: [],
            serviceMode: "Remote",
            serviceAreas: [{ countryCode: "CA" }],
          },
          additionalMatchingOfferings: [],
          relevanceScore: 1,
          matchReason: "matched",
        },
      ],
      metadata: {
        totalResults: 1,
        processingTimeMs: 0,
        strategy: "postgres-text-v1",
        appliedRequiredCriteria: {},
        appliedPreferredCriteria: {},
      },
    });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      assert.ok(
        parsed.error.issues.some((issue) => issue.path.join(".") === "results.0.seller.avatarUrl"),
        `expected avatarUrl rejection, got ${JSON.stringify(parsed.error.issues)}`,
      );
    }
  });
});

// M1.3 negative eligibility fixtures (service layer).
//
// The in-memory adapter mirrors the Prisma repository's eligibility
// rules. These tests exercise every excluded state at the service
// boundary so the rule chain (Workspace.status → Workspace capability
// → SellerProfile.status → ServiceOffering.status) is asserted
// deterministically without touching the database. The fixture
// itself is shared with the route-layer tests via
// `buildNegativeEligibilityFixture` so the two layers can never
// drift on the excluded-state coverage.
import { buildNegativeEligibilityFixture } from "../test-helpers/negative-eligibility-fixture.js";

describe("TalentSearchService M1.3 negative eligibility fixtures", () => {
  test("a Draft SellerProfile is excluded from search results", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(!sellerIds.includes("neg-draft-profile"));
  });

  test("a Suspended SellerProfile is excluded from search results", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(!sellerIds.includes("neg-suspended-profile"));
  });

  test("a SellerProfile under a Suspended Workspace is excluded from search results", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(!sellerIds.includes("neg-suspended-workspace"));
  });

  test("a SellerProfile whose Workspace lacks the Seller capability is excluded", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(!sellerIds.includes("neg-buyer-only"));
  });

  test("a seller whose only offerings are Draft is excluded", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(!sellerIds.includes("neg-draft-offerings"));
  });

  test("a seller whose only offerings are Paused is excluded", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(!sellerIds.includes("neg-paused-offerings"));
  });

  test("a seller whose only offerings are Archived is excluded", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(!sellerIds.includes("neg-archived-offerings"));
  });

  test("a mixed Active+Paused seller surfaces only the Active offering (Paused is hidden, seller stays discoverable)", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    const mixed = response.results.find((r) => r.seller.sellerId === "neg-mixed-paused");
    assert.ok(mixed, "mixed Active+Paused seller must remain discoverable via the Active offering");
    assert.equal(mixed.bestMatchingOffering.offeringId, "neg-off-remote");
    assert.deepEqual(mixed.additionalMatchingOfferings, []);
  });

  test("a mixed Active+Archived seller surfaces only the Active offering (Archived is hidden, seller stays discoverable)", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    const mixed = response.results.find((r) => r.seller.sellerId === "neg-mixed-archived");
    assert.ok(
      mixed,
      "mixed Active+Archived seller must remain discoverable via the Active offering",
    );
    assert.equal(mixed.bestMatchingOffering.offeringId, "neg-off-remote");
    assert.deepEqual(mixed.additionalMatchingOfferings, []);
  });

  test("the full negative fixture set never produces a Paused or Archived offering in the public response", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({ query: "Hidden Caribbean production" });
    // JSON-serialize the whole response and assert no Paused/Archived
    // status string appears in any result.
    const serialized = JSON.stringify(response);
    assert.equal(
      serialized.includes('"status":"Paused"'),
      false,
      "no Paused offering may leak into the public response",
    );
    assert.equal(
      serialized.includes('"status":"Archived"'),
      false,
      "no Archived offering may leak into the public response",
    );
  });

  test("the structured-only query path also excludes every negative fixture", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    // No query text: eligibility must still hold via the repository.
    const response = await service.search({
      required: { primaryCategoryKeys: ["music-production"] },
    });
    const surfacedNegativeIds = response.results
      .map((r) => r.seller.sellerId)
      .filter((id) => id.startsWith("neg-"));
    // Only the two mixed-lifecycle sellers may surface.
    assert.deepEqual(surfacedNegativeIds.sort(), ["neg-mixed-archived", "neg-mixed-paused"]);
  });

  test("Paused and Archived are distinguishable by status on the in-memory candidate contract", async () => {
    // The repository's internal candidate contract exposes the
    // status so downstream layers (and tests) can verify the
    // distinction. Search hides both, but Paused is recoverable
    // while Archived is terminal; the data model preserves the
    // difference.
    const repo = new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture());
    const candidates = await repo.search({
      serviceModes: [],
      primaryCategoryKeys: ["music-production"],
      independentlyPurchasableServiceKeys: [],
      basedIn: null,
      serviceArea: null,
    });
    const pausedOffering = candidates
      .flatMap((seller) => seller.offerings)
      .find((offering) => offering.offeringId === "neg-off-mixed-paused-paused");
    const archivedOffering = candidates
      .flatMap((seller) => seller.offerings)
      .find((offering) => offering.offeringId === "neg-off-mixed-archived-archived");
    assert.equal(pausedOffering, undefined, "Paused offering must not surface as a candidate");
    assert.equal(archivedOffering, undefined, "Archived offering must not surface as a candidate");
    // But the in-memory seller still carries the offering row with its
    // status preserved: search hides it; the contract does not collapse
    // Paused into Archived.
    const pausedSeller = (
      await repo.search({
        serviceModes: [],
        primaryCategoryKeys: [],
        independentlyPurchasableServiceKeys: [],
        basedIn: null,
        serviceArea: null,
      })
    ).find((s) => s.sellerId === "neg-paused-offerings");
    assert.equal(
      pausedSeller,
      undefined,
      "the seller is itself excluded; the Paused status is preserved on the underlying row, not on a hidden candidate",
    );
  });

  test("a Draft-profile seller is excluded even when the offering matches every required filter", async () => {
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository(buildNegativeEligibilityFixture()),
    );
    const response = await service.search({
      required: {
        primaryCategoryKeys: ["music-production"],
        serviceModes: ["Remote"],
      },
    });
    const sellerIds = response.results.map((r) => r.seller.sellerId);
    assert.ok(!sellerIds.includes("neg-draft-profile"));
  });
});

// M1.5 preference ranking and grouping.
//
// Per the v1 contract:
//   - Preferences affect ordering without excluding candidates.
//   - Each seller appears once with a stable best matching offering and at
//     most two additional matches.
//   - Bundle-only matches are labeled accurately and never presented as
//     standalone purchases.
//   - Identical canonical data and normalized criteria produce identical
//     ordering, matchReason, and bounded relevanceScore.
//
// The fixtures below extend the in-memory adapter with sellers that have
// multiple eligible offerings, sellers whose primary category is
// bundle-only, sellers whose offering carries bundle-only IncludedServices,
// and a controlled-key set that adds them to the canonical surface so the
// service can validate any new stable keys.
describe("TalentSearchService M1.5 preference ranking and grouping", () => {
  const M15_CONTROLLED_KEYS = {
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
      "remote-coaching",
      "remote-companion",
      "remote-studio-time",
    ],
    specialtyKeys: ["Artist", "Producer", "Musician", "Songwriter", "SoundEngineer"],
    pricingUnitKeys: ["hour", "track", "project", "session", "event", "day"],
  };

  const PRODUCTION_OFFERING_A: InMemoryOffering = {
    offeringId: "m15-offering-a",
    title: "Dancehall single production",
    description: "Dancehall single production.",
    status: "Active",
    serviceMode: "Remote",
    primaryCategory: { key: "music-production", name: "Music Production", bundleOnly: false },
    includedServices: [],
    genreTags: ["Dancehall", "Hip-Hop"],
    serviceAreas: [{ city: null, region: null, countryCode: "US" }],
    pricing: {
      kind: "StartingAt",
      amountMinor: 50000,
      currency: "USD",
      unitKey: "track",
    },
  };

  const VOCAL_OFFERING_B: InMemoryOffering = {
    offeringId: "m15-offering-b",
    title: "Lead dancehall vocals",
    description: "Lead vocals for dancehall tracks.",
    status: "Active",
    serviceMode: "Remote",
    primaryCategory: { key: "session-vocals", name: "Session Vocals", bundleOnly: false },
    includedServices: [],
    genreTags: ["Dancehall", "Soca"],
    serviceAreas: [{ city: null, region: null, countryCode: "US" }],
    pricing: {
      kind: "Fixed",
      amountMinor: 35000,
      currency: "USD",
      unitKey: "session",
    },
  };

  const CUSTOM_COMPOSITION_C: InMemoryOffering = {
    offeringId: "m15-offering-c",
    title: "Dancehall composition for picture",
    description: "Original dancehall composition to picture.",
    status: "Active",
    serviceMode: "Remote",
    primaryCategory: {
      key: "custom-composition",
      name: "Custom Composition",
      bundleOnly: false,
    },
    includedServices: [],
    genreTags: ["Score", "Cinematic"],
    serviceAreas: [{ city: null, region: null, countryCode: "US" }],
    pricing: {
      kind: "StartingAt",
      amountMinor: 200000,
      currency: "USD",
      unitKey: "project",
    },
  };

  const BUNDLE_ONLY_PRIMARY_OFFERING: InMemoryOffering = {
    offeringId: "m15-bundle-only-primary",
    title: "Hidden dancehall bundle-only offering",
    description:
      "Primary category is bundleOnly; must never be presented as a standalone purchase.",
    status: "Active",
    serviceMode: "Remote",
    primaryCategory: {
      key: "remote-companion",
      name: "Remote Companion",
      bundleOnly: true,
    },
    includedServices: [],
    genreTags: ["Dancehall"],
    serviceAreas: [{ city: null, region: null, countryCode: "JM" }],
    pricing: null,
  };

  const OFFERING_WITH_BUNDLE_COMPONENT: InMemoryOffering = {
    offeringId: "m15-offering-with-bundle",
    title: "Dancehall production with bundled coaching",
    description: "Standalone production offering that includes a coaching component.",
    status: "Active",
    serviceMode: "Remote",
    primaryCategory: { key: "music-production", name: "Music Production", bundleOnly: false },
    includedServices: [
      {
        key: "remote-coaching",
        name: "Remote Coaching",
        purchaseMode: "BundleOnly",
      },
    ],
    genreTags: ["Dancehall"],
    serviceAreas: [{ city: null, region: null, countryCode: "JM" }],
    pricing: {
      kind: "StartingAt",
      amountMinor: 80000,
      currency: "USD",
      unitKey: "track",
    },
  };

  const OFFERING_WITH_MULTIPLE_BUNDLE_COMPONENTS: InMemoryOffering = {
    offeringId: "m15-offering-with-bundle-set",
    title: "Dancehall composition with bundled coaching and studio time",
    description: "Standalone composition offering that bundles coaching and studio time.",
    status: "Active",
    serviceMode: "Hybrid",
    primaryCategory: {
      key: "custom-composition",
      name: "Custom Composition",
      bundleOnly: false,
    },
    includedServices: [
      {
        key: "remote-coaching",
        name: "Remote Coaching",
        purchaseMode: "BundleOnly",
      },
      {
        key: "remote-studio-time",
        name: "Remote Studio Time",
        purchaseMode: "BundleOnly",
      },
    ],
    genreTags: ["Score"],
    serviceAreas: [{ city: null, region: null, countryCode: "JM" }],
    pricing: null,
  };

  const MULTI_OFFERING_SELLER_HT: InMemorySeller = {
    sellerId: "m15-seller-multi-ht",
    workspaceId: "ws-m15-multi-ht",
    professionalName: "Marc M15 Multi HT",
    bio: "Brooklyn-based Haitian producer.",
    status: "Published",
    basedInCity: "Brooklyn",
    basedInRegion: "NY",
    basedInCountryCode: "US",
    avatarUrl: null,
    specialtyKeys: ["Producer", "Artist"],
    caribbeanAffiliationCodes: ["HT", "JM"],
    workspaceStatus: "Active",
    workspaceHasSellerCapability: true,
    offerings: [PRODUCTION_OFFERING_A, VOCAL_OFFERING_B, CUSTOM_COMPOSITION_C],
  };

  const SINGLE_OFFERING_SELLER_JM: InMemorySeller = {
    sellerId: "m15-seller-single-jm",
    workspaceId: "ws-m15-single-jm",
    professionalName: "Marc M15 Single JM",
    bio: "Brooklyn-based Jamaican songwriter.",
    status: "Published",
    basedInCity: "Brooklyn",
    basedInRegion: "NY",
    basedInCountryCode: "US",
    avatarUrl: null,
    specialtyKeys: ["Songwriter"],
    caribbeanAffiliationCodes: ["JM"],
    workspaceStatus: "Active",
    workspaceHasSellerCapability: true,
    offerings: [OFFERING_WITH_BUNDLE_COMPONENT],
  };

  const SINGLE_OFFERING_SELLER_HT_MIRROR: InMemorySeller = {
    sellerId: "m15-seller-mirror-ht",
    workspaceId: "ws-m15-mirror-ht",
    professionalName: "Marc M15 Mirror HT",
    bio: "Brooklyn-based Haitian producer, mirror seller.",
    status: "Published",
    basedInCity: "Brooklyn",
    basedInRegion: "NY",
    basedInCountryCode: "US",
    avatarUrl: null,
    specialtyKeys: ["Producer"],
    caribbeanAffiliationCodes: ["HT"],
    workspaceStatus: "Active",
    workspaceHasSellerCapability: true,
    offerings: [PRODUCTION_OFFERING_A],
  };

  const BUNDLE_ONLY_PRIMARY_SELLER: InMemorySeller = {
    sellerId: "m15-seller-bundle-only-primary",
    workspaceId: "ws-m15-bundle-only-primary",
    professionalName: "Marc M15 Bundle Only Primary",
    bio: "Seller whose only offering is bundle-only primary; must not surface as standalone.",
    status: "Published",
    basedInCity: "Brooklyn",
    basedInRegion: "NY",
    basedInCountryCode: "US",
    avatarUrl: null,
    specialtyKeys: ["Producer"],
    caribbeanAffiliationCodes: ["JM"],
    workspaceStatus: "Active",
    workspaceHasSellerCapability: true,
    offerings: [BUNDLE_ONLY_PRIMARY_OFFERING],
  };

  const MULTI_BUNDLE_SELLER: InMemorySeller = {
    sellerId: "m15-seller-multi-bundle",
    workspaceId: "ws-m15-multi-bundle",
    professionalName: "Marc M15 Multi Bundle",
    bio: "Brooklyn-based composer with bundled offerings.",
    status: "Published",
    basedInCity: "Brooklyn",
    basedInRegion: "NY",
    basedInCountryCode: "US",
    avatarUrl: null,
    specialtyKeys: ["Songwriter"],
    caribbeanAffiliationCodes: ["JM"],
    workspaceStatus: "Active",
    workspaceHasSellerCapability: true,
    offerings: [OFFERING_WITH_MULTIPLE_BUNDLE_COMPONENTS],
  };

  function buildM15Fixture(): InMemoryFixture {
    return {
      sellers: [
        MULTI_OFFERING_SELLER_HT,
        SINGLE_OFFERING_SELLER_JM,
        SINGLE_OFFERING_SELLER_HT_MIRROR,
        BUNDLE_ONLY_PRIMARY_SELLER,
        MULTI_BUNDLE_SELLER,
      ],
      controlledKeys: M15_CONTROLLED_KEYS,
    };
  }

  test("multi-offering seller surfaces once with stable best offering and at most two additional matches", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    // Two-token query; production offering matches both via title
    // ("Dancehall single production"), the others match only "dancehall".
    const response = await service.search({ query: "dancehall production" });
    const sellerResults = response.results.filter(
      (r) => r.seller.sellerId === "m15-seller-multi-ht",
    );
    assert.equal(
      sellerResults.length,
      1,
      "each seller must appear at most once in the result list",
    );
    const [result] = sellerResults;
    assert.ok(result);
    assert.equal(result.bestMatchingOffering.offeringId, "m15-offering-a");
    // Both remaining offerings tie on textScore; tied offerings are
    // sorted by offeringId asc, so vocal first then composition.
    assert.deepEqual(
      result.additionalMatchingOfferings.map((o) => o.offeringId),
      ["m15-offering-b", "m15-offering-c"],
    );
    assert.ok(result.additionalMatchingOfferings.length <= 2);
  });

  test("a seller with five eligible offerings never surfaces more than three (one best plus at most two additional)", async () => {
    const sellers: InMemorySeller[] = [
      {
        ...MULTI_OFFERING_SELLER_HT,
        offerings: [
          { ...PRODUCTION_OFFERING_A, offeringId: "m15-q-1" },
          { ...PRODUCTION_OFFERING_A, offeringId: "m15-q-2" },
          { ...PRODUCTION_OFFERING_A, offeringId: "m15-q-3" },
          { ...PRODUCTION_OFFERING_A, offeringId: "m15-q-4" },
          { ...PRODUCTION_OFFERING_A, offeringId: "m15-q-5" },
        ],
      },
    ];
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        sellers,
        controlledKeys: M15_CONTROLLED_KEYS,
      }),
    );
    const response = await service.search({ query: "dancehall production" });
    const [result] = response.results;
    assert.ok(result);
    assert.equal(
      result.additionalMatchingOfferings.length,
      2,
      "a seller must never expose more than two additional offerings",
    );
    assert.ok(1 + result.additionalMatchingOfferings.length <= 3);
  });

  test("additional offerings are stably ordered by offeringId when scores tie within a seller", async () => {
    // Three identical offerings re-keyed to control ordering. Score is
    // tied (full-text), so the within-seller order is offeringId asc.
    const sellers: InMemorySeller[] = [
      {
        ...MULTI_OFFERING_SELLER_HT,
        offerings: [
          { ...PRODUCTION_OFFERING_A, offeringId: "m15-det-c" },
          { ...PRODUCTION_OFFERING_A, offeringId: "m15-det-a" },
          { ...PRODUCTION_OFFERING_A, offeringId: "m15-det-b" },
        ],
      },
    ];
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        sellers,
        controlledKeys: M15_CONTROLLED_KEYS,
      }),
    );
    const response = await service.search({ query: "dancehall" });
    const [result] = response.results;
    assert.ok(result);
    assert.deepEqual(
      [
        result.bestMatchingOffering.offeringId,
        ...result.additionalMatchingOfferings.map((o) => o.offeringId),
      ],
      ["m15-det-a", "m15-det-b", "m15-det-c"],
    );
  });

  test("a bundle-only primary-category offering is never selected as bestMatchingOffering or as additionalMatchingOfferings", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({ query: "dancehall" });
    const bundleOnlyResult = response.results.find(
      (r) => r.seller.sellerId === "m15-seller-bundle-only-primary",
    );
    assert.equal(
      bundleOnlyResult,
      undefined,
      "bundle-only primary-category offerings must never be presented as standalone purchases",
    );
    const serialized = JSON.stringify(response);
    assert.equal(
      serialized.includes("m15-bundle-only-primary"),
      false,
      "bundle-only primary-category offeringId must not appear in the response",
    );
    assert.equal(
      serialized.includes("Hidden dancehall bundle-only offering"),
      false,
      "bundle-only primary-category title must not appear in the response",
    );
  });

  test("bundle-only IncludedServices are labeled as BundleOnly on every presenting offering and never as standalone", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({ query: "dancehall" });
    for (const result of response.results) {
      for (const offering of [result.bestMatchingOffering, ...result.additionalMatchingOfferings]) {
        for (const included of offering.includedServices) {
          assert.equal(
            included.purchaseMode,
            "BundleOnly",
            `includedService key=${included.key} must be labeled as BundleOnly`,
          );
          assert.equal(typeof included.key, "string");
        }
      }
    }
    for (const result of response.results) {
      const observedOfferingIds = new Set<string>([
        result.bestMatchingOffering.offeringId,
        ...result.additionalMatchingOfferings.map((o) => o.offeringId),
      ]);
      assert.equal(
        observedOfferingIds.has(BUNDLE_ONLY_PRIMARY_OFFERING.offeringId),
        false,
        "bundle-only primary-category offering must never appear as bestMatchingOffering/additionalMatchingOffering",
      );
    }
  });

  test("preferences affect ordering without excluding otherwise eligible candidates", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({
      query: "dancehall production",
      preferred: { caribbeanAffiliationCodes: ["JM"] },
    });
    const sellerIds = new Set(response.results.map((r) => r.seller.sellerId));
    assert.ok(sellerIds.has("m15-seller-multi-ht"));
    assert.ok(sellerIds.has("m15-seller-mirror-ht"));
    assert.ok(sellerIds.has("m15-seller-single-jm"));
    assert.ok(sellerIds.has("m15-seller-multi-bundle"));
  });

  test("JM-preferred ordering: a JM-affiliated seller ranks above an HT-only mirror under partial text coverage", async () => {
    // Two mirror sellers carry identical offerings; the JM-preferred
    // seller has the JM affiliation that the buyer's preference matches.
    // The two-token query only overlaps with one token in the title
    // ("dancehall"), leaving text coverage partial so the JM-preference
    // lift can outrank the HT-only seller without the [0,1] bound
    // collapsing the difference at full coverage.
    const sellers: InMemorySeller[] = [
      {
        sellerId: "m15-pref-z-jm",
        workspaceId: "ws-pref-z-jm",
        professionalName: "Z JM",
        bio: "",
        status: "Published",
        basedInCity: "Brooklyn",
        basedInRegion: "NY",
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Songwriter"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          {
            ...PRODUCTION_OFFERING_A,
            offeringId: "m15-pref-z-jm-off",
            title: "Dancehall single production",
          },
        ],
      },
      {
        sellerId: "m15-pref-a-ht",
        workspaceId: "ws-pref-a-ht",
        professionalName: "A HT",
        bio: "",
        status: "Published",
        basedInCity: "Brooklyn",
        basedInRegion: "NY",
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["HT"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          {
            ...PRODUCTION_OFFERING_A,
            offeringId: "m15-pref-a-ht-off",
            title: "Dancehall single production",
          },
        ],
      },
    ];
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        sellers,
        controlledKeys: M15_CONTROLLED_KEYS,
      }),
    );
    // Two-token query: "dancehall" matches the title (1/2), "vocals"
    // does not. textScore = 0.5 for both sellers.
    const query = "dancehall vocals";
    // Without prefs, "m15-pref-a-ht" sorts first by sellerId-tiebreak
    // (both score 0.5).
    const noPref = await service.search({ query });
    assert.equal(noPref.results[0]?.seller.sellerId, "m15-pref-a-ht");
    assert.equal(noPref.results[1]?.seller.sellerId, "m15-pref-z-jm");
    // With JM preference, the JM-affiliated seller MUST outrank the
    // HT-only seller — preferences affect ordering deterministically.
    const jmPref = await service.search({
      query,
      preferred: { caribbeanAffiliationCodes: ["JM"] },
    });
    assert.equal(jmPref.results[0]?.seller.sellerId, "m15-pref-z-jm");
    assert.equal(jmPref.results[1]?.seller.sellerId, "m15-pref-a-ht");
    // Relevance scores remain finite and bounded for every result.
    for (const result of jmPref.results) {
      assert.ok(
        Number.isFinite(result.relevanceScore) &&
          result.relevanceScore >= 0 &&
          result.relevanceScore <= 1,
      );
    }
  });

  test("preferred Caribbean affiliation is rendered factually in matchReason without AI or confidence claims", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({
      query: "dancehall",
      preferred: { caribbeanAffiliationCodes: ["JM"] },
    });
    const jm = response.results.find((r) => r.seller.sellerId === "m15-seller-single-jm");
    assert.ok(jm);
    assert.ok(
      jm.matchReason.includes("preferred Caribbean affiliation: JM"),
      `matchReason must include the factual preference label, got: ${jm.matchReason}`,
    );
    assert.doesNotMatch(jm.matchReason, /ai|artificial|intelligence|confidence|guarantee|quality/i);
  });

  test("preferred category, genre, and based-in labels follow canonical order across identical requests", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const a = await service.search({
      query: "dancehall",
      preferred: {
        categoryKeys: ["music-production"],
        genreTags: ["Dancehall"],
        basedIn: { city: "Brooklyn" },
      },
    });
    const b = await service.search({
      query: "dancehall",
      preferred: {
        genreTags: ["Dancehall"],
        basedIn: { city: "Brooklyn" },
        categoryKeys: ["music-production"],
      },
    });
    assert.equal(a.results.length, b.results.length);
    for (let i = 0; i < a.results.length; i += 1) {
      assert.equal(a.results[i]!.matchReason, b.results[i]!.matchReason);
      assert.equal(a.results[i]!.relevanceScore, b.results[i]!.relevanceScore);
      assert.equal(a.results[i]!.seller.sellerId, b.results[i]!.seller.sellerId);
    }
  });

  test("identical canonical data and normalized criteria produce identical ordering, matchReason, and bounded relevanceScore", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const a = await service.search({
      query: "  Dancehall PRODUCTION  ",
      preferred: {
        genreTags: ["Dancehall"],
        caribbeanAffiliationCodes: ["JM"],
      },
    });
    const b = await service.search({
      query: "dancehall production",
      preferred: {
        genreTags: ["Dancehall"],
        caribbeanAffiliationCodes: ["JM"],
      },
    });
    assert.equal(a.results.length, b.results.length);
    for (const result of a.results) {
      assert.ok(result.relevanceScore >= 0 && result.relevanceScore <= 1);
      assert.ok(Number.isFinite(result.relevanceScore));
    }
    assert.deepEqual(
      a.results.map((r) => ({
        sellerId: r.seller.sellerId,
        score: r.relevanceScore,
        reason: r.matchReason,
      })),
      b.results.map((r) => ({
        sellerId: r.seller.sellerId,
        score: r.relevanceScore,
        reason: r.matchReason,
      })),
    );
  });

  test("relevanceScore of 1.0 is preserved when all tokens match and no preferences are supplied (M1.1 invariant)", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({ query: "Dancehall" });
    const result = response.results.find((r) => r.seller.sellerId === "m15-seller-multi-ht");
    assert.ok(result);
    assert.ok(Math.abs(result.relevanceScore - 1) < 1e-9);
  });

  test("every result in the M1.5 fixture has at most two additional matching offerings", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({ query: "dancehall" });
    for (const result of response.results) {
      assert.ok(result.additionalMatchingOfferings.length <= 2);
    }
  });

  test("the contract's 10-result cap is honored by the service", async () => {
    // Build a fixture with 12 distinct eligible sellers. With at most
    // two additional per seller and at most ten sellers in the result
    // list, the wire-format ordering must cap at ten.
    const sellers: InMemorySeller[] = Array.from({ length: 12 }).map((_, i) => ({
      sellerId: `m15-cap-seller-${i.toString().padStart(2, "0")}`,
      workspaceId: `ws-m15-cap-${i}`,
      professionalName: `M15 Cap Seller ${i}`,
      bio: "",
      status: "Published",
      basedInCity: "Brooklyn",
      basedInRegion: "NY",
      basedInCountryCode: "US",
      avatarUrl: null,
      specialtyKeys: ["Producer"],
      caribbeanAffiliationCodes: ["JM"],
      workspaceStatus: "Active",
      workspaceHasSellerCapability: true,
      offerings: [
        {
          ...PRODUCTION_OFFERING_A,
          offeringId: `m15-cap-off-${i}`,
        },
      ],
    }));
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({ sellers, controlledKeys: M15_CONTROLLED_KEYS }),
    );
    const response = await service.search({ query: "dancehall" });
    assert.equal(response.results.length, 10, "the contract caps results at ten sellers");
    assert.equal(response.metadata.totalResults, 10);
  });

  test("a seller whose only offering has a bundle-only primary category is dropped from the result list (no standalone purchase is mis-presented)", async () => {
    // Belt-and-braces. The acceptance criterion 3 wording only forbids
    // presenting bundle-only as a standalone purchase, but the contract
    // also requires every result to expose a bestMatchingOffering. A
    // seller without a non-bundle-only standalone offering therefore
    // cannot satisfy the result shape and is intentionally omitted
    // from the result list rather than surfaced with an empty slot.
    const onlyBundleOnly: InMemorySeller = {
      sellerId: "m15-only-bundle-only-primary",
      workspaceId: "ws-m15-only-bundle-only-primary",
      professionalName: "M15 Only Bundle Only Primary",
      bio: "",
      status: "Published",
      basedInCity: "Brooklyn",
      basedInRegion: "NY",
      basedInCountryCode: "US",
      avatarUrl: null,
      specialtyKeys: ["Producer"],
      caribbeanAffiliationCodes: ["JM"],
      workspaceStatus: "Active",
      workspaceHasSellerCapability: true,
      offerings: [BUNDLE_ONLY_PRIMARY_OFFERING],
    };
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        sellers: [onlyBundleOnly],
        controlledKeys: M15_CONTROLLED_KEYS,
      }),
    );
    const response = await service.search({ query: "dancehall" });
    assert.equal(response.results.length, 0);
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes("m15-only-bundle-only-primary"), false);
  });

  test("preferred.includedServiceKeys lifts an offering whose bundle includes that component (atomic-only path)", async () => {
    // The M1.5 JM-mirror seller carries OFFERING_WITH_BUNDLE_COMPONENT
    // (primary category music-production, includedServices includes
    // "remote-coaching"). A preferred.includedServiceKeys=["remote-coaching"]
    // request must produce a deterministic factual preference label
    // naming that bundle component without affecting other offerings.
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({
      query: "dancehall",
      preferred: { includedServiceKeys: ["remote-coaching"] },
    });
    const jm = response.results.find((r) => r.seller.sellerId === "m15-seller-single-jm");
    assert.ok(jm);
    assert.ok(
      jm.matchReason.includes("preferred bundle component: remote-coaching"),
      `expected the bundle-component preference label, got: ${jm.matchReason}`,
    );
    // Sellers whose offering does not include that component must still
    // surface — preferences don't exclude per the v1 contract.
    assert.ok(response.results.find((r) => r.seller.sellerId === "m15-seller-multi-ht"));
  });

  test("preferred.specialties lifts a seller whose professional specialties match (atomic-only path)", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    // "Songwriter" is on SINGLE_OFFERING_SELLER_JM and on MULTI_BUNDLE_SELLER
    // only. Preferences don't exclude other sellers.
    const response = await service.search({
      query: "dancehall",
      preferred: { specialties: ["Songwriter"] },
    });
    const jm = response.results.find((r) => r.seller.sellerId === "m15-seller-single-jm");
    assert.ok(jm);
    assert.ok(
      jm.matchReason.includes("preferred specialty: Songwriter"),
      `expected the specialty preference label, got: ${jm.matchReason}`,
    );
    assert.ok(response.results.find((r) => r.seller.sellerId === "m15-seller-multi-ht"));
  });

  test("preferred.serviceModes lifts an offering whose serviceMode matches (atomic-only path)", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    // REMOTE is the serviceMode on every canonical M1.5 offering. We
    // assert the label is emitted when the buyer prefers Remote.
    const response = await service.search({
      query: "dancehall",
      preferred: { serviceModes: ["Remote"] },
    });
    for (const result of response.results) {
      const remoteMatches = [
        result.bestMatchingOffering,
        ...result.additionalMatchingOfferings,
      ].some((o) => o.serviceMode === "Remote");
      if (remoteMatches) {
        assert.ok(
          result.matchReason.includes("preferred service mode: Remote"),
          `expected the service-mode preference label, got: ${result.matchReason}`,
        );
      }
    }
  });

  test("preferred.basedIn (city / region / country) lifts the matching seller (atomic-only path)", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const city = await service.search({
      query: "dancehall",
      preferred: { basedIn: { city: "Brooklyn" } },
    });
    const region = await service.search({
      query: "dancehall",
      preferred: { basedIn: { region: "NY" } },
    });
    const country = await service.search({
      query: "dancehall",
      preferred: { basedIn: { countryCode: "US" } },
    });
    for (const [label, response] of [
      ["city", city],
      ["region", region],
      ["country", country],
    ] as const) {
      assert.ok(
        response.results.some(
          (r) =>
            r.matchReason.includes(`preferred based-in ${label}:`.replace(":", "")) ||
            // The label wording changes per kind — assert any of the
            // three preference labels appears for at least one result
            // whose seller is based in the requested locality.
            r.matchReason.includes("preferred based-in"),
        ),
        `expected a based-in preference label (${label}), got: ${JSON.stringify(
          response.results.map((r) => ({ id: r.seller.sellerId, reason: r.matchReason })),
        )}`,
      );
    }
  });

  // P1-001 regression (revised after codex review): the bounded score
  // no longer saturates at 1.0 under full text coverage because the
  // score now incorporates both signals as a ratio over a known
  // capacity (textMatched/total + preference lift / total preference).
  // A seller whose preference matched must outrank a seller whose
  // preference did not, even when the lexically earlier seller would
  // have won under stable sellerId alone. This test pins the documented
  // two-key ordering: descending score, then stable sellerId asc.
  test("preference ordering is preserved at full text coverage when only the lexically later seller matches", async () => {
    const sellers: InMemorySeller[] = [
      {
        // Lexically earlier; does NOT match the JM preference.
        sellerId: "p1-001-seller-a",
        workspaceId: "ws-p1-001-a",
        professionalName: "A non-JM seller",
        bio: "",
        status: "Published",
        basedInCity: "Brooklyn",
        basedInRegion: "NY",
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["HT"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          {
            ...PRODUCTION_OFFERING_A,
            offeringId: "p1-001-offering-a",
            title: "Dancehall single production",
          },
        ],
      },
      {
        // Lexically later; DOES match the JM preference.
        sellerId: "p1-001-seller-z",
        workspaceId: "ws-p1-001-z",
        professionalName: "Z JM seller",
        bio: "",
        status: "Published",
        basedInCity: "Brooklyn",
        basedInRegion: "NY",
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [
          {
            ...PRODUCTION_OFFERING_A,
            offeringId: "p1-001-offering-z",
            title: "Dancehall single production",
          },
        ],
      },
    ];
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        sellers,
        controlledKeys: M15_CONTROLLED_KEYS,
      }),
    );
    // Single-token query that fully matches the offering title; the
    // bounded score still differentiates the two sellers because the
    // JM-preferred seller lifts the matched preference share.
    const response = await service.search({
      query: "dancehall",
      preferred: { caribbeanAffiliationCodes: ["JM"] },
    });
    assert.equal(response.results.length, 2);
    // The JM seller must outrank the HT seller; their scores differ
    // (the JM seller carries the preference lift).
    const [first, second] = response.results;
    assert.ok(first && second);
    assert.equal(first.seller.sellerId, "p1-001-seller-z");
    assert.equal(second.seller.sellerId, "p1-001-seller-a");
    assert.ok(first.relevanceScore > second.relevanceScore);
    // Both relevanceScore values are bounded and finite.
    for (const result of response.results) {
      assert.ok(
        Number.isFinite(result.relevanceScore) &&
          result.relevanceScore >= 0 &&
          result.relevanceScore <= 1,
      );
    }
    // The JM seller's matchReason must include the factual preference
    // label so the order change is observable, not just a hidden score.
    const jmMatchReason = first.matchReason;
    assert.ok(
      jmMatchReason.includes("preferred Caribbean affiliation: JM"),
      `JM-preferred seller must carry the factual preference label, got: ${jmMatchReason}`,
    );
  });

  // P1-001 contract test (added after codex review): the documented
  // two-key ordering is descending score, then stable sellerId asc.
  // Two sellers with TRULY EQUAL relevanceScore (full text + preference
  // coverage) must therefore break the tie on the stable sellerId; the
  // previous matchedAtomCount secondary sort key would have inserted
  // a non-deterministic preference comparison before sellerId, which
  // violated the documented order when both candidates' matched
  // preference count was also equal.
  test("equal-score candidates with matching preferences break ties on the documented stable sellerId", async () => {
    const sharedOffering: InMemoryOffering = {
      ...PRODUCTION_OFFERING_A,
      offeringId: "p1-001-equal-offering",
      title: "Dancehall production package",
      genreTags: ["Dancehall"],
    };
    const sellers: InMemorySeller[] = [
      {
        // Lexically later; identical coverage, should land second.
        sellerId: "p1-001-equal-z",
        workspaceId: "ws-p1-001-equal-z",
        professionalName: "Z twin",
        bio: "",
        status: "Published",
        basedInCity: "Brooklyn",
        basedInRegion: "NY",
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [sharedOffering],
      },
      {
        // Lexically earlier; identical coverage, should land first.
        sellerId: "p1-001-equal-a",
        workspaceId: "ws-p1-001-equal-a",
        professionalName: "A twin",
        bio: "",
        status: "Published",
        basedInCity: "Brooklyn",
        basedInRegion: "NY",
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: "Active",
        workspaceHasSellerCapability: true,
        offerings: [sharedOffering],
      },
    ];
    const service = new TalentSearchService(
      new InMemoryTalentSearchRepository({
        sellers,
        controlledKeys: M15_CONTROLLED_KEYS,
      }),
    );
    // Query fully matches the shared title and the JM+Brooklyn
    // preferences match both sellers identically; both reach 1.0.
    const response = await service.search({
      query: "dancehall production",
      preferred: {
        caribbeanAffiliationCodes: ["JM"],
        basedIn: { city: "Brooklyn" },
      },
    });
    assert.equal(response.results.length, 2);
    const [first, second] = response.results;
    assert.ok(first && second);
    // Equal-score invariant.
    assert.equal(first.relevanceScore, second.relevanceScore);
    // Documented tie-break: stable sellerId ascending.
    assert.equal(first.seller.sellerId, "p1-001-equal-a");
    assert.equal(second.seller.sellerId, "p1-001-equal-z");
  });

  // P1-002 regression: every preference axis is canonicalized (trim,
  // case-normalize, dedupe, stable sort) before scoring and reason
  // generation. This test pins the determinism guarantee by feeding
  // the buyer-supplied request in two orderings and asserting that
  // the resulting seller order, scores, and reasons are identical.
  test("reordered preference axes produce identical ordering, score, and matchReason", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const reorderedA = await service.search({
      query: "dancehall",
      preferred: {
        categoryKeys: ["music-production"],
        genreTags: ["Dancehall"],
        basedIn: { city: "Brooklyn" },
      },
    });
    const reorderedB = await service.search({
      query: "dancehall",
      preferred: {
        // Different field order, different value order within fields.
        basedIn: { city: "Brooklyn" },
        genreTags: ["Dancehall"],
        categoryKeys: ["music-production"],
      },
    });
    assert.equal(reorderedA.results.length, reorderedB.results.length);
    for (let i = 0; i < reorderedA.results.length; i += 1) {
      assert.equal(reorderedA.results[i]!.seller.sellerId, reorderedB.results[i]!.seller.sellerId);
      assert.equal(reorderedA.results[i]!.relevanceScore, reorderedB.results[i]!.relevanceScore);
      assert.equal(reorderedA.results[i]!.matchReason, reorderedB.results[i]!.matchReason);
    }
  });

  // P1-002 regression: duplicate values inside a preference axis must
  // not inflate the denominator of preferenceScore. Before the fix, a
  // buyer who listed the same genre twice would have their score
  // deflated even when the offering matched both copies; the duplicate
  // would also emit two identical reason labels. The canonicalization
  // step collapses the duplicates into a single atom so both the score
  // and the reason stay deterministic.
  test("duplicate values inside a preference axis are collapsed before scoring and labeling", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const withDuplicates = await service.search({
      query: "dancehall",
      preferred: {
        genreTags: ["Dancehall", "Dancehall", "dancehall"],
      },
    });
    const withoutDuplicates = await service.search({
      query: "dancehall",
      preferred: { genreTags: ["Dancehall"] },
    });
    assert.equal(withDuplicates.results.length, withoutDuplicates.results.length);
    for (let i = 0; i < withDuplicates.results.length; i += 1) {
      // For every result whose reason actually names the matched genre,
      // the duplicate-suppressed label must appear exactly once. Genre
      // atoms are canonicalized to lowercase so the deterministic label
      // reads "preferred genre: dancehall" regardless of buyer casing.
      const occurrences =
        withDuplicates.results[i]!.matchReason.split("preferred genre: dancehall").length - 1;
      assert.ok(
        occurrences <= 1,
        `expected at most one genre label occurrence per matched offering, got ${occurrences} in "${withDuplicates.results[i]!.matchReason}"`,
      );
      // The two requests must be observationally identical: identical
      // seller order, score, and reason for every result, including
      // the ones whose best offering did not match the genre.
      assert.equal(
        withDuplicates.results[i]!.relevanceScore,
        withoutDuplicates.results[i]!.relevanceScore,
      );
      assert.equal(
        withDuplicates.results[i]!.matchReason,
        withoutDuplicates.results[i]!.matchReason,
      );
    }
  });

  // P1-002 regression: case variants inside a preference axis (genre
  // tags, locality, ISO codes) must canonicalize to a single atom.
  // Without canonicalization a buyer typing ["Dancehall", "dancehall"]
  // would emit a reason with two labels and would split the
  // preferenceScore denominator in two.
  test("case variants inside a preference axis canonicalize to a single atom", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const mixedCase = await service.search({
      query: "dancehall",
      preferred: {
        genreTags: ["Dancehall", "dancehall", "DANCEHALL"],
        basedIn: { city: "brooklyn", region: "ny", countryCode: "us" },
      },
    });
    const canonical = await service.search({
      query: "dancehall",
      preferred: {
        genreTags: ["Dancehall"],
        basedIn: { city: "Brooklyn", region: "NY", countryCode: "US" },
      },
    });
    assert.equal(mixedCase.results.length, canonical.results.length);
    for (let i = 0; i < mixedCase.results.length; i += 1) {
      assert.equal(mixedCase.results[i]!.relevanceScore, canonical.results[i]!.relevanceScore);
      assert.equal(mixedCase.results[i]!.matchReason, canonical.results[i]!.matchReason);
      // The canonical reason must use the upper-case ISO country code
      // and lower-case locality. Without canonicalization the reason
      // would carry the raw buyercasing ("us", "brooklyn"), making
      // the label nondeterministic across reorders.
      assert.ok(
        canonical.results[i]!.matchReason.includes("preferred based-in country: US"),
        `expected canonical country label, got: ${canonical.results[i]!.matchReason}`,
      );
    }
  });

  test("includedServices always carry purchaseMode BundleOnly on the public DTO (mapping boundary locked)", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({ query: "dancehall" });
    for (const result of response.results) {
      for (const offering of [result.bestMatchingOffering, ...result.additionalMatchingOfferings]) {
        for (const included of offering.includedServices) {
          assert.equal(
            included.purchaseMode,
            "BundleOnly",
            "toPublicOffering must label every includedService as BundleOnly",
          );
        }
      }
    }
  });

  // P1-001 regression: the v1 contract states that `preferenceCoverage`
  // is omitted whenever the buyer supplied no canonical preference atoms;
  // a "0 of 0" payload is not factual evidence, so the service must not
  // emit it. This locks the documented omission semantics at the service
  // boundary so the runtime schema, the public contract, and the spec
  // cannot drift back to the unconditional-serialization behavior.
  test("preferenceCoverage is omitted from every result when no preferences were supplied", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({ query: "dancehall" });
    assert.ok(response.results.length > 0, "the fixture must produce at least one result");
    for (const result of response.results) {
      assert.equal(
        result.preferenceCoverage,
        undefined,
        "preferenceCoverage must be omitted when no canonical preference atoms were supplied",
      );
    }
  });

  // P1-001 regression: when at least one canonical preference atom IS
  // supplied, the field must be present with the factual matched/total
  // counts derived from the deterministic matcher (never from
  // relevanceScore).
  test("preferenceCoverage is present when at least one canonical preference atom is supplied", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildM15Fixture()));
    const response = await service.search({
      query: "dancehall",
      preferred: { caribbeanAffiliationCodes: ["JM"] },
    });
    assert.ok(response.results.length > 0, "the fixture must produce at least one result");
    for (const result of response.results) {
      assert.ok(
        result.preferenceCoverage !== undefined,
        "preferenceCoverage must be present when preferences were supplied",
      );
      assert.equal(
        result.preferenceCoverage!.total,
        1,
        "preferenceCoverage.total must equal the canonical preference-atom count",
      );
      assert.ok(
        result.preferenceCoverage!.matched >= 0 && result.preferenceCoverage!.matched <= 1,
        "preferenceCoverage.matched must be bounded by preferenceCoverage.total",
      );
    }
  });
});
