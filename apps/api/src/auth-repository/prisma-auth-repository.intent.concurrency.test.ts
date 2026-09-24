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
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";

// Fail-closed guard: this test writes to PostgreSQL. The approved
// disposable database is the ONLY acceptable target. Match the
// sibling repository tests so a stray `TEST_DATABASE_URL` against
// the QA database or a remote host is rejected before any Prisma
// client is constructed.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe("PrismaAuthRepository intent concurrency (atomic command)", () => {
  let prisma: PrismaClient;
  let repo: PrismaAuthRepository;

  before(() => {
    if (!TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required for the disposable-test concurrency suite");
    }
    assertDisposableTestDatabase(readTestDatabaseUrl());
    prisma = createPrismaClient(readTestDatabaseUrl());
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
      expectedCapabilities: [] as const,
    };
    const N = 5;

    // N concurrent whole-command callers with the SAME observed
    // empty capability set. The Workspace-scoped advisory lock
    // serializes them; the natural unique
    // `(workspace_id, capability)` index absorbs duplicate
    // inserts idempotently inside the lock. Final state is
    // exactly one Buyer, one Seller capability row.
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
          expectedCapabilities: [],
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

  // ---- P0-001 invariant: simultaneous Hire vs Offer from an
  // empty baseline. The Workspace-scoped advisory lock must
  // serialize the two transitions. Exactly one wins; the other
  // observes the winner's committed row and conflicts. The final
  // persisted state MUST be a single capability row
  // (Buyer XOR Seller) — NEVER Buyer+Seller=Both.
  test("Simultaneous Hire-vs-Offer from empty baseline: one wins, the other conflicts; final state is a single capability row", async () => {
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-race-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-race-${ts}-${randomUUID().slice(0, 8)}`,
        name: "Intent Race Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });

    try {
      // Two disjoint first submissions racing on the same
      // empty Personal Workspace. Both carry
      // expectedCapabilities=[] (the state each caller
      // observed). The advisory lock serializes them.
      const hireCall = repo.provisionIntentAtomically({
        workspaceId: workspace.id,
        userAccountId: user.id,
        capabilities: ["Buyer"],
        expectedCapabilities: [],
      });
      const offerCall = repo.provisionIntentAtomically({
        workspaceId: workspace.id,
        userAccountId: user.id,
        capabilities: ["Seller"],
        expectedCapabilities: [],
      });

      const settled = await Promise.allSettled([hireCall, offerCall]);
      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter((s) => s.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one submission succeeds");
      assert.equal(rejected.length, 1, "exactly one submission conflicts");

      // The losing call's error is IntentConflictError; its
      // `existing` field reflects the winner's persisted
      // capability (one row, NOT both).
      const rejection = (rejected[0] as PromiseRejectedResult).reason as Error & {
        existing: readonly string[];
        fresh: readonly string[];
        expected: readonly string[];
      };
      assert.equal(rejection.name, "IntentConflictError");
      assert.equal(rejection.existing.length, 1, "loser sees exactly one persisted capability row");
      assert.deepEqual(rejection.expected, [], "loser's expectedCapabilities was empty");
      assert.equal(rejection.fresh.length, 1, "loser's fresh state is one row, not the union");

      // The final persisted state MUST be a single row
      // (Buyer XOR Seller, depending on which caller acquired
      // the lock first). NEVER Buyer+Seller.
      const finalCaps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
        select: { capability: true },
      });
      assert.equal(finalCaps.length, 1, "final state is exactly one row — no silent Both union");
      const only = finalCaps[0]!.capability;
      assert.ok(
        only === "Buyer" || only === "Seller",
        `final row is Buyer or Seller (got ${only}); never the unintended union`,
      );
    } finally {
      await prisma.workspaceCapability.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.userAccount.delete({ where: { id: user.id } });
    }
  });

  // Stale-precondition conflict on real PostgreSQL. UI observed
  // []; persisted state becomes Buyer; stale command submits
  // Offer with expected=[] — the atomic primitive detects the
  // mismatch and rolls back. The persisted state remains Buyer.
  test("Conflicting stale precondition (persisted=Buyer + Offer with expected=[]) throws and rolls back; zero Seller writes", async () => {
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-stale-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-stale-${ts}-${randomUUID().slice(0, 8)}`,
        name: "Intent Stale Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "Owner" },
    });

    try {
      // Persisted state = Buyer.
      await repo.provisionIntentAtomically({
        workspaceId: workspace.id,
        userAccountId: user.id,
        capabilities: ["Buyer"],
        expectedCapabilities: [],
      });
      let caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.deepEqual(caps.map((c) => c.capability).sort(), ["Buyer"]);

      // Stale UI submits Offer with expected=[] — the
      // primitive rejects; the transaction rolls back to zero
      // Seller rows.
      await assert.rejects(
        () =>
          repo.provisionIntentAtomically({
            workspaceId: workspace.id,
            userAccountId: user.id,
            capabilities: ["Seller"],
            expectedCapabilities: [],
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.name, "IntentConflictError");
          const e = err as Error & { existing: readonly string[] };
          assert.deepEqual(e.existing, ["Buyer"]);
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
      await prisma.workspaceCapability.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.userAccount.delete({ where: { id: user.id } });
    }
  });

  // Explicit later-add through the same atomic primitive.
  // Persisted = Buyer; expected = Buyer; chosen = Offer. The
  // primitive adds Seller only — final state = Both.
  test("Later-add Offer with expectedCapabilities=[Buyer] provisions Seller only; final state = [Buyer,Seller]", async () => {
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-later-add-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-later-add-${ts}-${randomUUID().slice(0, 8)}`,
        name: "Intent Later Add Personal",
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
        capabilities: ["Buyer"],
        expectedCapabilities: [],
      });
      // Later-add: UI observed Buyer; the customer explicitly
      // submits Offer to add Seller.
      await repo.provisionIntentAtomically({
        workspaceId: workspace.id,
        userAccountId: user.id,
        capabilities: ["Seller"],
        expectedCapabilities: ["Buyer"],
      });
      const caps = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.deepEqual(caps.map((c) => c.capability).sort(), ["Buyer", "Seller"]);
    } finally {
      await prisma.workspaceCapability.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.userAccount.delete({ where: { id: user.id } });
    }
  });

  // Idempotency with stale expectedCapabilities on real
  // PostgreSQL. Persisted = Both; expected = [] (the state the
  // human initially observed); chosen = Hire. The chosen set
  // {Buyer} is fully covered by persisted Both — the command is
  // a no-op success.
  test("Idempotent stale expected (persisted=Both + Hire with expected=[]) succeeds as no-op; zero writes", async () => {
    const ts = Date.now();
    const user = await prisma.userAccount.create({
      data: { email: `intent-idempotent-${ts}@example.test` },
    });
    const workspace = await prisma.workspace.create({
      data: {
        slug: `intent-idempotent-${ts}-${randomUUID().slice(0, 8)}`,
        name: "Intent Idempotent Personal",
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
      const before = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(before.length, 2);

      // Stale expected; chosen {Buyer} already covered.
      await repo.provisionIntentAtomically({
        workspaceId: workspace.id,
        userAccountId: user.id,
        capabilities: ["Buyer"],
        expectedCapabilities: [],
      });
      const after = await prisma.workspaceCapability.findMany({
        where: { workspaceId: workspace.id },
      });
      assert.equal(after.length, 2, "no new rows; idempotent no-op");
    } finally {
      await prisma.workspaceCapability.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: workspace.id } });
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.userAccount.delete({ where: { id: user.id } });
    }
  });
});
