// Regression coverage for the M1.1 deterministic seed.
//
// These tests run against the disposable test database (TEST_DATABASE_URL)
// and use a local fail-closed exact-target guard. They prove that the
// seed restores canonical relationships and field values on every
// invocation, regardless of how the database was mutated between runs.
//
// Each test invokes the seed as a child process so the seed's
// `process.env.DATABASE_URL` requirement is satisfied cleanly.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";

const APPROVED_DATABASE = "soundhub_m1_test";
const APPROVED_PORT = 5433;
const APPROVED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

class TestGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestGuardError";
  }
}

function resolveDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new TestGuardError("TEST_DATABASE_URL is not set");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new TestGuardError(`invalid URL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TestGuardError(`not a postgres URL: ${parsed.protocol}`);
  }
  if (!APPROVED_HOSTS.has(parsed.hostname)) {
    throw new TestGuardError(`host ${parsed.hostname} is not an approved local host`);
  }
  if (Number(parsed.port || 5432) !== APPROVED_PORT) {
    throw new TestGuardError(`port ${parsed.port} must be ${APPROVED_PORT}`);
  }
  const database = parsed.pathname.replace(/^\/+/, "");
  if (database !== APPROVED_DATABASE) {
    throw new TestGuardError(`database ${database} must be ${APPROVED_DATABASE}`);
  }
  return url;
}

let prisma: PrismaClient;
let databaseUrl: string;

before(() => {
  databaseUrl = resolveDatabaseUrl();
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
});

after(async () => {
  await prisma.$disconnect();
});

function runSeed(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["tsx", "prisma/seed.ts"],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          TEST_DATABASE_URL: databaseUrl,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed exited with code ${code}`));
    });
  });
}

