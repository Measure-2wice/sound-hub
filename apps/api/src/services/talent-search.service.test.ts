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
import { SellerProfileStatus, ServiceOfferingStatus, WorkspaceStatus } from "@soundhub/db";

const REMOTE_PRODUCTION = {
  offeringId: "offering-remote-production",
  title: "Haitian dancehall single production — remote",
  description: "Caribbean-flavored dancehall single production for diaspora artists.",
  status: ServiceOfferingStatus.Active,
  serviceMode: "Remote" as const,
  primaryCategory: { key: "music-production", name: "Music Production" },
  includedServices: [],
  genreTags: ["Dancehall", "Soca", "Hip-Hop"],
  serviceAreas: [{ city: null, region: null, countryCode: "US" }],
  pricing: {
    kind: "StartingAt" as const,
    amountMinor: 60000,
    currency: "USD",
    unitKey: "track",
  },
};

const INPERSON_LIVE = {
  offeringId: "offering-inperson-live",
  title: "Caribbean live set and band direction",
  description: "Hybrid live set with band direction.",
  status: ServiceOfferingStatus.Active,
  serviceMode: "InPerson" as const,
  primaryCategory: { key: "live-performance", name: "Live Performance" },
  includedServices: [],
  genreTags: ["Junkanoo", "Dancehall"],
  serviceAreas: [{ city: null, region: null, countryCode: "BS" }],
  pricing: null,
};

const DRAFT_OFFERING = {
  offeringId: "offering-draft-music-production",
  title: "Draft production offering",
  description: "Should be excluded from search results.",
  status: ServiceOfferingStatus.Draft,
  serviceMode: "Remote" as const,
  primaryCategory: { key: "music-production", name: "Music Production" },
  includedServices: [],
  genreTags: [],
  serviceAreas: [{ city: null, region: null, countryCode: "US" }],
  pricing: null,
};

function buildFixture(): InMemoryFixture {
  const sellers: InMemorySeller[] = [
    {
      sellerId: "seller-haitian-brooklyn",
      workspaceId: "workspace-creole-beats",
      professionalName: "Marc-André Pierre",
      bio: "Brooklyn-based Haitian producer.",
      status: SellerProfileStatus.Published,
      basedInCity: "Brooklyn",
      basedInRegion: "NY",
      basedInCountryCode: "US",
      avatarUrl: null,
      specialtyKeys: ["Producer"],
      caribbeanAffiliationCodes: ["HT"],
      workspaceStatus: WorkspaceStatus.Active,
      workspaceHasSellerCapability: true,
      offerings: [REMOTE_PRODUCTION],
    },
    {
      sellerId: "seller-bahamian-live",
      workspaceId: "workspace-devon-king",
      professionalName: "Devon King",
      bio: "Bahamian live performer.",
      status: SellerProfileStatus.Published,
      basedInCity: "Nassau",
      basedInRegion: null,
      basedInCountryCode: "BS",
      avatarUrl: null,
      specialtyKeys: ["Artist"],
      caribbeanAffiliationCodes: ["BS"],
      workspaceStatus: WorkspaceStatus.Active,
      workspaceHasSellerCapability: true,
      offerings: [INPERSON_LIVE],
    },
    {
      sellerId: "seller-draft-only",
      workspaceId: "workspace-draft",
      professionalName: "Draft Seller",
      bio: "Has a draft offering only.",
      status: SellerProfileStatus.Published,
      basedInCity: "Miami",
      basedInRegion: "FL",
      basedInCountryCode: "US",
      avatarUrl: null,
      specialtyKeys: ["Producer"],
      caribbeanAffiliationCodes: ["HT"],
      workspaceStatus: WorkspaceStatus.Active,
      workspaceHasSellerCapability: true,
      offerings: [DRAFT_OFFERING],
    },
  ];
  return { sellers };
}

function offeringById(
  sellers: readonly InMemorySeller[],
  id: string,
): InMemoryOffering | undefined {
  for (const seller of sellers) {
    for (const offering of seller.offerings) {
      if (offering.offeringId === id) return offering;
    }
  }
  return undefined;
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
    // Four distinct tokens: haitian, dancehall, single, production
    assert.ok(Math.abs(result.relevanceScore - 4 / 4) < 1e-9);
  });

  test("ties on relevanceScore are broken by stable sellerId ascending", async () => {
    const sellers: InMemorySeller[] = [
      {
        sellerId: "seller-z",
        workspaceId: "w-z",
        professionalName: "Z Seller",
        bio: "",
        status: SellerProfileStatus.Published,
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: WorkspaceStatus.Active,
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
        status: SellerProfileStatus.Published,
        basedInCity: null,
        basedInRegion: null,
        basedInCountryCode: "US",
        avatarUrl: null,
        specialtyKeys: ["Producer"],
        caribbeanAffiliationCodes: ["JM"],
        workspaceStatus: WorkspaceStatus.Active,
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

  test("required service mode excludes ineligible offerings", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({
      required: { serviceModes: ["Remote"] },
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

  test("normalized query is exposed in metadata and trimmed/lower-cased", async () => {
    const service = new TalentSearchService(new InMemoryTalentSearchRepository(buildFixture()));
    const response = await service.search({ query: "  HAITIAN   Dancehall  " });
    assert.equal(response.metadata.normalizedQuery, "haitian dancehall");
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
    assert.equal(
      offeringById(buildFixture().sellers, "offering-inperson-live") !== undefined,
      true,
    );
  });
});
