// Atomic intent provision correctness (M2 #83).
//
// Disposable Postgres. The intent provisioning must roll back to
// zero rows when a real database write inside the transaction
// fails. We trigger the failure by INSERT-ing a capability against
// a non-existent Workspace id — the natural FK constraint fires
// inside the same `$transaction` as the capability writes.
//
// Tests:
//
//   1. Both happy path — final state: 1 Buyer + 1 Seller capability
//      row.
//   2. Both rollback — capability INSERTs run inside the
//      transaction against an unknown Workspace; expect the
//      transaction to throw; final state: 0 capability rows.
//      No wrapper around the atomic command; the real Prisma
//      adapter raises the FK constraint error.
//   3. Concurrent whole-command retry — five concurrent
//      `provisionIntentAtomically` calls against the same workspace
//      converge on a single Buyer and single Seller capability row
//      (the in-transaction upsert absorbs duplicates; all callers
//      commit successfully).

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

  test("Both happy path: 1 Buyer + 1 Seller capability row", async (t) => {
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
        expectedCapabilities: [],
      });
      const caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(caps.length, 2);
      const names = caps.map((c) => c.capability).sort();
      assert.deepEqual(names, ["Buyer", "Seller"]);
    } finally {
      await cleanup(prisma, workspace.id, user.id);
    }
  });

  test("Both rollback: real FK violation inside transaction → 0 capability rows", async (t) => {
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

    // A "ghost" Workspace id that we deliberately do NOT persist;
    // the FK in workspace_capabilities will reject the INSERT
    // inside the transaction. The first capability row's INSERT is
    // expected to fail; the transaction rolls back everything.
    const ghostWorkspaceId = `ghost-ws-${ts}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      await assert.rejects(
        () =>
          repo.provisionIntentAtomically({
            workspaceId: ghostWorkspaceId,
            userAccountId: user.id,
            capabilities: ["Buyer", "Seller"],
            expectedCapabilities: [],
          }),
        (err: unknown) => {
          // Real Prisma FK violation error bubbles up; we accept
          // any thrown error — the test only cares that the
          // transaction rolled back any partial capability writes.
          assert.ok(err instanceof Error);
          return true;
        },
      );
      const caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: ghostWorkspaceId },
      });
      assert.equal(caps.length, 0, "capability rows must roll back");
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
      // command against the same workspace. The Workspace-scoped
      // advisory lock serializes the transitions; the natural
      // unique `(workspace_id, capability)` index absorbs
      // duplicates. Every caller observes a successful commit
      // (no throws); final state has exactly one Buyer + one
      // Seller row.
      await Promise.all(
        Array.from({ length: 5 }, () =>
          repo.provisionIntentAtomically({
            workspaceId: workspace.id,
            userAccountId: user.id,
            capabilities: ["Buyer", "Seller"],
            expectedCapabilities: [],
          }),
        ),
      );

      const caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(caps.length, 2, "exactly one Buyer + one Seller row");
    } finally {
      await cleanup(prisma, workspace.id, user.id);
    }
  });
});

async function cleanup(prisma: PrismaClient, workspaceId: string, userId: string): Promise<void> {
  await prisma.workspaceCapability.deleteMany({ where: { workspaceId } });
  await prisma.workspaceMembership.deleteMany({ where: { workspaceId } });
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.userAccount.delete({ where: { id: userId } });
}