describe("M1.1 seed regression coverage", () => {
  test("restores Workspace.ownerUserId after a stale update", async () => {
    await runSeed();
    const workspace = await prisma.workspace.findUnique({
      where: { slug: "creole-beats-brooklyn" },
    });
    assert.ok(workspace);
    const owner = await prisma.userAccount.findUnique({
      where: { email: "marc.andre@creolebeats.example" },
    });
    const otherOwner = await prisma.userAccount.findUnique({
      where: { email: "keisha@kingsontosongs.example" },
    });
    assert.ok(owner);
    assert.ok(otherOwner);
    assert.notEqual(owner.id, otherOwner.id);

    // Mutate: point the workspace at a different existing user.
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { ownerUserId: otherOwner.id },
    });
    const corrupted = await prisma.workspace.findUnique({ where: { id: workspace.id } });
    assert.equal(corrupted?.ownerUserId, otherOwner.id);

    await runSeed();
    const restored = await prisma.workspace.findUnique({
      where: { slug: "creole-beats-brooklyn" },
    });
    assert.equal(restored?.ownerUserId, owner.id);
  });

  test("restores ServiceOffering.sellerProfileId after a stale update", async () => {
    await runSeed();
    const offering = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
    });
    const canonicalSeller = await prisma.sellerProfile.findUnique({
      where: { workspaceId: (await prisma.workspace.findUnique({ where: { slug: "creole-beats-brooklyn" } }))!.id },
    });
    assert.ok(offering);
    assert.ok(canonicalSeller);
    // Mutate: point the offering at a different seller profile.
    const otherSeller = await prisma.sellerProfile.findFirst({
      where: { id: { not: canonicalSeller.id } },
    });
    if (!otherSeller) {
      throw new Error("Expected at least two seller profiles in the seed");
    }
    await prisma.serviceOffering.update({
      where: { id: offering.id },
      data: { sellerProfileId: otherSeller.id },
    });

    await runSeed();
    const restored = await prisma.serviceOffering.findUnique({
      where: { id: offering.id },
    });
    assert.equal(restored?.sellerProfileId, canonicalSeller.id);
  });

  test("restores Workspace.status after it is set to Suspended", async () => {
    await runSeed();
    const workspace = await prisma.workspace.findUnique({
      where: { slug: "creole-beats-brooklyn" },
    });
    assert.ok(workspace);
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: "Suspended" },
    });
    await runSeed();
    const restored = await prisma.workspace.findUnique({ where: { id: workspace.id } });
    assert.equal(restored?.status, "Active");
  });

  test("restores SellerProfile.status after it is set to Draft", async () => {
    await runSeed();
    const profile = await prisma.sellerProfile.findFirst({
      where: { professionalName: "Marc-André Pierre" },
    });
    assert.ok(profile);
    await prisma.sellerProfile.update({
      where: { id: profile.id },
      data: { status: "Draft" },
    });
    await runSeed();
    const restored = await prisma.sellerProfile.findUnique({ where: { id: profile.id } });
    assert.equal(restored?.status, "Published");
  });

  test("restores ServiceOffering.status after it is set to Paused", async () => {
    await runSeed();
    const offering = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
    });
    assert.ok(offering);
    await prisma.serviceOffering.update({
      where: { id: offering.id },
      data: { status: "Paused" },
    });
    await runSeed();
    const restored = await prisma.serviceOffering.findUnique({ where: { id: offering.id } });
    assert.equal(restored?.status, "Active");
  });

  test("restores ServiceOffering.primaryCategoryId after a stale update", async () => {
    await runSeed();
    const offering = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
      include: { primaryCategory: true },
    });
    assert.ok(offering);
    const otherCategory = await prisma.serviceCategory.findFirst({
      where: { key: { not: offering.primaryCategory.key } },
    });
    assert.ok(otherCategory);
    await prisma.serviceOffering.update({
      where: { id: offering.id },
      data: { primaryCategoryId: otherCategory.id },
    });
    await runSeed();
    const restored = await prisma.serviceOffering.findUnique({
      where: { id: offering.id },
      include: { primaryCategory: true },
    });
    assert.equal(restored?.primaryCategory.key, "music-production");
  });

  test("recreates a deleted canonical Workspace and all of its graph", async () => {
    await runSeed();
    const workspace = await prisma.workspace.findUnique({
      where: { slug: "creole-beats-brooklyn" },
      include: {
        sellerProfile: { include: { offerings: true, caribbeanAffiliations: true, specialties: true } },
        memberships: true,
        capabilities: true,
      },
    });
    assert.ok(workspace);
    const memberships = workspace.memberships;
    const capabilities = workspace.capabilities;
    const profileId = workspace.sellerProfile?.id;
    const offeringIds = (workspace.sellerProfile?.offerings ?? []).map((o) => o.id);
    assert.ok(profileId);

    // Wipe the seller and its entire graph.
    await prisma.serviceOfferingPricing.deleteMany({
      where: { offeringId: { in: offeringIds } },
    });
    await prisma.serviceOfferingServiceArea.deleteMany({
      where: { offeringId: { in: offeringIds } },
    });
    await prisma.includedService.deleteMany({ where: { offeringId: { in: offeringIds } } });
    await prisma.serviceOffering.deleteMany({ where: { id: { in: offeringIds } } });
    await prisma.sellerProfileSpecialty.deleteMany({ where: { sellerProfileId: profileId } });
    await prisma.caribbeanAffiliation.deleteMany({ where: { sellerProfileId: profileId } });
    await prisma.sellerProfile.delete({ where: { id: profileId } });
    for (const m of memberships) {
      await prisma.workspaceMembership.delete({ where: { id: m.id } });
    }
    for (const c of capabilities) {
      await prisma.workspaceCapability.delete({ where: { id: c.id } });
    }
    await prisma.workspace.delete({ where: { id: workspace.id } });

    await runSeed();

    const restored = await prisma.workspace.findUnique({
      where: { slug: "creole-beats-brooklyn" },
      include: {
        sellerProfile: { include: { offerings: true, caribbeanAffiliations: true, specialties: true } },
        memberships: true,
        capabilities: true,
      },
    });
    assert.ok(restored);
    assert.equal(restored.status, "Active");
    assert.equal(restored.sellerProfile?.status, "Published");
    assert.equal(restored.sellerProfile?.offerings.length, 1);
    assert.equal(restored.memberships.length, 1);
    assert.equal(restored.memberships[0]?.role, "Owner");
    assert.equal(restored.capabilities.length, 1);
    assert.equal(restored.capabilities[0]?.capability, "Seller");
  });

  test("recreates a deleted canonical ServiceCategory referenced by an offering", async () => {
    await runSeed();
    const category = await prisma.serviceCategory.findUnique({ where: { key: "music-production" } });
    assert.ok(category);
    const offering = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
    });
    assert.ok(offering);
    // Move the offering to a different category before deleting the original.
    const other = await prisma.serviceCategory.findFirst({
      where: { key: { not: "music-production" } },
    });
    assert.ok(other);
    await prisma.serviceOffering.update({
      where: { id: offering.id },
      data: { primaryCategoryId: other.id },
    });
    await prisma.serviceCategory.delete({ where: { key: "music-production" } });

    await runSeed();
    const restored = await prisma.serviceCategory.findUnique({ where: { key: "music-production" } });
    assert.ok(restored);
    const restoredOffering = await prisma.serviceOffering.findUnique({
      where: { id: offering.id },
      include: { primaryCategory: true },
    });
    assert.equal(restoredOffering?.primaryCategory.key, "music-production");
  });

  test("replaces a stale Caribbean affiliation membership set with the canonical set", async () => {
    await runSeed();
    const profile = await prisma.sellerProfile.findFirst({
      where: { professionalName: "Marc-André Pierre" },
    });
    assert.ok(profile);
    await prisma.caribbeanAffiliation.deleteMany({ where: { sellerProfileId: profile.id } });
    await prisma.caribbeanAffiliation.create({
      data: { sellerProfileId: profile.id, countryCode: "ZZ" },
    });

    await runSeed();
    const restored = await prisma.caribbeanAffiliation.findMany({
      where: { sellerProfileId: profile.id },
      orderBy: { countryCode: "asc" },
    });
    assert.deepEqual(
      restored.map((a) => a.countryCode),
      ["HT"],
    );
  });

  test("does not delete a non-canonical row outside the seed scope", async () => {
    await runSeed();
    // Insert a non-canonical category that the seed does not own.
    const nonCanonical = await prisma.serviceCategory.upsert({
      where: { key: "test-out-of-scope" },
      create: { key: "test-out-of-scope", name: "Out of scope", bundleOnly: false },
      update: {},
    });
    await runSeed();
    const after = await prisma.serviceCategory.findUnique({
      where: { key: "test-out-of-scope" },
    });
    assert.ok(after, "seed must not delete a non-canonical row");
    assert.equal(after.id, nonCanonical.id);
    await prisma.serviceCategory.delete({ where: { id: nonCanonical.id } });
  });
});
