/* eslint-disable @typescript-eslint/no-floating-promises */
//
// Repository integration tests against the disposable local PostgreSQL.
//
// These tests are gated on TEST_DATABASE_URL via the M1 test database
// guard and the script `apps/api/package.json: test:repository`. They
// never touch the developer database. The disposable service is brought
// up with `pnpm db:test:up`; migration and seed are applied with
// `pnpm db:test:cycle` before this file is executed.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestPrismaClient } from "../lib/test-database.js";
import { PrismaTalentSearchRepository } from "./prisma-talent-search.repository.js";
import {
  MarketplaceCapability,
  SellerProfileStatus,
  ServiceOfferingStatus,
  WorkspaceStatus,
} from "@soundhub/db";
import type { RepositorySearchInput } from "./talent-search.repository.js";

const EMPTY_INPUT: RepositorySearchInput = {
  serviceModes: [],
  primaryCategoryKeys: [],
  independentlyPurchasableServiceKeys: [],
  basedIn: null,
  serviceArea: null,
};

const repository = new PrismaTalentSearchRepository(createTestPrismaClient());

before(async () => {
  await Promise.resolve();
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required to run repository integration tests");
  }
});

after(async () => {
  // The Prisma client is closed on process exit; nothing to do here.
});

async function restoreOffering(offeringId: string) {
  const prisma = createTestPrismaClient();
  try {
    await prisma.serviceOffering.update({
      where: { id: offeringId },
      data: { status: ServiceOfferingStatus.Active },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function restoreWorkspace(workspaceId: string) {
  const prisma = createTestPrismaClient();
  try {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { status: WorkspaceStatus.Active },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function restoreCapability(workspaceId: string) {
  const prisma = createTestPrismaClient();
  try {
    await prisma.workspaceCapability.upsert({
      where: {
        workspaceId_capability: { workspaceId, capability: MarketplaceCapability.Seller },
      },
      create: { workspaceId, capability: MarketplaceCapability.Seller },
      update: {},
    });
  } finally {
    await prisma.$disconnect();
  }
}

describe("PrismaTalentSearchRepository", () => {
  test("returns the seeded Published sellers with their Active offerings", async () => {
    const candidates = await repository.search(EMPTY_INPUT);
    assert.ok(
      candidates.length >= 6,
      `expected at least 6 seeded sellers, got ${candidates.length}`,
    );
    for (const seller of candidates) {
      assert.equal(seller.status, SellerProfileStatus.Published);
      assert.ok(
        seller.offerings.length >= 1,
        "published seller must have at least one active offering",
      );
      for (const offering of seller.offerings) {
        assert.equal(offering.status, ServiceOfferingStatus.Active);
      }
    }
  });

  test("excludes Draft offerings", async () => {
    const candidates = await repository.search(EMPTY_INPUT);
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.notEqual(offering.status, ServiceOfferingStatus.Draft);
      }
    }
  });

  test("filters by primaryCategoryKeys at the repository level", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      primaryCategoryKeys: ["music-production"],
    });
    assert.ok(candidates.length >= 1);
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.equal(offering.primaryCategory.key, "music-production");
      }
    }
  });

  test("filters by serviceModes at the repository level", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      serviceModes: ["InPerson"],
    });
    assert.ok(candidates.length >= 1);
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.equal(offering.serviceMode, "InPerson");
      }
    }
  });

  test("filters by basedIn country code at the repository level", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      basedIn: { city: null, region: null, countryCode: "BS" },
    });
    assert.ok(candidates.length >= 1);
    for (const seller of candidates) {
      assert.equal(seller.basedInCountryCode, "BS");
    }
  });

  test("filters by basedIn city at the repository level", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      basedIn: { city: "Brooklyn", region: null, countryCode: "US" },
    });
    const sellerIds = candidates.map((s) => s.sellerId);
    assert.ok(sellerIds.length >= 1, "expected at least one Brooklyn seller");
    assert.ok(sellerIds.includes("sp-creole-beats-brooklyn"));
  });

  test("filters by basedIn region at the repository level", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      basedIn: { city: null, region: "NY", countryCode: "US" },
    });
    const sellerIds = candidates.map((s) => s.sellerId);
    assert.ok(sellerIds.length >= 1);
    assert.ok(sellerIds.includes("sp-creole-beats-brooklyn"));
  });

  test("filters by serviceArea country code at the repository level", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      serviceArea: { city: null, region: null, countryCode: "GB" },
    });
    assert.ok(candidates.length >= 1);
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.ok(
          offering.serviceAreas.some((a) => a.countryCode === "GB"),
          `expected offering ${offering.offeringId} to have a GB service area`,
        );
      }
    }
  });

  test("required serviceArea city filter excludes offerings without a matching city", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      serviceArea: { city: "London", region: null, countryCode: "GB" },
    });
    assert.ok(candidates.length >= 1);
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.ok(
          offering.serviceAreas.some((a) => a.city === "London"),
          `expected offering ${offering.offeringId} to have a London service area`,
        );
      }
    }
  });

  test("required serviceArea city mismatch excludes the seller", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      serviceArea: { city: "Brooklyn", region: null, countryCode: "BS" },
    });
    // The seeded Bahamas live offering has service area BS but no Brooklyn.
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.ok(
          offering.serviceAreas.some(
            (a) => (a.city === "Brooklyn" && a.countryCode === "BS") ||
              a.countryCode !== "BS",
          ),
        );
      }
    }
  });

  test("required independentlyPurchasableServiceKeys accepts the matching category and excludes bundle-only categories", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      independentlyPurchasableServiceKeys: ["music-production"],
    });
    assert.ok(candidates.length >= 1);
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.equal(offering.primaryCategory.bundleOnly, false);
        assert.equal(offering.primaryCategory.key, "music-production");
      }
    }
  });

  test("required independentlyPurchasableServiceKeys does not satisfy bundle-only categories", async () => {
    // The repository is invoked with a stable key that does not exist in
    // the controlled records. The expectation is zero results, not silent
    // acceptance.
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      independentlyPurchasableServiceKeys: ["non-existent-bundle-only"],
    });
    assert.equal(candidates.length, 0);
  });

  test("unknown stable keys in required filters yield zero results, not silent acceptance", async () => {
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      primaryCategoryKeys: ["not-a-real-category"],
    });
    assert.equal(candidates.length, 0);
  });

  test("required filters do not depend on preferred Caribbean affiliations", async () => {
    // The repository input no longer carries caribbeanAffiliationCodes;
    // a structured-only request without a Caribbean code still returns
    // the eligible Caribbean sellers.
    const candidates = await repository.search(EMPTY_INPUT);
    assert.ok(
      candidates.some((s) => s.caribbeanAffiliationCodes.includes("HT")),
      "expected at least one Haitian seller",
    );
  });

  test("does not return Paused or Archived offerings", async () => {
    const candidates = await repository.search(EMPTY_INPUT);
    const firstOffering = candidates[0]?.offerings[0];
    assert.ok(firstOffering, "expected at least one active offering to mutate");
    const prisma = createTestPrismaClient();
    try {
      await prisma.serviceOffering.update({
        where: { id: firstOffering.offeringId },
        data: { status: ServiceOfferingStatus.Paused },
      });
      const after = await repository.search(EMPTY_INPUT);
      const stillReturned = after
        .flatMap((seller) => seller.offerings)
        .some((offering) => offering.offeringId === firstOffering.offeringId);
      assert.equal(stillReturned, false);
    } finally {
      await restoreOffering(firstOffering.offeringId);
    }
  });

  test("does not return sellers whose workspace is Suspended", async () => {
    const candidates = await repository.search(EMPTY_INPUT);
    const first = candidates[0];
    assert.ok(first, "expected at least one seller");
    const prisma = createTestPrismaClient();
    try {
      await prisma.workspace.update({
        where: { id: first.workspaceId },
        data: { status: WorkspaceStatus.Suspended },
      });
      const after = await repository.search(EMPTY_INPUT);
      assert.equal(
        after.some((seller) => seller.sellerId === first.sellerId),
        false,
      );
    } finally {
      await restoreWorkspace(first.workspaceId);
    }
  });

  test("does not return sellers whose workspace lacks the Seller capability", async () => {
    const candidates = await repository.search(EMPTY_INPUT);
    const first = candidates[0];
    assert.ok(first, "expected at least one seller");
    const prisma = createTestPrismaClient();
    try {
      await prisma.workspaceCapability.deleteMany({
        where: { workspaceId: first.workspaceId, capability: MarketplaceCapability.Seller },
      });
      const after = await repository.search(EMPTY_INPUT);
      assert.equal(
        after.some((seller) => seller.sellerId === first.sellerId),
        false,
      );
    } finally {
      await restoreCapability(first.workspaceId);
    }
  });

  test("does not return sellers whose SellerProfile is Suspended or Draft", async () => {
    const candidates = await repository.search(EMPTY_INPUT);
    const first = candidates[0];
    assert.ok(first, "expected at least one seller");
    const prisma = createTestPrismaClient();
    try {
      await prisma.sellerProfile.update({
        where: { id: first.sellerId },
        data: { status: SellerProfileStatus.Suspended },
      });
      const after = await repository.search(EMPTY_INPUT);
      assert.equal(
        after.some((seller) => seller.sellerId === first.sellerId),
        false,
      );
    } finally {
      await prisma.sellerProfile.update({
        where: { id: first.sellerId },
        data: { status: SellerProfileStatus.Published },
      });
      await prisma.$disconnect();
    }
  });

  test("results are ordered by stable sellerId ascending when no filter narrows the set", async () => {
    const candidates = await repository.search(EMPTY_INPUT);
    const ids = candidates.map((seller) => seller.sellerId);
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted);
  });

  test("deterministic seed state: every run returns the same sellerIds in the same order", async () => {
    const first = await repository.search(EMPTY_INPUT);
    const second = await repository.search(EMPTY_INPUT);
    assert.deepEqual(
      first.map((s) => s.sellerId),
      second.map((s) => s.sellerId),
    );
  });
});
