/* eslint-disable @typescript-eslint/no-floating-promises */
//
// Repository integration tests against the disposable local PostgreSQL.
//
// These tests are gated on TEST_DATABASE_URL via the M1 test database guard
// and the script `apps/api/package.json: test:repository`. They never touch
// the developer database. The disposable service is brought up with
// `pnpm db:test:up`; migration and seed are applied with `pnpm db:test:migrate`
// and `pnpm db:test:seed` before this file is executed.

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

describe("PrismaTalentSearchRepository", () => {
  test("returns the seeded Published sellers with their Active offerings", async () => {
    const candidates = await repository.search({
      serviceModes: [],
      basedInCountryCodes: [],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: [],
      caribbeanAffiliationCodes: [],
    });
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
    const candidates = await repository.search({
      serviceModes: [],
      basedInCountryCodes: [],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: [],
      caribbeanAffiliationCodes: [],
    });
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.notEqual(offering.status, ServiceOfferingStatus.Draft);
      }
    }
  });

  test("filters by primaryCategoryKeys at the repository level", async () => {
    const candidates = await repository.search({
      serviceModes: [],
      basedInCountryCodes: [],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: ["music-production"],
      caribbeanAffiliationCodes: [],
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
      serviceModes: ["InPerson"],
      basedInCountryCodes: [],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: [],
      caribbeanAffiliationCodes: [],
    });
    assert.ok(candidates.length >= 1);
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.equal(offering.serviceMode, "InPerson");
      }
    }
  });

  test("filters by basedInCountryCodes at the repository level", async () => {
    const candidates = await repository.search({
      serviceModes: [],
      basedInCountryCodes: ["BS"],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: [],
      caribbeanAffiliationCodes: [],
    });
    assert.ok(candidates.length >= 1);
    for (const seller of candidates) {
      assert.equal(seller.basedInCountryCode, "BS");
    }
  });

  test("filters by caribbeanAffiliationCodes at the repository level", async () => {
    const candidates = await repository.search({
      serviceModes: [],
      basedInCountryCodes: [],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: [],
      caribbeanAffiliationCodes: ["HT"],
    });
    assert.ok(candidates.length >= 1);
    for (const seller of candidates) {
      assert.ok(seller.caribbeanAffiliationCodes.includes("HT"));
    }
  });

  test("does not return Paused or Archived offerings", async () => {
    // Transition a seeded offering to Paused and confirm it is excluded.
    const candidates = await repository.search({
      serviceModes: [],
      basedInCountryCodes: [],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: [],
      caribbeanAffiliationCodes: [],
    });
    const firstOffering = candidates[0]?.offerings[0];
    assert.ok(firstOffering, "expected at least one active offering to mutate");
    const prisma = createTestPrismaClient();
    try {
      await prisma.serviceOffering.update({
        where: { id: firstOffering.offeringId },
        data: { status: ServiceOfferingStatus.Paused },
      });
      const after = await repository.search({
        serviceModes: [],
        basedInCountryCodes: [],
        serviceAreaCountryCodes: [],
        primaryCategoryKeys: [],
        caribbeanAffiliationCodes: [],
      });
      const stillReturned = after
        .flatMap((seller) => seller.offerings)
        .some((offering) => offering.offeringId === firstOffering.offeringId);
      assert.equal(stillReturned, false);
    } finally {
      await prisma.serviceOffering.update({
        where: { id: firstOffering.offeringId },
        data: { status: ServiceOfferingStatus.Active },
      });
      await prisma.$disconnect();
    }
  });

  test("does not return sellers whose workspace is not Active or not Seller-capable", async () => {
    // Suspend a workspace and confirm its seller drops out.
    const candidates = await repository.search({
      serviceModes: [],
      basedInCountryCodes: [],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: [],
      caribbeanAffiliationCodes: [],
    });
    const first = candidates[0];
    assert.ok(first, "expected at least one seller");
    const prisma = createTestPrismaClient();
    try {
      await prisma.workspace.update({
        where: { id: first.workspaceId },
        data: { status: WorkspaceStatus.Suspended },
      });
      const after = await repository.search({
        serviceModes: [],
        basedInCountryCodes: [],
        serviceAreaCountryCodes: [],
        primaryCategoryKeys: [],
        caribbeanAffiliationCodes: [],
      });
      const stillReturned = after.some((seller) => seller.sellerId === first.sellerId);
      assert.equal(stillReturned, false);
    } finally {
      await prisma.workspace.update({
        where: { id: first.workspaceId },
        data: { status: WorkspaceStatus.Active },
      });
      await prisma.$disconnect();
    }
  });

  test("does not return sellers whose workspace lacks the Seller capability", async () => {
    const candidates = await repository.search({
      serviceModes: [],
      basedInCountryCodes: [],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: [],
      caribbeanAffiliationCodes: [],
    });
    const first = candidates[0];
    assert.ok(first, "expected at least one seller");
    const prisma = createTestPrismaClient();
    try {
      await prisma.workspaceCapability.deleteMany({
        where: { workspaceId: first.workspaceId, capability: MarketplaceCapability.Seller },
      });
      const after = await repository.search({
        serviceModes: [],
        basedInCountryCodes: [],
        serviceAreaCountryCodes: [],
        primaryCategoryKeys: [],
        caribbeanAffiliationCodes: [],
      });
      const stillReturned = after.some((seller) => seller.sellerId === first.sellerId);
      assert.equal(stillReturned, false);
    } finally {
      // Restore the Seller capability and the corresponding service offering link
      // is not strictly necessary; the test only asserts the candidate drops.
      await prisma.workspaceCapability.create({
        data: { workspaceId: first.workspaceId, capability: MarketplaceCapability.Seller },
      });
      await prisma.$disconnect();
    }
  });

  test("results are ordered by stable sellerId ascending when no filter narrows the set", async () => {
    const candidates = await repository.search({
      serviceModes: [],
      basedInCountryCodes: [],
      serviceAreaCountryCodes: [],
      primaryCategoryKeys: [],
      caribbeanAffiliationCodes: [],
    });
    const ids = candidates.map((seller) => seller.sellerId);
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted);
  });
});
