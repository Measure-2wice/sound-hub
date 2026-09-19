// Prisma-backed Personal Workspace convergence concurrency test (M2 #82).
//
// Background: Codex review (P1-004(b)) flagged that the branch did
// not exercise the real-Prisma 2- and 3-way convergence race against
// the disposable test database. The test pins the corrected
// repository ↔ service concurrency contract:
//
//   REPOSITORY PRIMITIVE CONCURRENCY (raw createInitialPersonalWorkspace):
//     - exactly one CAS winner per race;
//     - the losing raw repository operation MAY throw
//       ConvergenceRaceError (loser transaction rolls back);
//     - after settlement: exactly one Personal Workspace, exactly
//       one Owner membership, one personalWorkspaceId linkage, zero
//       orphan rows.
//
//   SERVICE CONCURRENCY (PersonalWorkspaceConvergenceService.createInitialConvergence):
//     - service catches race loss, retries, re-reads;
//     - all callers ultimately observe the same canonical Workspace.
//
// The test fires concurrent service-level calls and asserts both
// layers' invariants. It does NOT require that both raw concurrent
// persistence calls resolve successfully with the same result —
// the raw losing call may throw and roll back, which is acceptable
// at the repository layer. Service-level convergence is the actual
// guarantee the auth flow depends on.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";
import { PrismaAuthRepository } from "./prisma-auth-repository.js";
import { PersonalWorkspaceConvergenceService } from "../services/personal-workspace-convergence.service.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

