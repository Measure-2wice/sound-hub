// Prisma-backed ProjectBriefRepository integration test.
//
// Background: BG3 requires the Matchmaker persistence path to live
// behind the repository boundary and to write the Brief + its
// search results in a single transactional unit. This test exercises
// the Prisma adapter against the disposable test database the M1
// plan established so the integration test fails closed without a
// target.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import type { Bg3MatchmakerCriteriaV1, TalentSearchResponseV1 } from "@soundhub/types";
import { bg3MatchmakerCriteriaV1Schema } from "@soundhub/types";
import { PrismaProjectBriefRepository } from "./prisma-project-brief.repository.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

describe("PrismaProjectBriefRepository", () => {
  let prisma: ReturnType<typeof createPrismaClient> | null = null;
  let repo: PrismaProjectBriefRepository | null = null;

  before(() => {
    if (skip) return;
    prisma = createPrismaClient(TEST_DATABASE_URL);
    repo = new PrismaProjectBriefRepository(prisma);
  });

  after(async () => {
    if (prisma) await prisma.$disconnect();
  });

  // Criteria shape with the query axis present so a focused test can
  // assert the round-trip preserves it.
  const queryOnlyCriteria: Bg3MatchmakerCriteriaV1 = {
    required: { primaryCategoryKeys: ["music-production"] },
    query: "dancehall",
  };

  test("createBrief persists the Brief + results; findBriefById round-trips the criteria", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }

    // Use the BG1 demo buyer + Workspace seeded by the M1 seed so
    // the buyerWorkspaceId foreign key resolves.
    const buyer = await prisma.userAccount.findUnique({
      where: { email: "demo.buyer@soundhub.example" },
    });
    assert.ok(buyer, "BG1 demo buyer must be seeded");
    const workspace = await prisma.workspace.findUnique({
      where: { slug: "bg1-demo-buyer" },
    });
    assert.ok(workspace, "BG1 demo buyer Workspace must be seeded");

    const criteria: Bg3MatchmakerCriteriaV1 = {
      required: { primaryCategoryKeys: ["music-production"] },
      preferred: { genreTags: ["dancehall"] },
    };
    const searchResponse: TalentSearchResponseV1 = {
      results: [
        {
          seller: {
            sellerId: "seller-test",
            professionalName: "Test Seller",
            specialties: ["Producer"],
            bio: "Test seller for BG3 integration test.",
            basedIn: { countryCode: "US" },
            caribbeanAffiliationCodes: [],
          },
          bestMatchingOffering: {
            offeringId: "of-test",
            title: "Test offering",
            description: "Test offering description.",
            primaryCategory: { key: "music-production", name: "Music Production" },
            includedServices: [],
            genreTags: ["Dancehall"],
            serviceMode: "Remote",
            serviceAreas: [{ countryCode: "US" }],
          },
          additionalMatchingOfferings: [],
          relevanceScore: 0.7,
          matchReason: "matched offering title",
        },
      ],
      metadata: {
        totalResults: 1,
        processingTimeMs: 1,
        strategy: "postgres-text-v1",
        appliedRequiredCriteria: criteria.required,
        appliedPreferredCriteria: criteria.preferred ?? {},
      },
    };

    const created = await repo.createBrief({
      buyerWorkspaceId: workspace.id,
      createdByUserId: buyer.id,
      briefText: "Need a test producer.",
      criteria,
      searchResponse,
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
    });
    assert.ok(created.id);
    assert.equal(created.aiProvider, "deterministic-fallback");
    assert.equal(created.results.length, 1);
    assert.equal(created.results[0]?.bestOfferingId, "of-test");

    const roundTrip = await repo.findBriefById(created.id);
    assert.ok(roundTrip);
    assert.equal(roundTrip.id, created.id);
    assert.deepEqual(roundTrip.criteria.required, criteria.required);
    assert.deepEqual(roundTrip.criteria.preferred, criteria.preferred);
    assert.equal(roundTrip.aiFallbackUsed, true);
    assert.equal(roundTrip.results.length, 1);

    // Clean up so the test is repeatable.
    await prisma.projectBrief.delete({ where: { id: created.id } });
  });

  test("createBrief persists and restores the criteria query axis", async (t) => {
    if (skip || !repo || !prisma) {
      t.skip();
      return;
    }
    const buyer = await prisma.userAccount.findUnique({
      where: { email: "demo.buyer@soundhub.example" },
    });
    assert.ok(buyer, "BG1 demo buyer must be seeded");
    const workspace = await prisma.workspace.findUnique({
      where: { slug: "bg1-demo-buyer" },
    });
    assert.ok(workspace, "BG1 demo buyer Workspace must be seeded");

    const searchResponse: TalentSearchResponseV1 = {
      results: [],
      metadata: {
        totalResults: 0,
        processingTimeMs: 0,
        strategy: "postgres-text-v1",
        appliedRequiredCriteria: queryOnlyCriteria.required,
        appliedPreferredCriteria: {},
      },
    };

    const created = await repo.createBrief({
      buyerWorkspaceId: workspace.id,
      createdByUserId: buyer.id,
      briefText: "Anything goes.",
      criteria: queryOnlyCriteria,
      searchResponse,
      aiProvider: "deterministic-fallback",
      aiModelId: null,
      aiFallbackUsed: true,
    });
    assert.equal(created.criteria.query, "dancehall");

    const roundTrip = await repo.findBriefById(created.id);
    assert.ok(roundTrip);
    assert.equal(
      roundTrip.criteria.query,
      "dancehall",
      "criteria.query must survive the round-trip",
    );
    // The reconstructed criteria must validate against the BG3
    // runtime schema; the repository's toPersistedBrief re-validates
    // it as a single unit, so a tampered query column would throw
    // before the route layer ever saw it.
    bg3MatchmakerCriteriaV1Schema.parse(roundTrip.criteria);

    await prisma.projectBrief.delete({ where: { id: created.id } });
  });

  test("findBriefById returns null when the brief is absent", async (t) => {
    if (skip || !repo) {
      t.skip();
      return;
    }
    const result = await repo.findBriefById("brief-does-not-exist");
    assert.equal(result, null);
  });
});
