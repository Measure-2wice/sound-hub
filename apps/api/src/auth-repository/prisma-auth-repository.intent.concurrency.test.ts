// Concurrency correctness for intent acceptance persistence (M2 #83).
//
// Disposable Postgres. Concurrent WHOLE-COMMAND
// `provisionIntentAtomically` calls against the same Workspace
// must converge on exactly one Buyer + one Seller + one
// acceptance row. The natural unique indexes are the
// concurrency authority — there is no application-level pre-check,
// no find-then-insert race window.
//
// Per Codex CHANGES_REQUESTED P2-001: the standalone
// `recordSellerParticipationAcceptance` and `upsertCapability`
// primitives are no longer on the public AuthRepository contract.
// Idempotency and atomicity are tested through the public
// atomic command — the production entry point.

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

  test("Concurrent whole-command converges on exactly one Buyer + Seller + acceptance row", async () => {
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
    const termsVersion = `1.0.${ts}`;
    const termsContentHash = "a".repeat(64);
    const input = {
      workspaceId: workspace.id,
      userAccountId: user.id,
      capabilities: ["Buyer", "Seller"] as const,
      acceptance: {
        termsVersion,
        termsContentHash,
        grantedByUserId: user.id,
      },
    };
    const N = 5;

    // N concurrent whole-command callers. Each one composes
    // capability upserts + acceptance insert inside ONE Prisma
    // transaction. The natural unique indexes absorb duplicate
    // capability inserts and duplicate acceptance inserts
    // idempotently; the final state is exactly one Buyer, one
    // Seller, one acceptance row.
    await Promise.all(Array.from({ length: N }, () => repo.provisionIntentAtomically(input)));

    const caps = await prisma.workspaceCapability.findMany({
      where: { workspaceId: workspace.id },
    });
    assert.equal(caps.length, 2, "exactly one Buyer + one Seller capability row");

    const acceptances = await prisma.sellerParticipationAcceptance.findMany({
      where: { workspaceId: workspace.id, termsVersion },
    });
    assert.equal(acceptances.length, 1, "exactly one acceptance row");

    // Cleanup.
    await prisma.sellerParticipationAcceptance.deleteMany({
      where: { workspaceId: workspace.id },
    });
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
          acceptance: null,
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
});
