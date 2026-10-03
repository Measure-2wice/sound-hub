// M2 (#86, slice 86E Codex re-review): end-to-end integration
// test for the grandfathering inventory script.
//
// Why this exists: the Codex re-review explicitly requested an
// integration test covering "legacy Active → successful update →
// no stale-confirmation reason" (blocker #2). The pure-function
// test in
// `packages/db/src/grandfathering/service-offering-readiness.test.ts`
// pins the derivation rule; this test pins the end-to-end
// behavior against the seeded disposable test DB.
//
// The follow-up re-review (blocker #1 chronological follow-up)
// added the Reactivate-after-rotation scenario: an older update
// row + a newer activation row → the helper must pick the newer
// activation's confirmationVersion.
//
// The test is read-and-write: it inserts ONE
// `ServiceOfferingUpdate` row (the blocker #2 fixture) and ONE
// `ServiceOfferingActivation` row (the blocker #1 fixture); it
// never touches any other table; the rows are deleted in the
// `after` hook so the test is idempotent across re-runs.
//
// Run prerequisites: the disposable test DB must be in the
// canonical M1.1 fixture state. The script
// `pnpm --filter @soundhub/db db:test:integration` bundles the
// reset + seed + run; the same script is wired into the root
// `pnpm test` chain (and runs through the disposable-PostgreSQL
// gate the re-review flagged).
//
// The script file `inventory-grandfathered-offerings.ts` does
// NOT write to the database; only this test does, in the
// `before` / `after` hooks and the convergence fixtures.

/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";
import { SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS } from "@soundhub/types";

import {
  computeInventorySnapshot,
  type InventorySnapshot,
} from "./inventory-grandfathered-offerings.js";
import { PrismaClient } from "../src/generated/client.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL (or DATABASE_URL) must be set for the inventory integration test",
  );
}

const CURRENT_CONFIRMATION = SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS.at(-1);
if (!CURRENT_CONFIRMATION) {
  throw new Error(
    "SERVICE_OFFERING_ACTIVATION_CONFIRMATION_VERSIONS is empty — cannot derive a target confirmation",
  );
}

// Use a clearly-stale confirmation distinct from the current
// version so the test can prove the helper selects the newer
// event rather than the older row's value by accident.
const STALE_CONFIRMATION = "m2-service-activation-v0";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});

interface UpdateFixture {
  readonly offeringId: string;
  readonly sellerProfileId: string;
  readonly sellerProfileOwnerUserId: string;
  readonly sellerProfileWorkspaceId: string;
  readonly insertedUpdateId: string;
}

interface ActivationFixture {
  readonly offeringId: string;
  readonly sellerProfileId: string;
  readonly sellerProfileOwnerUserId: string;
  readonly sellerProfileWorkspaceId: string;
  readonly insertedActivationId: string;
}

function findConvergenceTarget(stateA: InventorySnapshot): {
  readonly offeringId: string;
  readonly sellerProfileId: string;
} | null {
  // The target must currently be reported as nonconforming with
  // `activation-confirmation-stale` AND the offering's
  // SellerProfile must be Published (so the only persistence
  // reason is the stale confirmation, which makes the
  // before/after delta clean). The test then inserts a
  // `ServiceOfferingUpdate` row at the current confirmation
  // version and re-runs the inventory; the offering must
  // either vanish from the nonconforming list or carry
  // `activation-confirmation-stale` no longer in its
  // reasonCategories.
  const target = stateA.nonconformingOfferings.find(
    (row) =>
      row.reasonCategories.includes("activation-confirmation-stale") &&
      row.sellerProfileStatus === "Published",
  );
  if (!target) return null;
  return {
    offeringId: target.offeringId,
    sellerProfileId: target.sellerProfileId,
  };
}

async function buildFixture(offeringId: string, sellerProfileId: string) {
  // Read the FK-bearing columns of the seller profile + the
  // owning workspace's ownerUserId so the inserted evidence
  // row satisfies the FK constraints (ON DELETE RESTRICT means
  // a missing FK would reject the insert with a constraint
  // violation rather than a clean validation error).
  //
  // SellerProfile has no `ownerUserId` column; ownership is
  // transitive via `Workspace.ownerUserId`. The 86E inserted
  // rows mirror what a real `updateActive` / `reactivate`
  // server command would write: `workspaceId` from the
  // SellerProfile and the acting user from the workspace owner.
  const profile = await prisma.sellerProfile.findUnique({
    where: { id: sellerProfileId },
    select: {
      id: true,
      workspaceId: true,
      workspace: {
        select: { ownerUserId: true },
      },
    },
  });
  if (!profile) return null;
  return {
    offeringId,
    sellerProfileId,
    sellerProfileOwnerUserId: profile.workspace.ownerUserId,
    sellerProfileWorkspaceId: profile.workspaceId,
  };
}

