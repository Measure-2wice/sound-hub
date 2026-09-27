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
// never touch the developer database.
//
// Per ticket #61 follow-up review (P1-002) every test cleans up its
// own test-created rows BEFORE the canonical seed reset runs in
// `beforeEach`. The canonical seed asserts a closed count of
// offerings per seller; without cleanup the second test sees the
// offering the first test added and the canonical snapshot
// diverges from the expected count, failing the suite. Cleanup
// deletes every offering whose slug starts with the test prefix,
// along with the audio samples and orphan locators those offerings
// own. This guarantees the next reset runs against the same
// canonical state every time.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createTestPrismaClient } from "../lib/test-database.js";
import { PrismaAudioRepository } from "./prisma-audio-repository.js";
import { PrismaServiceOfferingRepository } from "../repositories/prisma-service-offering.repository.js";
import {
  AUDIO_SAMPLE_LOCK_CLASS,
  acquireAudioSampleLockTx,
  audioSampleLockKey,
} from "./audio-sample-lock.js";
import { AudioSampleCleanupStatus } from "@soundhub/db";

const repository = new PrismaAudioRepository(createTestPrismaClient());

const TEST_SLUG_PREFIX = "of-bg2-prisma-";

/**
 * Clean up every test-created offering (and its dependent audio
 * samples + orphan locators) so the canonical seed reset can run
 * against the deterministic snapshot. Without this the canonical
 * count assertion fires after the first test adds an offering.
 */
async function cleanUpTestRows(): Promise<void> {
  const prisma = createTestPrismaClient();
  try {
    // M2 (#85) PR-review feedback (round 4): the interleaving
    // test invokes the real activation transaction, which writes
    // an evidence row that references the offering via FK with
    // ON DELETE RESTRICT. Delete the activation / creation
    // evidence rows BEFORE deleting the offering so the
    // canonical seed reset does not trip a FK violation.
    await prisma.serviceOfferingActivation.deleteMany({
      where: { offering: { slug: { startsWith: TEST_SLUG_PREFIX } } },
    });
    await prisma.serviceOfferingCreation.deleteMany({
      where: { offering: { slug: { startsWith: TEST_SLUG_PREFIX } } },
    });
    // Offerings own their audio samples via FK; deleting the
    // offering cascades through ServiceOfferingAudioSample and
    // AudioSampleOrphanedStorage. The orphan-locator table also
    // cascades. Pricing and service-area rows cascade from the
    // offering, so deleting the offering alone is sufficient.
    await prisma.serviceOffering.deleteMany({
      where: { slug: { startsWith: TEST_SLUG_PREFIX } },
    });
  } finally {
    await prisma.$disconnect();
  }
}

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
  await cleanUpTestRows();
  await resetViaSeed();
});

afterEach(async () => {
  await cleanUpTestRows();
});

/**
 * Insert a deterministic seeded offering context so the audio repository
 * tests have a known offering id with Draft status + Published profile
 * + Active Workspace + Seller capability. Returns the new offering id.
 *
 * M2 (#85) PR-review feedback: also returns the Workspace owner's
 * UserAccount id so the tests can persist a real `confirmedByUserId`
 * value (the FK on the new confirmation column rejects a user id
 * that does not exist on `user_accounts`).
 */
