// Concurrency correctness for intent acceptance persistence (M2 #83).
//
// Disposable Postgres. Two concurrent `recordSellerParticipationAcceptance`
// calls against the same `(workspaceId, termsVersion)` must produce
// exactly ONE row in `seller_participation_acceptances`. The
// application relies on the natural unique index as the concurrency
// authority — there is no application-level pre-check, no find-then-
// insert race window.
//
// The repository primitive uses
// `INSERT ... ON CONFLICT (workspace_id, terms_version) DO NOTHING
// RETURNING *`; when the ON CONFLICT path fires, the primitive reads
// back the existing row by `(workspaceId, termsVersion)` and returns
// it. Both submissions return the same `id`.
//
// This test pins the database-level invariant: regardless of how
// many concurrent submissions arrive, exactly one acceptance row
// exists per `(workspaceId, termsVersion)` tuple.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import type { PrismaClient } from "@soundhub/db";
import { PrismaAuthRepository } from "./prisma-auth-repository.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://soundhub:password@localhost:5433/soundhub_m1_test";

describe("PrismaAuthRepository intent concurrency", () => {
  let prisma: PrismaClient;
  let repo: PrismaAuthRepository;

  before(() => {
    prisma = createPrismaClient(TEST_DATABASE_URL);
    repo = new PrismaAuthRepository(prisma);
  });

  test("two concurrent recordSellerParticipationAcceptance calls produce exactly one row", async () => {
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
      termsVersion,
      termsContentHash,
      acceptedByUserId: user.id,
      grantedByUserId: user.id,
    };

    // Two concurrent submissions.
    const [r1, r2] = await Promise.all([
      repo.recordSellerParticipationAcceptance(input),
      repo.recordSellerParticipationAcceptance(input),
    ]);

    // Both return the same `id` (the database's existing row OR
    // the freshly inserted row — either way, exactly one row).
    assert.equal(r1.id, r2.id);
    assert.equal(r1.workspaceId, workspace.id);
    assert.equal(r1.termsVersion, termsVersion);
    assert.equal(r1.termsContentHash, termsContentHash);

    // Database-level invariant: exactly one row exists.
    const rows = await prisma.sellerParticipationAcceptance.findMany({
      where: { workspaceId: workspace.id, termsVersion },
    });
    assert.equal(rows.length, 1);

    // Cleanup.
    await prisma.sellerParticipationAcceptance.deleteMany({
      where: { workspaceId: workspace.id },
    });
    await prisma.workspaceMembership.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspace.delete({ where: { id: workspace.id } });
    await prisma.userAccount.delete({ where: { id: user.id } });
  });

  test("upsertCapability against the same (workspaceId, capability) is idempotent", async () => {
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

    await repo.upsertCapability({ workspaceId: workspace.id, capability: "Buyer" });
    await repo.upsertCapability({ workspaceId: workspace.id, capability: "Buyer" });

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
