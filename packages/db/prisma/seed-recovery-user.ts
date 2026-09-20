// Test-only helper: seed a recovery-bound UserAccount so the
// M2 #82 Playwright spec can exercise the recovery surface.
//
// A recovery-bound user has TWO Owner Personal Workspace
// memberships. The convergence service's
// classifyPersonalWorkspaceState then classifies this user as
// `recovery: multiple-personal-workspaces` on sign-in, which
// drives the browser to render the `RecoverySurface`.
//
// Run via:
//   apps/api/node_modules/.bin/tsx packages/db/prisma/seed-recovery-user.ts <email>
//
// The script is fail-closed: it rejects any `TEST_DATABASE_URL`
// that does not match SoundHub's approved disposable PostgreSQL
// target. The leaf cannot reach a developer database or a remote
// database even if invoked directly outside the wrapper —
// every call path applies the same guard.
//
// M2 (#82 P2-001): the URL-only guard now lives in the sibling
// `packages/db/src/test-database-url.ts` module (also re-exported
// from `@soundhub/db`) so this leaf does NOT import from
// `apps/api/`. The previous cycle — this seed importing
// `apps/api/src/lib/test-database.ts`, which itself imports
// `@soundhub/db` — broke the documented package ownership and is
// pinned against re-introduction by
// `packages/db/src/__boundaries__/db-import-boundaries.test.ts`.

import { createHash } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { deriveDeterministicSubject } from "@soundhub/types";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../src/test-database-url.js";
import { PrismaClient } from "../src/generated/client.js";

export interface SeedRecoveryUserResult {
  readonly userAccountId: string;
  readonly workspace1Id: string;
  readonly workspace2Id: string;
}

/**
 * Seed a recovery-bound UserAccount on the approved disposable
 * test database. Fail-closed by `assertDisposableTestDatabase`
 * BEFORE any Prisma client is constructed.
 */
export async function seedRecoveryUser(email: string): Promise<SeedRecoveryUserResult> {
  if (!email) {
    throw new Error("seedRecoveryUser: email argument is required");
  }
  // Fail closed: reject any `TEST_DATABASE_URL` that is missing,
  // remote, the wrong port, or the wrong database name. This
  // guard runs BEFORE any Prisma client is constructed so a
  // misconfigured URL cannot open a connection.
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    const existing = await prisma.userAccount.findFirst({ where: { email } });
    if (existing) {
      await prisma.userAccount.update({
        where: { id: existing.id },
        data: { personalWorkspaceId: null },
      });
      await prisma.workspaceMembership.deleteMany({ where: { userId: existing.id } });
      await prisma.workspace.deleteMany({ where: { ownerUserId: existing.id } });
      await prisma.identityProvider.deleteMany({ where: { userAccountId: existing.id } });
      await prisma.userAccount.delete({ where: { id: existing.id } });
    }
    const sha256 = (i: string) => createHash("sha256").update(i).digest("hex");
    const subject = deriveDeterministicSubject(email, sha256);

    const user = await prisma.userAccount.create({ data: { email } });
    await prisma.identityProvider.create({
      data: {
        provider: "deterministic",
        subject,
        providerEmail: email,
        userAccountId: user.id,
      },
    });
    const ts = Date.now();
    const ws1 = await prisma.workspace.create({
      data: {
        slug: `recovery-personal-1-${ts}`,
        name: "Recovery Personal 1",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    const ws2 = await prisma.workspace.create({
      data: {
        slug: `recovery-personal-2-${ts}`,
        name: "Recovery Personal 2",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: ws1.id, role: "Owner" },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: ws2.id, role: "Owner" },
    });
    return {
      userAccountId: user.id,
      workspace1Id: ws1.id,
      workspace2Id: ws2.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("seed-recovery-user.ts");

if (isMainModule) {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: seed-recovery-user.ts <email> (requires TEST_DATABASE_URL)");
    process.exit(1);
  }
  seedRecoveryUser(email)
    .then((result) => {
      console.log(`✓ seeded recovery-bound user: ${email} (id=${result.userAccountId})`);
    })
    .catch((err: unknown) => {
      console.error("✗ seed-recovery-user failed:", err);
      process.exit(1);
    });
}
