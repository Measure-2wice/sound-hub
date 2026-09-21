// Atomic intent provision correctness (M2 #83 remediation §1, C1).
//
// Disposable Postgres. The remediation requires that the atomic
// intent provisioning rolls back to zero rows when a real
// database write inside the transaction fails. We trigger the
// failure by passing an FK-invalid `grantedByUserId` — the
// acceptance INSERT references a UserAccount that does not exist.
// The natural FK constraint on `seller_participation_acceptances`
// fires inside the same `$transaction` as the capability upserts.
//
// Tests:
//
//   1. Both happy path — final state: 1 Buyer + 1 Seller + 1
//      acceptance row.
//   2. Both rollback — capability upserts succeed inside the
//      transaction, the acceptance INSERT fails on the FK. Expect
//      the transaction to throw; final state: 0 capability rows,
//      0 acceptance rows for the workspace. No wrapper around the
//      atomic command; the real Prisma adapter raises the FK
//      constraint error.
//   3. Offer rollback — capability upsert for Seller succeeds;
//      acceptance fails; 0 rows.
//   4. Concurrent whole-command retry — five concurrent
//      `provisionIntentAtomically` calls against the same workspace
//      converge on a single Buyer, single Seller, and single
//      acceptance row (the in-transaction upsert absorbs
//      duplicates; all callers commit successfully).

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import type { PrismaClient } from "@soundhub/db";
import { PrismaAuthRepository } from "./prisma-auth-repository.js";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

describe("PrismaAuthRepository intent atomicity", () => {
  let prisma: PrismaClient | null = null;

  before(() => {
    if (skip) return;
    assertDisposableTestDatabase(readTestDatabaseUrl());
    prisma = createPrismaClient(readTestDatabaseUrl());
  });

  after(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test("Both happy path: 1 Buyer + 1 Seller + 1 acceptance row", async (t) => {
    if (skip || !prisma) {
      t.skip();
      return;
    }
    const repo = new PrismaAuthRepository(prisma);
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-atomic-both-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-atomic-both-${ts}-${Math.random().toString(36).slice(2, 10)}`,
        name: "Intent Atomic Both Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "Owner" },
    });

    try {
      await repo.provisionIntentAtomically({
        workspaceId: workspace.id,
        userAccountId: user.id,
        capabilities: ["Buyer", "Seller"],
        acceptance: {
          termsVersion: "1.0.0",
          termsContentHash: "a".repeat(64),
          grantedByUserId: user.id,
        },
      });
      const caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(caps.length, 2);
      const names = caps.map((c) => c.capability).sort();
      assert.deepEqual(names, ["Buyer", "Seller"]);
      const acceptances = await prisma.sellerParticipationAcceptance.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(acceptances.length, 1);
    } finally {
      await cleanup(prisma, workspace.id, user.id);
    }
  });

  test("Both rollback: real FK violation inside transaction → 0 rows", async (t) => {
    if (skip || !prisma) {
      t.skip();
      return;
    }
    const repo = new PrismaAuthRepository(prisma);
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-atomic-rb-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-atomic-rb-${ts}-${Math.random().toString(36).slice(2, 10)}`,
        name: "Intent Atomic Rollback Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "Owner" },
    });

    // A "ghost" UserAccount id that we deliberately do NOT
    // persist; the FK in seller_participation_acceptances will
    // reject the INSERT inside the transaction.
    const ghostUserId = `ghost-${ts}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      await assert.rejects(
        () =>
          repo.provisionIntentAtomically({
            workspaceId: workspace.id,
            userAccountId: user.id,
            capabilities: ["Buyer", "Seller"],
            acceptance: {
              termsVersion: "1.0.0",
              termsContentHash: "a".repeat(64),
              grantedByUserId: ghostUserId,
            },
          }),
        (err: unknown) => {
          // Real Prisma FK violation error bubbles up; we accept
          // any thrown error — the test only cares that the
          // transaction rolled back the capability upserts.
          assert.ok(err instanceof Error);
          return true;
        },
      );
      const caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(caps.length, 0, "capability rows must roll back");
      const acceptances = await prisma.sellerParticipationAcceptance.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(acceptances.length, 0, "acceptance rows must roll back");
    } finally {
      await cleanup(prisma, workspace.id, user.id);
    }
  });

  test("Offer rollback: FK violation inside transaction → 0 rows", async (t) => {
    if (skip || !prisma) {
      t.skip();
      return;
    }
    const repo = new PrismaAuthRepository(prisma);
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-atomic-offer-rb-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-atomic-offer-rb-${ts}-${Math.random().toString(36).slice(2, 10)}`,
        name: "Intent Atomic Offer Rollback Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "Owner" },
    });

    const ghostUserId = `ghost-offer-${ts}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      await assert.rejects(
        () =>
          repo.provisionIntentAtomically({
            workspaceId: workspace.id,
            userAccountId: user.id,
            capabilities: ["Seller"],
            acceptance: {
              termsVersion: "1.0.0",
              termsContentHash: "b".repeat(64),
              grantedByUserId: ghostUserId,
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        },
      );
      const caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(caps.length, 0, "Seller capability row must roll back");
      const acceptances = await prisma.sellerParticipationAcceptance.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(acceptances.length, 0, "acceptance row must roll back");
    } finally {
      await cleanup(prisma, workspace.id, user.id);
    }
  });

  test("Concurrent whole-command: 5 callers converge on exactly one row per write", async (t) => {
    if (skip || !prisma) {
      t.skip();
      return;
    }
    const repo = new PrismaAuthRepository(prisma);
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-atomic-conc-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-atomic-conc-${ts}-${Math.random().toString(36).slice(2, 10)}`,
        name: "Intent Atomic Concurrent Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "Owner" },
    });

    try {
      // Five concurrent callers, each running the FULL atomic
      // command against the same workspace with the same terms
      // version. The in-transaction upsert absorbs duplicates;
      // every caller observes a successful commit (no throws).
      await Promise.all(
        Array.from({ length: 5 }, () =>
          repo.provisionIntentAtomically({
            workspaceId: workspace.id,
            userAccountId: user.id,
            capabilities: ["Buyer", "Seller"],
            acceptance: {
              termsVersion: "1.0.0",
              termsContentHash: "c".repeat(64),
              grantedByUserId: user.id,
            },
          }),
        ),
      );

      const caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(caps.length, 2, "exactly one Buyer + one Seller row");

      const acceptances = await prisma.sellerParticipationAcceptance.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(acceptances.length, 1, "exactly one acceptance row");
    } finally {
      await cleanup(prisma, workspace.id, user.id);
    }
  });
});

async function cleanup(prisma: PrismaClient, workspaceId: string, userId: string): Promise<void> {
  await prisma.sellerParticipationAcceptance.deleteMany({ where: { workspaceId } });
  await prisma.workspaceCapability.deleteMany({ where: { workspaceId } });
  await prisma.workspaceMembership.deleteMany({ where: { workspaceId } });
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.userAccount.delete({ where: { id: userId } });
}
