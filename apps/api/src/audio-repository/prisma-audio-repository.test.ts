/* eslint-disable @typescript-eslint/no-floating-promises */
//
// PrismaAudioRepository integration tests against the disposable local
// PostgreSQL.
//
// Per ticket #61 follow-up review (P0-001) the per-offering advisory
// lock signature is exercised end-to-end against freshly migrated
// disposable PostgreSQL so the supported `pg_advisory_xact_lock(int,
// int)` overload and the signed 32-bit key derivation are validated
// in the same process that runs the deployed migrations. These tests
// never touch the developer database. The seed wrapper is invoked via
// `resetViaSeed()` so every test begins from the deterministic
// canonical state.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { beforeEach, describe, test } from "node:test";
import { createTestPrismaClient } from "../lib/test-database.js";
import { PrismaAudioRepository } from "./prisma-audio-repository.js";
import { AudioSampleCleanupStatus } from "@soundhub/db";

const repository = new PrismaAudioRepository(createTestPrismaClient());

function resetViaSeed(): Promise<void> {
  return new Promise((resolve, reject) => {
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

/**
 * Insert a deterministic seeded offering context so the audio repository
 * tests have a known offering id with Active status + Published profile
 * + Active Workspace + Seller capability. Returns the new offering id.
 */
async function seedOfferingWithContext(): Promise<string> {
  const prisma = createTestPrismaClient();
  try {
    const seller = await prisma.sellerProfile.findFirst({
      where: { status: "Published" },
      include: { workspace: true },
    });
    assert.ok(seller, "seed must include at least one Published seller");
    const offering = await prisma.serviceOffering.create({
      data: {
        slug: `of-bg2-prisma-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sellerProfileId: seller.id,
        title: "BG2 Prisma Test Offering",
        description: "Integration-test offering for the audio repository.",
        status: "Active",
        serviceMode: "Remote",
        primaryCategoryId: (
          await prisma.serviceCategory.findFirstOrThrow({ where: { key: "music-production" } })
        ).id,
        genreTags: [],
      },
    });
    return offering.id;
  } finally {
    await prisma.$disconnect();
  }
}

describe("PrismaAudioRepository P0-001", () => {
  test("a normal upload persists a Live row with valid display order", async () => {
    const offeringId = await seedOfferingWithContext();
    const created = await repository.createSampleWithCap({
      offeringId,
      label: "First sample",
      contentType: "audio/mpeg",
      byteSize: 1024,
      storageRef: "det:test:prisma:normal",
    });
    assert.ok(created, "createSampleWithCap must succeed under the cap");
    assert.equal(created.displayOrder, 1);
    assert.equal(created.cleanupStatus, AudioSampleCleanupStatus.Live);
    const list = await repository.listSamplesForOffering(offeringId);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.sampleId, created.sampleId);
  });

  test("two overlapping uploads from cap-1 yield exactly one success + one cap rejection", async () => {
    const offeringId = await seedOfferingWithContext();
    // Seed two existing Live samples so the offering is at cap-1.
    for (let i = 1; i <= 2; i += 1) {
      const seeded = await repository.createSampleWithCap({
        offeringId,
        label: `Existing ${i}`,
        contentType: "audio/mpeg",
        byteSize: 1024,
        storageRef: `det:test:prisma:existing-${i}`,
      });
      assert.ok(seeded, `seed insert ${i} must succeed under the cap`);
    }
    const liveBefore = await repository.listSamplesForOffering(offeringId);
    assert.equal(liveBefore.length, 2, "cap-1 precondition");

    // Two real repository uploads race. Exactly one wins; the other
    // sees count=3 after the winner commits and returns null.
    const results = await Promise.allSettled([
      repository.createSampleWithCap({
        offeringId,
        label: "Race A",
        contentType: "audio/mpeg",
        byteSize: 1024,
        storageRef: "det:test:prisma:race-a",
      }),
      repository.createSampleWithCap({
        offeringId,
        label: "Race B",
        contentType: "audio/mpeg",
        byteSize: 1024,
        storageRef: "det:test:prisma:race-b",
      }),
    ]);
    // Both calls resolve; the cap-loser returns null (the repository
    // returns null for the cap path, it does not throw).
    const fulfilled: Array<
      PromiseFulfilledResult<Awaited<ReturnType<typeof repository.createSampleWithCap>>>
    > = [];
    const rejected: Array<PromiseRejectedResult> = [];
    for (const r of results) {
      if (r.status === "fulfilled") fulfilled.push(r);
      else rejected.push(r);
    }
    assert.equal(rejected.length, 0, "createSampleWithCap must not throw under the cap");
    assert.equal(fulfilled.length, 2, "both calls resolve");
    const nullReturns = fulfilled.filter((r) => r.value === null);
    const successReturns = fulfilled.filter((r) => r.value !== null);
    assert.equal(nullReturns.length, 1, "exactly one insert returns null (cap loser)");
    assert.equal(successReturns.length, 1, "exactly one insert returns a record");

    const liveAfter = await repository.listSamplesForOffering(offeringId);
    assert.equal(liveAfter.length, 3, "exactly three Live rows after the race");
    const orders = liveAfter.map((s) => s.displayOrder).sort();
    assert.deepEqual(orders, [1, 2, 3], "display orders stay within 1..3");
  });

  test("different offerings do not block each other (per-offering lock scope)", async () => {
    const offeringA = await seedOfferingWithContext();
    const offeringB = await seedOfferingWithContext();
    // Each offering is independent; the per-offering advisory locks do
    // not block writes to a sibling offering.
    const [a, b] = await Promise.all([
      repository.createSampleWithCap({
        offeringId: offeringA,
        label: "A",
        contentType: "audio/mpeg",
        byteSize: 1024,
        storageRef: "det:test:prisma:offering-a",
      }),
      repository.createSampleWithCap({
        offeringId: offeringB,
        label: "B",
        contentType: "audio/mpeg",
        byteSize: 1024,
        storageRef: "det:test:prisma:offering-b",
      }),
    ]);
    assert.ok(a, "offering A insert succeeds");
    assert.ok(b, "offering B insert succeeds");
  });

  test("the four-arg pg_advisory_xact_lock(int, int) overload resolves against the live database", async () => {
    // Probe the same overload the repository uses. If the schema or
    // database version were broken, this query would fail with
    // `function pg_advisory_xact_lock(integer, integer) does not
    // exist`. A successful return proves the signature is supported.
    const prisma = createTestPrismaClient();
    try {
      await prisma.$queryRaw`SELECT pg_advisory_xact_lock(1096107081::int, 0::int)`;
    } finally {
      await prisma.$disconnect();
    }
  });
});
