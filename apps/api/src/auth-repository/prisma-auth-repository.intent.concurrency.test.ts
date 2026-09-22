// Concurrency correctness for intent capability provisioning (M2 #83).
//
// Disposable Postgres. Concurrent WHOLE-COMMAND
// `provisionIntentAtomically` calls against the same Workspace
// must converge on exactly one Buyer + one Seller capability row.
// The natural unique `(workspace_id, capability)` index is the
// concurrency authority — there is no application-level pre-check,
// no find-then-insert race window.
//
// #83 re-revision: intent does NOT collect a generic Seller
// participation/terms acceptance at capability-provisioning time;
// this test no longer covers acceptance. Idempotency and atomicity
// are tested through the public atomic command — the production
// entry point.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import type { PrismaClient } from "@soundhub/db";
import { PrismaAuthRepository } from "./prisma-auth-repository.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://soundhub:password@localhost:5433/soundhub_m1_test";

describe("PrismaAuthRepository intent concurrency (atomic command)", () => {
  let prisma: PrismaClient;
  let repo: PrismaAuthRepository;

  before(() => {
    prisma = createPrismaClient(TEST_DATABASE_URL);
    repo = new PrismaAuthRepository(prisma);
  });

  test("Concurrent whole-command converges on exactly one Buyer + Seller capability row", async () => {
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-conc-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-conc-${ts}-${randomUUID().slice(0, 8)}`,
        name: "Intent Concurrency Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    const input = {
      workspaceId: workspace.id,
      userAccountId: user.id,
      capabilities: ["Buyer", "Seller"] as const,
    };
    const N = 5;

    // N concurrent whole-command callers. Each one composes
    // capability upserts inside ONE Prisma transaction. The natural
    // unique `(workspace_id, capability)` index absorbs duplicate
    // capability inserts idempotently; the final state is exactly
    // one Buyer, one Seller capability row.
    await Promise.all(Array.from({ length: N }, () => repo.provisionIntentAtomically(input)));

    const caps = await prisma.workspaceCapability.findMany({
      where: { workspaceId: workspace.id },
    });
    assert.equal(caps.length, 2, "exactly one Buyer + one Seller capability row");

    // Cleanup.
    await prisma.workspaceCapability.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspaceMembership.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.userAccount.delete({ where: { id: user.id } });
  });

  test("Atomic command: idempotent Hire row (concurrent Buyer upserts)", async () => {
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-upsert-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-upsert-${ts}-${randomUUID().slice(0, 8)}`,
        name: "Intent Upsert Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });

    const N = 5;
    await Promise.all(
      Array.from({ length: N }, () =>
        repo.provisionIntentAtomically({
          workspaceId: workspace.id,
          userAccountId: user.id,
          capabilities: ["Buyer"],
        }),
      ),
    );

    const rows = await prisma.workspaceCapability.findMany({
      where: { workspaceId: workspace.id, capability: "Buyer" },
    });
    assert.equal(rows.length, 1);

    // Cleanup.
    await prisma.workspaceCapability.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspaceMembership.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.userAccount.delete({ where: { id: user.id } });
  });

  // Conflicting intent retry semantics on real PostgreSQL. The
  // repository's atomic primitive must reject a retry that would
  // silently widen / merge the capability set beyond what the
  // customer originally requested. The transaction must roll
  // back to the pre-call state; no unintended capability row is
  // written.
  test("Conflicting retry (Offer after Hire) throws and rolls back; zero unintended capability writes", async () => {
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-conflict-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-conflict-${ts}-${randomUUID().slice(0, 8)}`,
        name: "Intent Conflict Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "Owner" },
    });

    try {
      // First submission: Hire → Buyer capability row.
      await repo.provisionIntentAtomically({
        workspaceId: workspace.id,
        userAccountId: user.id,
        capabilities: ["Buyer"],
      });
      let caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.deepEqual(caps.map((c) => c.capability).sort(), ["Buyer"]);

      // Conflicting retry: Offer (Seller) would silently merge
      // into Buyer+Seller=Both. The atomic primitive must reject
      // it; the transaction rolls back to zero Seller rows.
      await assert.rejects(
        () =>
          repo.provisionIntentAtomically({
            workspaceId: workspace.id,
            userAccountId: user.id,
            capabilities: ["Seller"],
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          // The Prisma adapter throws `IntentConflictError`; the
          // service layer translates it to `INTENT_FORBIDDEN`.
          assert.equal(err.name, "IntentConflictError");
          return true;
        },
      );
      caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.deepEqual(
        caps.map((c) => c.capability).sort(),
        ["Buyer"],
        "transaction rolled back; no Seller row added",
      );
    } finally {
      // Cleanup.
      await prisma.workspaceCapability.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.userAccount.delete({ where: { id: user.id } });
    }
  });

  test("Proper-extension retry (Both after Hire) throws and rolls back; zero Seller row added", async () => {
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-extension-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-extension-${ts}-${randomUUID().slice(0, 8)}`,
        name: "Intent Extension Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "Owner" },
    });

    try {
      // First submission: Hire → Buyer only.
      await repo.provisionIntentAtomically({
        workspaceId: workspace.id,
        userAccountId: user.id,
        capabilities: ["Buyer"],
      });
      // Proper-extension retry: Both would silently widen to
      // Buyer+Seller — the customer must use the dedicated "add
      // the other capability" command (later boundary) instead.
      await assert.rejects(
        () =>
          repo.provisionIntentAtomically({
            workspaceId: workspace.id,
            userAccountId: user.id,
            capabilities: ["Buyer", "Seller"],
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.name, "IntentConflictError");
          return true;
        },
      );
      const caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.deepEqual(caps.map((c) => c.capability).sort(), ["Buyer"]);
    } finally {
      await prisma.workspaceCapability.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.userAccount.delete({ where: { id: user.id } });
    }
  });
});