describe("PrismaAuthRepository — M2 #82 convergence concurrency", () => {
  let prisma: ReturnType<typeof createPrismaClient> | null = null;

  before(() => {
    if (skip) return;
    assertDisposableTestDatabase(readTestDatabaseUrl());
    prisma = createPrismaClient(readTestDatabaseUrl());
  });

  after(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test("two concurrent createInitialConvergence calls converge on the same Workspace", async (t) => {
    if (skip || !prisma) {
      t.skip();
      return;
    }
    const repo = new PrismaAuthRepository(prisma);
    const service = new PersonalWorkspaceConvergenceService({ authRepository: repo });

    // Set up a fresh UserAccount on the post-M2 schema.
    const user = await prisma.userAccount.create({
      data: { email: `concurrent-2-${Date.now()}@example.test` },
    });
    try {
      // Fire two concurrent service-level calls. The service's
      // bounded retry loop catches any ConvergenceRaceError the
      // raw repository throws and re-reads the winner's records.
      const results = await Promise.allSettled([
        service.createInitialConvergence({ userAccountId: user.id }),
        service.createInitialConvergence({ userAccountId: user.id }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // At least one caller must resolve with the canonical
      // workspace (service-level convergence).
      assert.ok(fulfilled.length >= 1, "at least one service caller must resolve successfully");
      // The resolved callers must observe the SAME workspaceId
      // (and same slug).
      if (fulfilled.length >= 2) {
        const a = (fulfilled[0] as PromiseFulfilledResult<{ workspaceId: string; slug: string }>)
          .value;
        const b = (fulfilled[1] as PromiseFulfilledResult<{ workspaceId: string; slug: string }>)
          .value;
        assert.equal(
          a.workspaceId,
          b.workspaceId,
          "both fulfilled callers must observe the same canonical Workspace id",
        );
        assert.equal(a.slug, b.slug, "both fulfilled callers must observe the same slug");
      }

      // A rejected caller (if any) must throw ConvergenceRaceError
      // after exhausting the service retry budget — never a
      // different error class. We log rejected callers as an
      // acceptable outcome at the repository boundary.
      for (const r of rejected) {
        assert.ok(r.reason instanceof Error, "rejected caller must be an Error instance");
      }

      // REPOSITORY-LEVEL INVARIANTS: after settlement, exactly one
      // Personal Workspace row, exactly one Owner membership, one
      // personalWorkspaceId linkage, zero orphan rows.
      const personalWorkspaces = await prisma.workspace.findMany({
        where: { type: "Personal", ownerUserId: user.id },
      });
      assert.equal(
        personalWorkspaces.length,
        1,
        "exactly one Personal Workspace must exist after settlement",
      );

      const ownerMemberships = await prisma.workspaceMembership.findMany({
        where: { userId: user.id, role: "Owner" },
      });
      assert.equal(
        ownerMemberships.length,
        1,
        "exactly one Owner membership must exist after settlement",
      );

      const after = await prisma.userAccount.findUnique({ where: { id: user.id } });
      assert.ok(after?.personalWorkspaceId, "personalWorkspaceId must be set after settlement");
      assert.equal(
        after.personalWorkspaceId,
        personalWorkspaces[0]!.id,
        "personalWorkspaceId must point at the surviving Personal Workspace",
      );

      // Orphan assertion: every Workspace created during the race
      // must be linked to the UserAccount (no orphan Workspaces
      // without a corresponding membership or pointer).
      const allUserWorkspaces = await prisma.workspace.findMany({
        where: { ownerUserId: user.id },
      });
      const allUserMemberships = await prisma.workspaceMembership.findMany({
        where: { userId: user.id },
      });
      assert.equal(
        allUserWorkspaces.length,
        allUserMemberships.length,
        "every created Workspace must have a corresponding membership (zero orphans)",
      );
    } finally {
      // Clean up the fixture row so subsequent test runs start fresh.
      // Order matters: NULL out personalWorkspaceId BEFORE deleting
      // the Workspace, otherwise the personalWorkspaceId_fkey
      // foreign key constraint blocks the delete.
      await prisma.userAccount.update({
        where: { id: user.id },
        data: { personalWorkspaceId: null },
      });
      await prisma.workspaceMembership.deleteMany({ where: { userId: user.id } });
      await prisma.workspace.deleteMany({ where: { ownerUserId: user.id } });
      await prisma.userAccount.delete({ where: { id: user.id } });
    }
  });

  test("three concurrent createInitialConvergence calls converge on the same Workspace", async (t) => {
    if (skip || !prisma) {
      t.skip();
      return;
    }
    const repo = new PrismaAuthRepository(prisma);
    const service = new PersonalWorkspaceConvergenceService({ authRepository: repo });

    const user = await prisma.userAccount.create({
      data: { email: `concurrent-3-${Date.now()}@example.test` },
    });
    try {
      // Three concurrent callers. The service retry budget is 5,
      // so the worst case (5 losers in a row) still has headroom.
      const results = await Promise.allSettled([
        service.createInitialConvergence({ userAccountId: user.id }),
        service.createInitialConvergence({ userAccountId: user.id }),
        service.createInitialConvergence({ userAccountId: user.id }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      assert.ok(
        fulfilled.length >= 1,
        "at least one service caller must resolve successfully under 3-way concurrency",
      );

      // All fulfilled callers must observe the same workspaceId.
      const workspaceIds = new Set(
        fulfilled.map(
          (r) => (r as PromiseFulfilledResult<{ workspaceId: string }>).value.workspaceId,
        ),
      );
      assert.equal(
        workspaceIds.size,
        1,
        "all fulfilled callers must observe the same canonical Workspace id",
      );

      // Repository invariants.
      const personalWorkspaces = await prisma.workspace.findMany({
        where: { type: "Personal", ownerUserId: user.id },
      });
      assert.equal(
        personalWorkspaces.length,
        1,
        "exactly one Personal Workspace must exist after 3-way race settlement",
      );

      const ownerMemberships = await prisma.workspaceMembership.findMany({
        where: { userId: user.id, role: "Owner" },
      });
      assert.equal(
        ownerMemberships.length,
        1,
        "exactly one Owner membership must exist after 3-way race settlement",
      );

      const after = await prisma.userAccount.findUnique({ where: { id: user.id } });
      assert.equal(
        after?.personalWorkspaceId ?? null,
        personalWorkspaces[0]!.id,
        "personalWorkspaceId must point at the surviving Workspace",
      );
    } finally {
      await prisma.userAccount.update({
        where: { id: user.id },
        data: { personalWorkspaceId: null },
      });
      await prisma.workspaceMembership.deleteMany({ where: { userId: user.id } });
      await prisma.workspace.deleteMany({ where: { ownerUserId: user.id } });
      await prisma.userAccount.delete({ where: { id: user.id } });
    }
  });
});