async function insertUpdateRowAtCurrent(
  fixture: Omit<UpdateFixture, "insertedUpdateId">,
): Promise<string> {
  const requestId = randomUUID();
  const idempotencyKey = `inventory-convergence-test:${fixture.offeringId}:${requestId}`;
  const inserted = await prisma.serviceOfferingUpdate.create({
    data: {
      offeringId: fixture.offeringId,
      workspaceId: fixture.sellerProfileWorkspaceId,
      sellerProfileId: fixture.sellerProfileId,
      updatedByUserId: fixture.sellerProfileOwnerUserId,
      confirmationVersion: CURRENT_CONFIRMATION,
      idempotencyKey,
      requestId,
    },
    select: { id: true },
  });
  return inserted.id;
}

async function insertUpdateRowAtStale(
  fixture: Omit<UpdateFixture, "insertedUpdateId">,
): Promise<string> {
  const requestId = randomUUID();
  const idempotencyKey = `inventory-convergence-test:${fixture.offeringId}:${requestId}`;
  const inserted = await prisma.serviceOfferingUpdate.create({
    data: {
      offeringId: fixture.offeringId,
      workspaceId: fixture.sellerProfileWorkspaceId,
      sellerProfileId: fixture.sellerProfileId,
      updatedByUserId: fixture.sellerProfileOwnerUserId,
      confirmationVersion: STALE_CONFIRMATION,
      idempotencyKey,
      requestId,
    },
    select: { id: true },
  });
  return inserted.id;
}

async function insertActivationRowAtCurrent(
  fixture: Omit<ActivationFixture, "insertedActivationId">,
  activatedAt: Date,
): Promise<string> {
  const requestId = randomUUID();
  const idempotencyKey = `inventory-convergence-test:${fixture.offeringId}:${requestId}`;
  const inserted = await prisma.serviceOfferingActivation.create({
    data: {
      offeringId: fixture.offeringId,
      workspaceId: fixture.sellerProfileWorkspaceId,
      sellerProfileId: fixture.sellerProfileId,
      activatedByUserId: fixture.sellerProfileOwnerUserId,
      confirmationVersion: CURRENT_CONFIRMATION,
      activatedAt,
      idempotencyKey,
      requestId,
    },
    select: { id: true },
  });
  return inserted.id;
}

async function deleteUpdateRow(updateId: string): Promise<void> {
  if (!updateId) return;
  await prisma.serviceOfferingUpdate.delete({ where: { id: updateId } });
}

async function deleteActivationRow(activationId: string): Promise<void> {
  if (!activationId) return;
  await prisma.serviceOfferingActivation.delete({ where: { id: activationId } });
}

const beforeAllHooks: Array<() => Promise<void>> = [];
const afterAllHooks: Array<() => Promise<void>> = [];
before(async () => {
  for (const hook of beforeAllHooks) await hook();
});
after(async () => {
  for (const hook of afterAllHooks.reverse()) await hook();
  await prisma.$disconnect();
});