async function seedOfferingWithContext(): Promise<{
  offeringId: string;
  userId: string;
  sellerProfileId: string;
  workspaceId: string;
}> {
  const prisma = createTestPrismaClient();
  try {
    const seller = await prisma.sellerProfile.findFirst({
      where: { status: "Published" },
      include: { workspace: true },
    });
    assert.ok(seller, "seed must include at least one Published seller");
    const offering = await prisma.serviceOffering.create({
      data: {
        slug: `${TEST_SLUG_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sellerProfileId: seller.id,
        title: "BG2 Prisma Test Offering",
        description: "Integration-test offering for the audio repository.",
        status: "Draft",
        serviceMode: "Remote",
        primaryCategoryId: (
          await prisma.serviceCategory.findFirstOrThrow({ where: { key: "music-production" } })
        ).id,
        genreTags: [],
      },
    });
    return {
      offeringId: offering.id,
      userId: seller.workspace.ownerUserId,
      sellerProfileId: seller.id,
      workspaceId: seller.workspace.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}

describe("PrismaAudioRepository P0-001", () => {
  test("a normal upload persists a Live row with valid display order", async () => {
    const { offeringId, userId } = await seedOfferingWithContext();
    const created = await repository.createSampleWithCap({
      offeringId,
      label: "First sample",
      contentType: "audio/mpeg",
      byteSize: 1024,
      storageRef: "det:test:prisma:normal",
      confirmation: {
        version: "m2-audio-confirmation-v1",
        confirmedByUserId: userId,
        confirmedAt: new Date(),
      },
    });
    assert.ok(created, "createSampleWithCap must succeed under the cap");
    assert.equal(created.displayOrder, 1);
    assert.equal(created.cleanupStatus, AudioSampleCleanupStatus.Live);
    const list = await repository.listSamplesForOffering(offeringId);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.sampleId, created.sampleId);
  });

  test("two overlapping uploads from cap-1 yield exactly one success + one cap rejection", async () => {
    const { offeringId, userId } = await seedOfferingWithContext();
    // Seed two existing Live samples so the offering is at cap-1.
    for (let i = 1; i <= 2; i += 1) {
      const seeded = await repository.createSampleWithCap({
        offeringId,
        label: `Existing ${i}`,
        contentType: "audio/mpeg",
        byteSize: 1024,
        storageRef: `det:test:prisma:existing-${i}`,
        confirmation: {
          version: "m2-audio-confirmation-v1",
          confirmedByUserId: userId,
          confirmedAt: new Date(),
        },
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
        confirmation: {
          version: "m2-audio-confirmation-v1",
          confirmedByUserId: userId,
          confirmedAt: new Date(),
        },
      }),
      repository.createSampleWithCap({
        offeringId,
        label: "Race B",
        contentType: "audio/mpeg",
        byteSize: 1024,
        storageRef: "det:test:prisma:race-b",
        confirmation: {
          version: "m2-audio-confirmation-v1",
          confirmedByUserId: userId,
          confirmedAt: new Date(),
        },
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
    const { offeringId: offeringA, userId: userId } = await seedOfferingWithContext();
    const { offeringId: offeringB } = await seedOfferingWithContext();
    // Each offering is independent; the per-offering advisory locks do
    // not block writes to a sibling offering.
    const [a, b] = await Promise.all([
      repository.createSampleWithCap({
        offeringId: offeringA,
        label: "A",
        contentType: "audio/mpeg",
        byteSize: 1024,
        storageRef: "det:test:prisma:offering-a",
        confirmation: {
          version: "m2-audio-confirmation-v1",
          confirmedByUserId: userId,
          confirmedAt: new Date(),
        },
      }),
      repository.createSampleWithCap({
        offeringId: offeringB,
        label: "B",
        contentType: "audio/mpeg",
        byteSize: 1024,
        storageRef: "det:test:prisma:offering-b",
        confirmation: {
          version: "m2-audio-confirmation-v1",
          confirmedByUserId: userId,
          confirmedAt: new Date(),
        },
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
    // Use $executeRaw (not $queryRaw) because the function returns
    // void and Prisma cannot deserialize the void result through
    // $queryRaw.
    const prisma = createTestPrismaClient();
    try {
      await prisma.$executeRaw`SELECT pg_advisory_xact_lock(1096107081::int, 0::int)`;
    } finally {
      await prisma.$disconnect();
    }
  });

  test("activation observes a removal that commits while activation is blocked on the shared audio-sample lock (round 5 deterministic regression)", async () => {
    // M2 (#85) PR-review feedback (round 2 + round 5): the
    // activation transaction in `prisma-service-offering.
    // repository.activate` and the audio-sample removal both
    // acquire the same per-offering audio-sample advisory lock
    // (AUDIO_SAMPLE_LOCK_CLASS, audioSampleLockKey(offeringId)),
    // so the two operations serialize.
    //
    // The round-4 interleaving test started activation and
    // removal concurrently and accepted EITHER outcome, which
    // meant it would still pass if activation stopped acquiring
    // the shared lock. The reviewer's round-5 requirement: a
    // deterministic regression that FAILS when activation no
    // longer acquires the lock.
    //
    // Approach: drive the race with external coordination so
    // activation is provably blocked on the shared lock (not on
    // row contention, not on the service-offering lock, not on
    // anything else).
    //
    //   1. A HOLDER transaction (separate Prisma client on its
    //      own connection) acquires the audio-sample lock,
    //      flips the sample to PendingCleanup INSIDE the
    //      transaction — so the flip is invisible to other
    //      connections until the holder commits — and WAITS for
    //      an external signal before committing.
    //   2. ACTIVATION starts on a second Prisma client. It
    //      acquires the service-offering lock (a DIFFERENT lock
    //      nobody else holds), then BLOCKS on the audio-sample
    //      lock the holder owns.
    //   3. We poll `pg_locks` until we observe a non-granted
    //      waiter on the audio-sample lock — this proves
    //      activation is blocked on the SHARED lock, not on
    //      anything coincidental.
    //   4. We signal the holder to commit. The flip becomes
    //      visible; activation acquires the lock, re-counts,
    //      sees 0 confirmed Live samples, and raises
    //      `ServiceOfferingIncompleteError`.
    //
    // Failure mode the test catches: if `activate` no longer
    // calls `acquireAudioSampleLockTx`, it does NOT block,
    // counts the Live sample BEFORE the holder commits the
    // flip, succeeds, and commits Active with the sample then
    // flipped to PendingCleanup (the round-2 finding). The
    // test asserts activation REJECTS, so the regression fails
    // loudly with "no waiter observed on the audio-sample
    // lock".
    const prisma = createTestPrismaClient();
    const holderDbCli = createTestPrismaClient();
    const activationDbCli = createTestPrismaClient();
    try {
      // The disposable DB has migrations but no seed data; this
      // test exercises the real `activate` transaction which
      // resolves `music-production` → ServiceCategory and
      // `per-track` → PricingUnit. Seed the canonical taxonomy
      // rows the activation resolves.
      await prisma.serviceCategory.upsert({
        where: { key: "music-production" },
        create: { key: "music-production", name: "Music production", bundleOnly: false },
        update: {},
      });
      await prisma.pricingUnit.upsert({
        where: { key: "per-track" },
        create: { key: "per-track", name: "Per track" },
        update: {},
      });
      const ctx = await seedOfferingWithContext();
      const sampleId = `smp-round5-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await prisma.serviceOfferingAudioSample.create({
        data: {
          offeringId: ctx.offeringId,
          id: sampleId,
          label: "Round 5 deterministic race sample",
          contentType: "audio/mpeg",
          byteSize: 1024,
          displayOrder: 1,
          storageRef: `det:test:prisma:round5-${sampleId}`,
          cleanupStatus: "Live",
          confirmationVersion: "m2-audio-confirmation-v1",
          confirmedByUserId: ctx.userId,
          confirmedAt: new Date(),
        },
      });
      // Use SEPARATE Prisma clients (and therefore separate
      // connection-pool entries) for the holder and the
      // activation so their transactions can run concurrently
      // on different connections. Two transactions on the same
      // connection would deadlock.
      // Step 1 — open the holder transaction. Acquire the
      // shared audio-sample lock, flip the sample to
      // PendingCleanup inside the transaction (so the flip is
      // invisible to other connections until the holder
      // commits), and await an external signal before the
      // callback returns (which is when the transaction
      // commits and the lock is released).
      let releaseSignal!: () => void;
      const releasePromise = new Promise<void>((resolve) => {
        releaseSignal = resolve;
      });
      const holderTask = holderDbCli.$transaction(
        async (txClient) => {
          await acquireAudioSampleLockTx(txClient, ctx.offeringId);
          await txClient.serviceOfferingAudioSample.update({
            where: { id: sampleId },
            data: { cleanupStatus: AudioSampleCleanupStatus.PendingCleanup },
          });
          // Hold the transaction open until the test confirms
          // activation is blocked on the shared lock.
          await releasePromise;
        },
        { timeout: 30_000, maxWait: 5_000 },
      );
      // Step 2 — wait for the holder to actually acquire the
      // lock. Without this gate, a slow holder startup could
      // let activation race past the lock acquisition and miss
      // the regression we want to surface.
      const lockKey = audioSampleLockKey(ctx.offeringId);
      let holderAcquired = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = ${AUDIO_SAMPLE_LOCK_CLASS}::int
            AND objid = ${lockKey}::int
            AND granted = true
        `;
        if (rows.length > 0) {
          holderAcquired = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        holderAcquired,
        "holder must acquire the audio-sample lock before activation starts",
      );
      // Step 3 — start activation on a separate connection. It
      // acquires the service-offering lock (a different lock
      // nobody holds), then BLOCKS on the audio-sample lock the
      // holder owns.
      const offeringRepo = new PrismaServiceOfferingRepository(activationDbCli);
      const activationPromise = offeringRepo.activate({
        offeringId: ctx.offeringId,
        workspaceId: ctx.workspaceId,
        sellerProfileId: ctx.sellerProfileId,
        activatedByUserId: ctx.userId,
        title: "Round 5 activation",
        description: "Round 5 description.",
        primaryCategoryKey: "music-production",
        serviceMode: "Remote",
        serviceAreas: [],
        pricing: {
          kind: "StartingAt",
          amountMinor: 60000,
          currency: "USD",
          unitId: "per-track",
        },
        genreTags: [],
        includedServiceCategoryKeys: [],
        confirmationVersion: "m2-service-activation-v1",
        idempotencyKey: `act-round5-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        requestId: `req-round5-${Date.now()}`,
        now: new Date(),
        playbackUrlFor: (input) =>
          `https://api.test/services/${input.offeringId}/samples/${input.sampleId}/play`,
      });
      // Silence the unhandled-rejection warning while we await
      // settlement below via Promise.allSettled.
      activationPromise.catch(() => undefined);
      // Step 4 — poll pg_locks until we observe a non-granted
      // waiter on the audio-sample lock. This is the
      // regression proof: if activation stopped acquiring the
      // lock, no waiter would appear.
      let waiterObserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await prisma.$queryRaw<Array<{ pid: number; granted: boolean }>>`
          SELECT pid, granted FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = ${AUDIO_SAMPLE_LOCK_CLASS}::int
            AND objid = ${lockKey}::int
        `;
        const waiter = rows.find((r) => !r.granted);
        if (waiter) {
          waiterObserved = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        waiterObserved,
        "activation must be blocked waiting on the shared audio-sample lock (regression: activate MUST acquire the lock)",
      );
      // Step 5 — release the holder. The flip becomes visible
      // to other connections on commit; activation can now
      // acquire the lock and re-count.
      releaseSignal();
      // Step 6 — await settlement. Activation MUST reject with
      // ServiceOfferingIncompleteError because the sample it
      // would have counted is now PendingCleanup. The holder
      // task MUST commit successfully (otherwise the test
      // surfaces the holder's failure separately).
      const results = await Promise.allSettled([activationPromise, holderTask]);
      const activationResult = results[0];
      const holderResult = results[1];
      assert.equal(holderResult.status, "fulfilled", "holder transaction must commit successfully");
      assert.equal(
        activationResult.status,
        "rejected",
        "activation must reject after observing the committed removal",
      );
      const reason = (activationResult.reason as { name?: string } | undefined)?.name;
      assert.equal(reason, "ServiceOfferingIncompleteError");
      // Step 7 — verify the post-state.
      //   - offering remains Draft (activation's transaction
      //     rolled back).
      //   - sample is PendingCleanup (the holder's flip
      //     committed).
      //   - no activation-evidence row was written.
      const offering = await prisma.serviceOffering.findUnique({
        where: { id: ctx.offeringId },
        select: { status: true },
      });
      assert.ok(offering);
      assert.equal(
        offering.status,
        "Draft",
        "offering must remain Draft after activation rejection",
      );
      const sample = await prisma.serviceOfferingAudioSample.findUnique({
        where: { id: sampleId },
        select: { cleanupStatus: true },
      });
      assert.ok(sample);
      assert.equal(
        sample.cleanupStatus,
        AudioSampleCleanupStatus.PendingCleanup,
        "holder must have committed the PendingCleanup flip",
      );
      const activationCount = await prisma.serviceOfferingActivation.count({
        where: { offeringId: ctx.offeringId },
      });
      assert.equal(activationCount, 0, "no activation evidence must be written on rejection");
    } finally {
      await prisma.$disconnect();
      await holderDbCli.$disconnect();
      await activationDbCli.$disconnect();
    }
  });
});
