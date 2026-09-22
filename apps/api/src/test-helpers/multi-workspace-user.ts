// Test-only helper (M2 #83): seed a UserAccount with one Personal
// Workspace + one Organization Workspace + dual Owner membership.
//
// Used by the workspace-switch browser journey to exercise the
// cross-Workspace switch interstitial. The fixture is created
// directly against the test Prisma client — there is NO product
// flow for creating an Organization, inviting a user, or granting
// Owner membership. The fixture is for tests only; production
// code never imports it.
//
// Why this fixture exists:
//
//   - A `Workspace-switch` browser journey needs an authenticated
//     human with access to MORE than one Workspace so the deep-
//     link to a non-active resource triggers the interstitial.
//   - The #82 convergence invariant forbids two Personal
//     Workspaces owned by the same UserAccount. We cannot stage
//     the fixture as "two Personal Workspaces".
//   - The #83 review boundary forbids introducing Organization
//     creation/admin to satisfy the fixture.
//
// The fixture stages:
//   - one Personal Workspace + Owner membership (the production-
//     shaped first Workspace).
//   - one Organization Workspace + Owner membership on the SAME
//     UserAccount, seeded directly against Prisma (no invitations,
//     no admin path).
//
// Both memberships are persisted as `Owner` so the
// `requireActingMembership` check passes for either target. The
// fixture is intentionally minimal — it does NOT create
// capabilities, SellerProfile, ServiceOffering, or ProjectRequest
// rows; each test wires its own follow-on state.
//
// Run via `pnpm db:test:reset && tsx src/test-helpers/multi-workspace-user.ts <email>`,
// or imported directly from a test that holds a Prisma client.

import { randomUUID } from "node:crypto";
import {
  assertDisposableTestDatabase,
  createPrismaClient,
  readTestDatabaseUrl,
} from "@soundhub/db";

export interface MultiWorkspaceUserResult {
  readonly userAccountId: string;
  readonly personalWorkspaceId: string;
  readonly organizationWorkspaceId: string;
}

/**
 * Seed a multi-Workspace user against the approved disposable test
 * database. Fail-closed by `assertDisposableTestDatabase` BEFORE
 * any Prisma client is constructed.
 */
export async function seedMultiWorkspaceUser(email: string): Promise<MultiWorkspaceUserResult> {
  if (!email) {
    throw new Error("seedMultiWorkspaceUser: email argument is required");
  }
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);

  const prisma = createPrismaClient(url);
  try {
    // Idempotency: clear any prior state for this email so the
    // helper can be called repeatedly within the same test DB.
    const existing = await prisma.userAccount.findFirst({ where: { email } });
    if (existing) {
      await prisma.workspaceMembership.deleteMany({ where: { userId: existing.id } });
      await prisma.workspace.deleteMany({ where: { ownerUserId: existing.id } });
      await prisma.identityProvider.deleteMany({ where: { userAccountId: existing.id } });
      await prisma.userAccount.delete({ where: { id: existing.id } });
    }

    const user = await prisma.userAccount.create({ data: { email } });
    const ts = Date.now();
    const personalSlug = `multi-ws-personal-${ts}-${randomUUID().slice(0, 8)}`;
    const organizationSlug = `multi-ws-org-${ts}-${randomUUID().slice(0, 8)}`;
    const personal = await prisma.workspace.create({
      data: {
        slug: personalSlug,
        name: "Multi-Workspace Test Personal",
        type: "Personal",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    const organization = await prisma.workspace.create({
      data: {
        slug: organizationSlug,
        name: "Multi-Workspace Test Organization",
        type: "Organization",
        status: "Active",
        ownerUserId: user.id,
      },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: personal.id, role: "Owner" },
    });
    await prisma.workspaceMembership.create({
      data: { userId: user.id, workspaceId: organization.id, role: "Owner" },
    });
    // Set the Personal Workspace pointer so convergence classifies
    // the user as `converged` against the Personal Workspace. The
    // Organization Workspace remains accessible but is NOT the
    // Personal pointer — so a deep-link to the Organization
    // Workspace surfaces the cross-Workspace switch interstitial.
    await prisma.userAccount.update({
      where: { id: user.id },
      data: { personalWorkspaceId: personal.id },
    });
    return {
      userAccountId: user.id,
      personalWorkspaceId: personal.id,
      organizationWorkspaceId: organization.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("multi-workspace-user.ts");

if (isMainModule) {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: multi-workspace-user.ts <email> (requires TEST_DATABASE_URL)");
    process.exit(1);
  }
  seedMultiWorkspaceUser(email)
    .then((result) => {
      console.log(
        `✓ seeded multi-workspace user: ${email} (userId=${result.userAccountId} personal=${result.personalWorkspaceId} org=${result.organizationWorkspaceId})`,
      );
    })
    .catch((err: unknown) => {
      console.error("✗ seed-multi-workspace-user failed:", err);
      process.exit(1);
    });
}