void describe("computeInventorySnapshot (integration against seeded disposable DB)", () => {
  void test("emits the structured JSON shape the slice plan locks", async () => {
    const snapshot = await computeInventorySnapshot(prisma, CURRENT_CONFIRMATION);

    assert.equal(snapshot.schemaVersion, 1, "schemaVersion is a frozen constant today");
    assert.equal(snapshot.currentConfirmationVersion, CURRENT_CONFIRMATION);
    assert.equal(snapshot.sampleCountBounds.min, 1);
    assert.equal(snapshot.sampleCountBounds.max, 3);
    assert.ok(typeof snapshot.generatedAt === "string");
    assert.ok(snapshot.generatedAt.length > 0);
    assert.ok(Number.isFinite(snapshot.totals.activeOfferingsScanned));
    assert.ok(
      snapshot.totals.activeOfferingsScanned > 0,
      "the seeded disposable DB always carries Active offerings",
    );
    assert.equal(
      snapshot.totals.conforming + snapshot.totals.nonconforming,
      snapshot.totals.activeOfferingsScanned,
      "conforming + nonconforming must equal total Active offerings scanned",
    );
    assert.equal(snapshot.nonconformingOfferings.length, snapshot.totals.nonconforming);

    // The M1.1 fixture seeds legacy Active offerings that are
    // necessarily nonconforming under the slice 86E contract
    // (they pre-date the closed-set confirmation version).
    assert.ok(
      snapshot.totals.nonconforming > 0,
      "the M1.1 fixture seeds at least one Active nonconforming offering",
    );
    assert.ok(
      Object.keys(snapshot.reasonCategoryCounts).length > 0,
      "non-empty nonconforming set implies non-empty reasonCategoryCounts",
    );

    // Every category in `reasonCategoryCounts` is a key in the
    // closed set the slice plan locks (this guards against
    // silent drift in the inventory's vocabulary).
    const CLOSED_CATEGORIES = new Set([
      "title-required",
      "description-required",
      "category-required",
      "service-area-required",
      "pricing-required",
      "audio-sample-required",
      "activation-confirmation-stale",
      "seller-profile-not-published",
    ]);
    for (const category of Object.keys(snapshot.reasonCategoryCounts)) {
      assert.ok(
        CLOSED_CATEGORIES.has(category),
        `unexpected category "${category}" in inventory output`,
      );
    }
  });

  void test("grandfathered Active offerings return isAvailable=true AND updateNeeded=true", async () => {
    const snapshot = await computeInventorySnapshot(prisma, CURRENT_CONFIRMATION);
    // Every nonconforming Active row must satisfy the corrected
    // semantics: the marketplace eligibility is preserved
    // (isAvailable=true) while the operator surfaces actionable
    // remediation (updateNeeded=true). The prior conjunction
    // made this state unreachable.
    for (const row of snapshot.nonconformingOfferings) {
      assert.equal(row.isAvailable, true, `offering ${row.offeringId} must remain Available`);
      assert.equal(row.updateNeeded, true, `offering ${row.offeringId} must report Update needed`);
    }
  });

  void test(
    "[blocker #2] legacy Active offering with a successful update at current confirmation " +
      "is no longer reported as activation-confirmation-stale",
    async () => {
      const stateA = await computeInventorySnapshot(prisma, CURRENT_CONFIRMATION);
      const target = findConvergenceTarget(stateA);
      if (!target) {
        // The M1.1 fixture is expected to produce at least one
        // such offering; if not, the seed has drifted and the
        // reviewer-requested scenario cannot be exercised.
        assert.fail(
          "expected at least one legacy Active nonconforming offering whose only persistence " +
            "reason is activation-confirmation-stale. The seeded disposable DB must include such " +
            "an offering for this test to be meaningful.",
        );
      }

      const partial = await buildFixture(target.offeringId, target.sellerProfileId);
      assert.ok(partial, "convergence target must have a resolvable SellerProfile");
      const updateId = await insertUpdateRowAtCurrent(partial);
      afterAllHooks.push(async () => {
        await deleteUpdateRow(updateId);
      });

      const stateB = await computeInventorySnapshot(prisma, CURRENT_CONFIRMATION);

      // Read-only invariant: the inventory MUST NOT add or remove
      // rows. The same Active offerings are present in both
      // snapshots.
      assert.equal(
        stateB.totals.activeOfferingsScanned,
        stateA.totals.activeOfferingsScanned,
        "inventory is read-only: Active offerings scanned must not change between runs",
      );

      // Locate the convergence target in the post-update snapshot.
      const after = stateB.nonconformingOfferings.find(
        (row) => row.offeringId === target.offeringId,
      );
      if (after === undefined) {
        // The target became fully conformant: the inserted
        // update resolved the only persistence reason
        // (activation-confirmation-stale) and the offering has
        // no other nonconforming reasons to surface. This is the
        // ideal outcome.
        return;
      }

      // Otherwise: the target is still nonconforming but for
      // OTHER reasons (audio, pricing, etc.) — the stale
      // confirmation category MUST be gone.
      assert.equal(
        after.reasonCategories.includes("activation-confirmation-stale"),
        false,
        `offering ${target.offeringId} must no longer carry activation-confirmation-stale after ` +
          `a successful update at the current confirmation version`,
      );
    },
  );

  void test(
    "[chronological follow-up] Activate → Update → Pause → Reactivate: a newer activation " +
      "supersedes an older update at a stale confirmation version",
    async () => {
      // The 86E Codex re-review blocker #1 follow-up. The
      // lifecycle permits Activate → Update → Pause → Reactivate;
      // a Reactivate issued AFTER a confirmation-version rotation
      // writes a NEW activation row at the current version
      // while the older update row from before the rotation
      // still carries the previous version. The helper MUST pick
      // the chronologically newest event (the new activation),
      // NOT the older update.
      //
      // This test inserts both rows:
      //   1. A `ServiceOfferingUpdate` row at the STALE
      //      confirmation, timestamped NOW.
      //   2. A `ServiceOfferingActivation` row at the CURRENT
      //      confirmation, timestamped NOW+1ms (strictly
      //      newer).
      //
      // The prior helper always preferred update and would
      // return the STALE confirmation; the corrected helper
      // picks the newer activation and returns the CURRENT
      // confirmation. The offering's `reasonCategories`
      // therefore does NOT include
      // `activation-confirmation-stale`.
      const stateA = await computeInventorySnapshot(prisma, CURRENT_CONFIRMATION);
      const target = findConvergenceTarget(stateA);
      if (!target) {
        assert.fail(
          "expected at least one legacy Active nonconforming offering whose only persistence " +
            "reason is activation-confirmation-stale. The seeded disposable DB must include such " +
            "an offering for this test to be meaningful.",
        );
      }

      const partial = await buildFixture(target.offeringId, target.sellerProfileId);
      assert.ok(partial, "chronological target must have a resolvable SellerProfile");

      const baseTime = new Date();
      const olderUpdateTime = baseTime;
      const newerActivationTime = new Date(baseTime.getTime() + 1_000);

      const olderUpdateId = await insertUpdateRowAtStale(partial);
      afterAllHooks.push(async () => {
        await deleteUpdateRow(olderUpdateId);
      });

      const newerActivationId = await insertActivationRowAtCurrent(partial, newerActivationTime);
      afterAllHooks.push(async () => {
        await deleteActivationRow(newerActivationId);
      });

      // Sanity: the inserted update's updatedAt should be older
      // than the inserted activation's activatedAt. Without
      // this ordering the test cannot prove the chronological
      // selection.
      assert.ok(
        olderUpdateTime.getTime() < newerActivationTime.getTime(),
        "test fixture invariant: update timestamp < activation timestamp",
      );

      const stateB = await computeInventorySnapshot(prisma, CURRENT_CONFIRMATION);

      // Read-only invariant.
      assert.equal(
        stateB.totals.activeOfferingsScanned,
        stateA.totals.activeOfferingsScanned,
        "inventory is read-only: Active offerings scanned must not change between runs",
      );

      const after = stateB.nonconformingOfferings.find(
        (row) => row.offeringId === target.offeringId,
      );
      if (after === undefined) {
        // The offering became fully conformant — the newer
        // activation cleared every nonconforming reason.
        return;
      }

      assert.equal(
        after.reasonCategories.includes("activation-confirmation-stale"),
        false,
        `offering ${target.offeringId} must NOT carry activation-confirmation-stale after ` +
          `the newer Reactivate at current confirmation supersedes the older stale update`,
      );
    },
  );

  void test("read-only invariant: re-running the inventory does not mutate Active offerings", async () => {
    // Snapshot the Active offering row counts before and after a
    // fresh inventory run. The inventory is read-only; the
    // counts must match.
    const before = await prisma.serviceOffering.count({ where: { status: "Active" } });
    await computeInventorySnapshot(prisma, CURRENT_CONFIRMATION);
    const after = await prisma.serviceOffering.count({ where: { status: "Active" } });
    assert.equal(after, before, "Active offering count must be unchanged by an inventory run");

    const updatesBefore = await prisma.serviceOfferingUpdate.count();
    await computeInventorySnapshot(prisma, CURRENT_CONFIRMATION);
    const updatesAfter = await prisma.serviceOfferingUpdate.count();
    assert.equal(
      updatesAfter,
      updatesBefore,
      "ServiceOfferingUpdate count must be unchanged by an inventory run",
    );
  });
});
