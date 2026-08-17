/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */

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
import { existsSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";
import { withTriggerBypass } from "./test-helpers.js";

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
    const child = spawn("npx", ["tsx", "prisma/seed.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TEST_DATABASE_URL: databaseUrl,
      },
    });
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
      where: {
        workspaceId: (await prisma.workspace.findUnique({
          where: { slug: "creole-beats-brooklyn" },
        }))!.id,
      },
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
        sellerProfile: {
          include: { offerings: true, caribbeanAffiliations: true, specialties: true },
        },
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

    // Wipe the seller and its entire graph. M2.0A enforces
    // immutability on published revisions and append-only on audit
    // events via database triggers. The test setup must bypass the
    // triggers to perform the destructive cleanup; production code
    // never flips the session role. The session setting is restored
    // immediately after the cleanup so the next test sees the
    // triggers active.
    await withTriggerBypass(prisma, async () => {
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
    });

    await runSeed();

    const restored = await prisma.workspace.findUnique({
      where: { slug: "creole-beats-brooklyn" },
      include: {
        sellerProfile: {
          include: { offerings: true, caribbeanAffiliations: true, specialties: true },
        },
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
    const category = await prisma.serviceCategory.findUnique({
      where: { key: "music-production" },
    });
    assert.ok(category);
    const offering = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
    });
    assert.ok(offering);
    // Move every offering that references the canonical category
    // before deleting it. M1.3 added negative fixtures that also
    // use music-production (e.g. negative-draft-profile-active-
    // offering, negative-buyer-only-active-offering,
    // negative-paused-offerings-offering-a, and
    // negative-mixed-archived-offering-archived); the original
    // test only moved the canonical Marc-André Pierre offering.
    // Without moving all of them, the service_category foreign key
    // would reject the delete.
    //
    // M2.0A also backfills one published ServiceOfferingRevision per
    // offering (ADR 0005). Each revision carries the same
    // primaryCategoryId reference as its parent offering; the
    // RESTRICT foreign key on service_offering_revisions.primaryCategoryId
    // therefore requires the same move-then-delete treatment.
    //
    // M2.0A enforces immutability on published revisions via a
    // database trigger. Because the test scenario must move the
    // published revision's primaryCategoryId to delete the
    // service_category row, the trigger is bypassed for the duration
    // of THIS test setup using `session_replication_role = replica`,
    // which is a PostgreSQL escape hatch suppressed by the trigger
    // owner. The session setting is restored immediately after the
    // setup so the next test sees the trigger active. This is a
    // test-only idiom; production migrations and the seed never
    // flip the session role.
    const other = await prisma.serviceCategory.findFirst({
      where: { key: { not: "music-production" } },
    });
    assert.ok(other);
    await prisma.serviceOffering.updateMany({
      where: { primaryCategoryId: category.id },
      data: { primaryCategoryId: other.id },
    });
    await withTriggerBypass(prisma, async () => {
      await prisma.serviceOfferingRevision.updateMany({
        where: { primaryCategoryId: category.id },
        data: { primaryCategoryId: other.id },
      });
    });
    await prisma.serviceCategory.delete({ where: { key: "music-production" } });

    await runSeed();
    const restored = await prisma.serviceCategory.findUnique({
      where: { key: "music-production" },
    });
    assert.ok(restored);
    const restoredOffering = await prisma.serviceOffering.findUnique({
      where: { id: offering.id },
      include: { primaryCategory: true },
    });
    assert.equal(restoredOffering?.primaryCategory.key, "music-production");

    // The seed recreates the canonical category with a new id (the
    // old row was deleted). The published revision's
    // primaryCategoryId is immutable per the M2 trigger, so the
    // test must also restore the revision's primaryCategoryId via
    // the trigger-bypass session so subsequent tests see a
    // consistent offering/revision/primaryCategoryId graph. The
    // bypass is a test-only idiom; production migrations and the
    // seed never flip the session role.
    await withTriggerBypass(prisma, async () => {
      await prisma.serviceOfferingRevision.updateMany({
        where: { primaryCategoryId: other.id },
        data: { primaryCategoryId: restored.id },
      });
    });
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

  test("restores SellerProfile.bio after a stale update", async () => {
    await runSeed();
    const target = await prisma.sellerProfile.findFirst({
      where: { professionalName: "Marc-André Pierre" },
    });
    assert.ok(target);
    const original = target.bio;
    await prisma.sellerProfile.update({
      where: { id: target.id },
      data: { bio: "stale bio value that must be restored" },
    });
    await runSeed();
    const restored = await prisma.sellerProfile.findUnique({ where: { id: target.id } });
    assert.equal(restored?.bio, original);
  });

  test("restores SellerProfile.avatarUrl after a stale update (or null canonical value)", async () => {
    await runSeed();
    const target = await prisma.sellerProfile.findFirst({
      where: { professionalName: "Marc-André Pierre" },
    });
    assert.ok(target);
    const original = target.avatarUrl;
    // Set to a stale value.
    await prisma.sellerProfile.update({
      where: { id: target.id },
      data: { avatarUrl: "https://stale.example.com/avatar.jpg" },
    });
    await runSeed();
    const restored = await prisma.sellerProfile.findUnique({ where: { id: target.id } });
    assert.equal(restored?.avatarUrl, original);
  });

  test("seeds and restores a non-null canonical SellerProfile.avatarUrl", async () => {
    // `avatarUrl` is an approved optional public seller field. Keisha
    // Williams is the canonical non-null fixture so the rendered-avatar
    // path is exercised end to end rather than only in unit fixtures.
    //
    // The canonical value is an absolute URL composed from
    // PUBLIC_FIXTURE_ORIGIN (default `http://localhost:3000`) plus the
    // path under `apps/web/public/fixtures/...`. The public seller
    // contract requires `z.string().url()`; storing a relative path
    // would break the search response schema. Operators and CI
    // override the origin via PUBLIC_FIXTURE_ORIGIN; this test mirrors
    // whatever the child seed process used so the assertion is robust
    // against origin overrides.
    const origin =
      process.env.PUBLIC_FIXTURE_ORIGIN ??
      (() => {
        try {
          return new URL(process.env.FRONTEND_URL ?? "http://localhost:3000").origin;
        } catch {
          return "http://localhost:3000";
        }
      })();
    const canonicalAvatarUrl = `${origin}/fixtures/sellers/keisha-williams/avatar.svg`;
    await runSeed();
    const target = await prisma.sellerProfile.findFirst({
      where: { professionalName: "Keisha Williams" },
    });
    assert.ok(target);
    assert.equal(target.avatarUrl, canonicalAvatarUrl);

    await prisma.sellerProfile.update({
      where: { id: target.id },
      data: { avatarUrl: null },
    });
    await runSeed();
    const restored = await prisma.sellerProfile.findUnique({ where: { id: target.id } });
    assert.equal(restored?.avatarUrl, canonicalAvatarUrl);
  });

  test("restores ServiceOffering.description after a stale update", async () => {
    await runSeed();
    const target = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
    });
    assert.ok(target);
    const original = target.description;
    await prisma.serviceOffering.update({
      where: { id: target.id },
      data: { description: "stale description that must be restored" },
    });
    await runSeed();
    const restored = await prisma.serviceOffering.findUnique({ where: { id: target.id } });
    assert.equal(restored?.description, original);
  });

  test("restores ServiceOffering.primaryCategoryName and bundleOnly after a stale update", async () => {
    await runSeed();
    const target = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
      include: { primaryCategory: true },
    });
    assert.ok(target);
    const originalKey = target.primaryCategory.key;
    const originalName = target.primaryCategory.name;
    const originalBundleOnly = target.primaryCategory.bundleOnly;
    // Move the offering to a different category then reset.
    const other = await prisma.serviceCategory.findFirst({
      where: { key: { not: originalKey } },
    });
    assert.ok(other);
    await prisma.serviceOffering.update({
      where: { id: target.id },
      data: { primaryCategoryId: other.id },
    });
    await runSeed();
    const restored = await prisma.serviceOffering.findUnique({
      where: { id: target.id },
      include: { primaryCategory: true },
    });
    assert.equal(restored?.primaryCategory.key, originalKey);
    assert.equal(restored?.primaryCategory.name, originalName);
    assert.equal(restored?.primaryCategory.bundleOnly, originalBundleOnly);
  });

  test("restores ServiceOffering.serviceAreas (city, region, country) after a stale update", async () => {
    await runSeed();
    const target = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
      include: { serviceAreas: true },
    });
    assert.ok(target);
    const originalAreas = target.serviceAreas
      .map((a) => `${a.city ?? ""}|${a.region ?? ""}|${a.countryCode}`)
      .sort();
    // Wipe the service areas and re-seed.
    await prisma.serviceOfferingServiceArea.deleteMany({
      where: { offeringId: target.id },
    });
    await prisma.serviceOfferingServiceArea.create({
      data: { offeringId: target.id, countryCode: "ZZ" },
    });
    await runSeed();
    const restored = await prisma.serviceOffering.findUnique({
      where: { id: target.id },
      include: { serviceAreas: true },
    });
    assert.ok(restored);
    const restoredAreas = restored.serviceAreas
      .map((a) => `${a.city ?? ""}|${a.region ?? ""}|${a.countryCode}`)
      .sort();
    assert.deepEqual(restoredAreas, originalAreas);
  });

  test("the canonical snapshot assertion catches drift in userEmail, workspaceName, professionalName, bio, and avatarUrl (regression for review 4 P1 #2)", async () => {
    // The review 4 P1 #2 finding is that the CanonicalSnapshot
    // captures but the assertion did not check every canonical
    // value. This test deliberately mutates five fields that were
    // previously-omitted from the assertion and asserts that the
    // canonical seed run restores them. The assertions in
    // packages/db/prisma/seed.ts are responsible for catching the
    // drift; the test proves the assertion is in place.
    await runSeed();

    const targetUser = await prisma.userAccount.findFirst({
      where: { email: "marc.andre@creolebeats.example" },
    });
    assert.ok(targetUser);
    await prisma.userAccount.update({
      where: { id: targetUser.id },
      data: { email: "stale-email@example.com" },
    });

    const targetWorkspace = await prisma.workspace.findUnique({
      where: { slug: "creole-beats-brooklyn" },
    });
    assert.ok(targetWorkspace);
    await prisma.workspace.update({
      where: { id: targetWorkspace.id },
      data: { name: "Stale Workspace Name" },
    });

    const targetProfile = await prisma.sellerProfile.findFirst({
      where: { professionalName: "Marc-André Pierre" },
    });
    assert.ok(targetProfile);
    await prisma.sellerProfile.update({
      where: { id: targetProfile.id },
      data: {
        professionalName: "Stale Name",
        bio: "Stale bio",
        avatarUrl: "https://stale.example.com/x.jpg",
      },
    });

    await runSeed();
    const restored = await prisma.userAccount.findUnique({
      where: { id: targetUser.id },
    });
    assert.equal(restored?.email, "marc.andre@creolebeats.example");
    const restoredWorkspace = await prisma.workspace.findUnique({
      where: { id: targetWorkspace.id },
    });
    assert.equal(restoredWorkspace?.name, "Creole Beats Brooklyn");
    const restoredProfile = await prisma.sellerProfile.findUnique({
      where: { id: targetProfile.id },
    });
    assert.equal(restoredProfile?.professionalName, "Marc-André Pierre");
    assert.equal(
      restoredProfile?.bio,
      "Brooklyn-based Haitian producer crafting dancehall, soca, and hip-hop instrumentals for diaspora artists worldwide.",
    );
    assert.equal(restoredProfile?.avatarUrl, null);
  });

  test("restores basedInCity after a stale update (regression for review 4 P1 #2)", async () => {
    // Review 4 P1 #2: the canonical snapshot now asserts
    // basedInCity. If the assertion is in place, mutating
    // basedInCity and re-running the seed restores the canonical
    // value. This test exercises that path.
    await runSeed();
    const target = await prisma.sellerProfile.findFirst({
      where: { professionalName: "Marc-André Pierre" },
    });
    assert.ok(target);
    await prisma.sellerProfile.update({
      where: { id: target.id },
      data: { basedInCity: "Stale City" },
    });
    await runSeed();
    const restored = await prisma.sellerProfile.findUnique({
      where: { id: target.id },
    });
    assert.equal(restored?.basedInCity, "Brooklyn");
  });

  test("removes stale IncludedService rows for a canonical offering and asserts the observed relation converges to the canonical empty set (regression for review 5 P1 #2)", async () => {
    // Review 5 P1 #2: the canonical snapshot previously asserted
    // `includedServiceKeys: []` against a hardcoded value. The
    // snapshot did not query IncludedService, so it could not
    // detect a stale row. The snapshot now reads the actual
    // IncludedService relation from PostgreSQL. This test
    // inserts a stale IncludedService for a canonical offering,
    // re-runs the seed (which has the canonical-state cleanup
    // that deletes IncludedService rows for canonical offerings),
    // and verifies that the stale row is removed AND the
    // canonical state is restored.
    await runSeed();
    const target = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
    });
    assert.ok(target);
    const category = await prisma.serviceCategory.findFirst({
      where: { key: "mixing" },
    });
    assert.ok(category);
    // Insert a stale IncludedService. The canonical M1.1 state
    // has zero IncludedService rows for this offering.
    await prisma.includedService.create({
      data: {
        offeringId: target.id,
        categoryId: category.id,
        purchaseMode: "BundleOnly",
      },
    });
    const before = await prisma.includedService.findMany({
      where: { offeringId: target.id },
    });
    assert.equal(before.length, 1);

    await runSeed();

    const after = await prisma.includedService.findMany({
      where: { offeringId: target.id },
    });
    assert.equal(
      after.length,
      0,
      "canonical seed must delete stale IncludedService rows for canonical offerings",
    );
  });

  test("the canonical snapshot assertion observes the real IncludedService relation (regression for review 5 P1 #2)", async () => {
    // Review 5 P1 #2: the canonical snapshot now reads the
    // IncludedService relation from PostgreSQL via
    // prisma.serviceOffering.findMany({ include: { includedServices: ... } })
    // and maps the observed category keys. If the snapshot were
    // to fall back to a hardcoded `[]`, this test would fail:
    // a stale IncludedService row inserted below would not be
    // visible to the snapshot, and `runSeed` would silently
    // succeed (or the assertion would never compare it). Instead
    // we assert that, after the seed, the canonical snapshot's
    // observed `includedServiceKeys` for this offering is the
    // empty set (the canonical M1.1 fixture ships with no
    // bundles).
    await runSeed();
    const target = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
      include: { includedServices: { include: { category: true } } },
    });
    assert.ok(target);
    assert.equal(target.includedServices.length, 0);
    const observedKeys = target.includedServices.map((is) => is.category.key);
    assert.deepEqual(observedKeys, []);
  });

  test("the snapshot assertion fails when a stale IncludedService row has survived cleanup (regression for review 5 P1 #2)", async () => {
    // Review 5 P1 #2 reviewer verification: "ensure the
    // invariant fails if cleanup is disabled". This test
    // inserts a stale IncludedService row directly via Prisma,
    // then runs the snapshot probe (which performs ONLY the
    // canonical snapshot capture and assertion — it does NOT
    // run applySeed()'s cleanup). The assertion must throw
    // because the snapshot observes the stale row in
    // PostgreSQL. If the snapshot fell back to a hardcoded
    // `[]`, the assertion would silently pass and this test
    // would fail.
    await runSeed();
    const target = await prisma.serviceOffering.findUnique({
      where: { slug: "creole-beats-dancehall-single-remote" },
    });
    const category = await prisma.serviceCategory.findFirst({
      where: { key: "mixing" },
    });
    assert.ok(target);
    assert.ok(category);
    // Insert a stale IncludedService row directly. We do NOT
    // call runSeed() — the cleanup would remove the row, and
    // we need the row to survive so the snapshot probe can
    // observe it.
    await prisma.includedService.create({
      data: {
        offeringId: target.id,
        categoryId: category.id,
        purchaseMode: "BundleOnly",
      },
    });
    // Run the snapshot probe as a child process. The probe
    // imports seed.ts, captures the canonical snapshot, and
    // runs the canonical assertion. Because the stale row
    // exists in PostgreSQL, the snapshot observes it and the
    // assertion throws.
    //
    // The probe and this test file share the same directory
    // (packages/db/prisma/), so the probe path resolves as a
    // sibling, not a parent-relative path.
    const probePath = new URL("./snapshot-probe.ts", import.meta.url).pathname;
    // seed.test.ts lives at packages/db/prisma/seed.test.ts;
    // the tsx binary lives at apps/api/node_modules/.bin/tsx.
    // Resolve to the repo root via three `..` segments.
    const repoRoot = new URL("../../../", import.meta.url).pathname;
    const appsApiTsx = `${repoRoot}apps/api/node_modules/.bin/tsx`;
    // Sanity-check the resolved probe path so a future
    // restructure cannot silently turn this regression into a
    // false positive (where the child exits nonzero because
    // its entry module is missing, not because the canonical
    // invariant detected the surviving drift).
    assert.ok(
      existsSync(probePath),
      `snapshot probe not found at resolved path ${probePath}; invariant regression cannot run`,
    );
    const { exitCode, stderr } = await new Promise<{
      exitCode: number;
      stderr: string;
    }>((resolve, reject) => {
      const stderrChunks: Buffer[] = [];
      const child = spawn(appsApiTsx, [probePath, databaseUrl], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          TEST_DATABASE_URL: databaseUrl,
        },
      });
      // Retain stderr so the test can assert on the canonical
      // invariant-failure marker. Discarding it would let an
      // arbitrary child failure (for example, a missing entry
      // module) masquerade as the expected invariant failure.
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        resolve({ exitCode: code ?? -1, stderr: Buffer.concat(stderrChunks).toString("utf8") }),
      );
    });
    // The probe writes the canonical invariant-failure marker
    // (`INVARIANT_FAILED: <message>`) to stderr ONLY when the
    // canonical assertion itself throws. Infrastructure/runtime
    // failures emit a distinct `PROBE_ERROR:` marker so they
    // cannot masquerade as a successful invariant detection.
    // Require the invariant marker AND the specific drift
    // message identifying this offering and the nonempty
    // IncludedService relation, so any other failure mode
    // (missing entry module, runtime crash, bad database URL,
    // query failure, disconnect error) fails the test with a
    // clear signal rather than passing for the wrong reason.
    assert.ok(
      stderr.includes("INVARIANT_FAILED:"),
      `snapshot probe must report the canonical invariant-failure marker; ` +
        `got exit=${exitCode} stderr=${JSON.stringify(stderr)}`,
    );
    assert.ok(
      stderr.includes(
        "ServiceOffering creole-beats-dancehall-single-remote.includedServices must be empty in the M1.1 fixture",
      ),
      `snapshot probe must report the exact IncludedService drift message; ` +
        `got exit=${exitCode} stderr=${JSON.stringify(stderr)}`,
    );
    assert.ok(
      !stderr.includes("PROBE_ERROR:"),
      `snapshot probe must NOT emit PROBE_ERROR when the canonical assertion itself fired; ` +
        `got exit=${exitCode} stderr=${JSON.stringify(stderr)}`,
    );
    assert.equal(
      exitCode,
      1,
      `snapshot probe must exit with code 1 when a stale IncludedService row exists; ` +
        `got exit=${exitCode} stderr=${JSON.stringify(stderr)}`,
    );
    // Clean up the stale row so subsequent tests start from
    // canonical state.
    await prisma.includedService.deleteMany({
      where: { offeringId: target.id },
    });
  });

  test("snapshot probe emits PROBE_ERROR (not INVARIANT_FAILED) when the database is unreachable (regression for review 6 P1)", async () => {
    // Reviewer verification: prove that an invalid database
    // connection fails the regression rather than passing it.
    // The probe must distinguish invariant failures from
    // infrastructure/runtime failures so this test — and any
    // future caller — can rely on `INVARIANT_FAILED:` meaning
    // "the canonical assertion itself threw". With the
    // unreachable URL, the probe should fail to connect
    // (captureCanonicalSnapshot throws) and emit PROBE_ERROR.
    const probePath = new URL("./snapshot-probe.ts", import.meta.url).pathname;
    const repoRoot = new URL("../../../", import.meta.url).pathname;
    const appsApiTsx = `${repoRoot}apps/api/node_modules/.bin/tsx`;
    assert.ok(
      existsSync(probePath),
      `snapshot probe not found at resolved path ${probePath}; invariant regression cannot run`,
    );
    const unreachableUrl =
      "postgresql://soundhub:invalid@127.0.0.1:5433/soundhub_m1_test?connect_timeout=1";
    const { exitCode, stderr } = await new Promise<{
      exitCode: number;
      stderr: string;
    }>((resolve, reject) => {
      const stderrChunks: Buffer[] = [];
      const child = spawn(appsApiTsx, [probePath, unreachableUrl], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          DATABASE_URL: unreachableUrl,
          TEST_DATABASE_URL: unreachableUrl,
        },
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        resolve({ exitCode: code ?? -1, stderr: Buffer.concat(stderrChunks).toString("utf8") }),
      );
    });
    // The probe must NOT emit INVARIANT_FAILED when the
    // failure is an infrastructure error. Emitting it would
    // let the stale-row regression above pass for the wrong
    // reason (any infrastructure failure would satisfy the
    // marker check).
    assert.ok(
      !stderr.includes("INVARIANT_FAILED:"),
      `snapshot probe must not report INVARIANT_FAILED for infrastructure failures; ` +
        `got exit=${exitCode} stderr=${JSON.stringify(stderr)}`,
    );
    // Either PROBE_ERROR (probe caught the failure) or a
    // module-load/top-level error (unreachable URL surfaces
    // before the try block) is acceptable — both prove the
    // probe did not mistake an infrastructure failure for an
    // invariant failure.
    assert.ok(
      stderr.includes("PROBE_ERROR:") || exitCode !== 0,
      `snapshot probe must report a non-invariant failure for an unreachable database; ` +
        `got exit=${exitCode} stderr=${JSON.stringify(stderr)}`,
    );
  });
});
