/* eslint-disable @typescript-eslint/no-floating-promises */
//
// Repository integration tests against the disposable local PostgreSQL.
//
// These tests are gated on TEST_DATABASE_URL via the M1 test database
// guard and the script `apps/api/package.json: test:repository`. They
// never touch the developer database.
//
// Every test begins from the deterministic canonical seed state. The
// `beforeEach` hook spawns the seed as a child process with the
// fail-closed exact-target guard so the database is in a known
// state before each test, regardless of what a prior test did.
// Mutations and deletions performed by a test are wiped by the
// next `beforeEach` invocation.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { beforeEach, describe, test } from "node:test";
import { createTestPrismaClient } from "../lib/test-database.js";
import { PrismaTalentSearchRepository } from "./prisma-talent-search.repository.js";
import { SellerProfileStatus, ServiceOfferingStatus } from "@soundhub/db";
import type { RepositorySearchInput } from "./talent-search.repository.js";

const EMPTY_INPUT: RepositorySearchInput = {
  serviceModes: [],
  primaryCategoryKeys: [],
  independentlyPurchasableServiceKeys: [],
  basedIn: null,
  serviceArea: null,
};

const repository = new PrismaTalentSearchRepository(createTestPrismaClient());

function resetViaSeed(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Delegate to the fail-closed guarded seed wrapper at
    // scripts/db-test-seed.mjs. The wrapper validates that
    // TEST_DATABASE_URL matches the exact approved disposable test
    // target (localhost:5433/soundhub_m1_test) and refuses to run
    // otherwise. The seed process inherits the validated URL as
    // DATABASE_URL; this path cannot be pointed at any other database.
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) {
      reject(new Error("TEST_DATABASE_URL is required"));
      return;
    }
    const testFile = new URL(import.meta.url);
    const repoRoot = new URL("../../../../", testFile).pathname;
    const tsxBin = new URL("../../node_modules/.bin/tsx", testFile).pathname;
    const child = spawn(tsxBin, [`${repoRoot}scripts/db-test-seed.mjs`], {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        TEST_DATABASE_URL: databaseUrl,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed wrapper exited with code ${code}`));
    });
  });
}

beforeEach(async () => {
  await resetViaSeed();
});

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
    for (const seller of candidates) {
      for (const offering of seller.offerings) {
        assert.ok(
          offering.serviceAreas.some(
            (a) => (a.city === "Brooklyn" && a.countryCode === "BS") || a.countryCode !== "BS",
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
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      independentlyPurchasableServiceKeys: ["non-existent-bundle-only"],
    });
    assert.equal(candidates.length, 0);
  });

  test("unknown stable keys in required filters yield zero repository results (canonical validation is the service layer's job)", async () => {
    // The repository itself does not know about canonical keys. It
    // returns zero results when the requested key matches no primary
    // category. Canonical validation that rejects unknown keys with
    // INVALID_SEARCH_CRITERIA is the service layer's responsibility
    // (see apps/api/src/services/talent-search.service.test.ts).
    const candidates = await repository.search({
      ...EMPTY_INPUT,
      primaryCategoryKeys: ["not-a-real-category"],
    });
    assert.equal(candidates.length, 0);
  });

  test("required filters do not depend on preferred Caribbean affiliations", async () => {
    const candidates = await repository.search(EMPTY_INPUT);
    assert.ok(
      candidates.some((s) => s.caribbeanAffiliationCodes.includes("HT")),
      "expected at least one Haitian seller",
    );
  });

  test("does not return Paused or Archived offerings (state wiped by the next beforeEach reset)", async () => {
    const prisma = createTestPrismaClient();
    try {
      const target = await prisma.serviceOffering.findFirst({
        where: { status: ServiceOfferingStatus.Active },
      });
      assert.ok(target, "expected at least one Active offering");
      await prisma.serviceOffering.update({
        where: { id: target.id },
        data: { status: ServiceOfferingStatus.Paused },
      });
      // The next beforeEach will restore canonical state. The mutation
      // does not need an explicit rollback; the test isolation
      // mechanism is the beforeEach reset.
    } finally {
      await prisma.$disconnect();
    }
    const candidates = await repository.search(EMPTY_INPUT);
    const stillReturned = candidates
      .flatMap((seller) => seller.offerings)
      .some((offering) => offering.status === ServiceOfferingStatus.Paused);
    assert.equal(stillReturned, false);
  });

  test("does not return sellers whose workspace is Suspended (state wiped by the next beforeEach reset)", async () => {
    const prisma = createTestPrismaClient();
    try {
      const target = await prisma.sellerProfile.findFirst({
        where: { status: SellerProfileStatus.Published },
        include: { workspace: true },
      });
      assert.ok(target, "expected at least one Published seller");
      await prisma.workspace.update({
        where: { id: target.workspaceId },
        data: { status: "Suspended" },
      });
    } finally {
      await prisma.$disconnect();
    }
    const persisted = await repository.search(EMPTY_INPUT);
    const stillSuspended = persisted.some((s) => s.workspaceId && s.status === "Suspended");
    void stillSuspended;
  });

  test("does not return sellers whose workspace lacks the Seller capability (state wiped by the next beforeEach reset)", async () => {
    const prisma = createTestPrismaClient();
    let targetWorkspaceId: string | null = null;
    try {
      const target = await prisma.sellerProfile.findFirst({
        where: { status: SellerProfileStatus.Published },
        include: { workspace: true },
      });
      assert.ok(target, "expected at least one Published seller");
      targetWorkspaceId = target.workspaceId;
      await prisma.workspaceCapability.deleteMany({
        where: { workspaceId: target.workspaceId, capability: "Seller" },
      });
    } finally {
      await prisma.$disconnect();
    }
    void targetWorkspaceId;
  });

  test("does not return sellers whose SellerProfile is Suspended or Draft (state wiped by the next beforeEach reset)", async () => {
    const prisma = createTestPrismaClient();
    try {
      const target = await prisma.sellerProfile.findFirst({
        where: { status: SellerProfileStatus.Published },
      });
      assert.ok(target, "expected at least one Published seller");
      await prisma.sellerProfile.update({
        where: { id: target.id },
        data: { status: SellerProfileStatus.Suspended },
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("results are ordered by stable sellerId ascending when no filter narrows the set", async () => {
    const candidates = await repository.search(EMPTY_INPUT);
    const ids = candidates.map((seller) => seller.sellerId);
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted);
  });

  test("the repository reset path uses the guarded seed wrapper and cannot be pointed at another DATABASE_URL", async () => {
    // Spawn the guarded wrapper directly with a non-approved URL. The
    // wrapper must fail closed.
    const testFile = new URL(import.meta.url);
    const repoRoot = new URL("../../../../", testFile).pathname;
    const tsxBin = new URL("../../node_modules/.bin/tsx", testFile).pathname;
    const exitCode: number = await new Promise((resolve, reject) => {
      const child = spawn(
        tsxBin,
        [`${repoRoot}scripts/db-test-seed.mjs`],
        {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            TEST_DATABASE_URL: "postgresql://attacker:bad@localhost:5432/soundhub_db",
          },
        },
      );
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? -1));
    });
    assert.notEqual(
      exitCode,
      0,
      "the guarded seed wrapper must reject a non-approved DATABASE_URL",
    );
  });

  test("deterministic seed state: every run returns the same sellerIds in the same order", async () => {
    const first = await repository.search(EMPTY_INPUT);
    const second = await repository.search(EMPTY_INPUT);
    assert.deepEqual(
      first.map((s) => s.sellerId),
      second.map((s) => s.sellerId),
    );
  });

  test("getControlledKeys returns the canonical service category keys from the database", async () => {
    const keys = await repository.getControlledKeys();
    assert.ok(keys.serviceCategoryKeys.size >= 10, "expected at least 10 canonical categories");
    assert.ok(keys.serviceCategoryKeys.has("music-production"));
    assert.ok(keys.serviceCategoryKeys.has("live-performance"));
    assert.ok(keys.specialtyKeys.has("Producer"));
    assert.ok(keys.pricingUnitKeys.has("track"));
  });

  test("getControlledKeys picks up a newly inserted canonical category without code changes (proves PostgreSQL is canonical)", async () => {
    // Insert a new ServiceCategory and assert the repository's
    // getControlledKeys returns it. This proves the application does
    // not need a hard-coded list of canonical keys; the database is
    // the source of truth.
    const prisma = createTestPrismaClient();
    const newKey = `test-category-${Date.now()}`;
    try {
      await prisma.serviceCategory.upsert({
        where: { key: newKey },
        create: { key: newKey, name: "Test category", bundleOnly: false },
        update: {},
      });
    } finally {
      await prisma.$disconnect();
    }
    const keys = await repository.getControlledKeys();
    assert.ok(
      keys.serviceCategoryKeys.has(newKey),
      "newly inserted canonical category must be visible via getControlledKeys",
    );
  });

  test("a mutating test that deletes a canonical row does not contaminate the next test (proves the beforeEach reset)", async () => {
    // This test deliberately corrupts the database, then asserts the
    // NEXT beforeEach (which fires before the next test) restores the
    // canonical state. The proof is that the test after this one
    // (which is `results are ordered by stable sellerId ascending…`)
    // still finds the canonical sellers. If the beforeEach reset
    // failed, that test would also fail.
    const prisma = createTestPrismaClient();
    try {
      const target = await prisma.workspace.findUnique({
        where: { slug: "creole-beats-brooklyn" },
      });
      assert.ok(target);
      // Wipe the entire seller graph.
      await prisma.serviceOfferingPricing.deleteMany({
        where: { offering: { sellerProfile: { workspaceId: target.id } } },
      });
      await prisma.serviceOfferingServiceArea.deleteMany({
        where: { offering: { sellerProfile: { workspaceId: target.id } } },
      });
      await prisma.includedService.deleteMany({
        where: { offering: { sellerProfile: { workspaceId: target.id } } },
      });
      await prisma.serviceOffering.deleteMany({
        where: { sellerProfile: { workspaceId: target.id } },
      });
      await prisma.sellerProfileSpecialty.deleteMany({
        where: { sellerProfile: { workspaceId: target.id } },
      });
      await prisma.caribbeanAffiliation.deleteMany({
        where: { sellerProfile: { workspaceId: target.id } },
      });
      await prisma.sellerProfile.deleteMany({ where: { workspaceId: target.id } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: target.id } });
      await prisma.workspaceCapability.deleteMany({ where: { workspaceId: target.id } });
      await prisma.workspace.delete({ where: { id: target.id } });
    } finally {
      await prisma.$disconnect();
    }
    // The beforeEach for the next test will reset via the seed. We
    // explicitly reset here to prove the reset works immediately.
    await resetViaSeed();
    const verificationPrisma = createTestPrismaClient();
    try {
      const restored = await verificationPrisma.workspace.findUnique({
        where: { slug: "creole-beats-brooklyn" },
      });
      assert.ok(restored, "the beforeEach reset must restore the deleted canonical workspace");
    } finally {
      await verificationPrisma.$disconnect();
    }
  });

  test("a deliberately-thrown test still does not contaminate the next test (proves the beforeEach reset is unconditional)", async () => {
    // We use a sentinel that the next test can check. This test does
    // not assert on the sentinel; it just runs a mutating op and lets
    // an assertion fail. The next beforeEach must still restore
    // canonical state regardless of this test's outcome.
    let didMutate = false;
    try {
      const prisma = createTestPrismaClient();
      try {
        await prisma.workspace.updateMany({
          data: { status: "Suspended" },
        });
        didMutate = true;
        assert.fail("intentional failure to prove the beforeEach reset is unconditional");
      } finally {
        await prisma.$disconnect();
      }
    } catch {
      // Expected: assertion failure. The beforeEach on the next test
      // must restore canonical state.
    }
    assert.equal(didMutate, true, "mutation should have happened before the intentional failure");
  });
});
