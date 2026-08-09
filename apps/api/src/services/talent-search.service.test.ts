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
  return { sellers };
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
    const service = new TalentSearchService(new InMemoryTalentSearchRepository({ sellers }));
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
      (err: unknown) =>
        err instanceof Error && /Unsupported specialty key/.test(err.message),
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
      assert.ok(
        result.error.issues.some((issue) => /city/.test(issue.message)),
      );
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

  test("public DTO excludes private fields", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "Haitian dancehall single production" });
    const result = response.results[0]!;
    const seller = result.seller as unknown as Record<string, unknown>;
    assert.equal(seller["email"], undefined);
    assert.equal(seller["workspaceId"], undefined);
    assert.equal(seller["vibeEmbeddingVector"], undefined);
    assert.equal(seller["password"], undefined);
    const offering = result.bestMatchingOffering as unknown as Record<string, unknown>;
    assert.equal(offering["s3Key"], undefined);
    assert.equal(offering["embedding"], undefined);
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
});
