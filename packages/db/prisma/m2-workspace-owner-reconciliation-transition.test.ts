/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

// M2.0B / Issue #16: Reconcile M1.1 workspace owners — transition coverage.
//
// The transition test proves the #16 reconciliation migration by:
//   1. Building an M1.1 baseline with representative ownerUserId states
//      (orphaned, non-Owner membership, already-correct Owner membership).
//   2. Applying the M2.0A expand migration (#15).
//   3. Applying the #16 reconciliation migration.
//   4. Observing the correct post-reconciliation state for each case.
//
// The reconciliation is a separate follow-up migration that runs after #15
// and before M2 membership lifecycle behavior is introduced. It does NOT
// rewrite or reapply #15's integrated migration backfill.
//
// Acceptance criteria covered:
//   [x] A Workspace whose ownerUserId has no membership gains an active Owner membership.
//   [x] A Workspace whose ownerUserId has an Admin/Member membership is reconciled to Owner.
//   [x] An already-correct Owner membership remains stable and is not duplicated.
//   [x] Deterministic and respects the unique (userId, workspaceId) membership invariant.
//   [x] Transition fixtures cover all three cases.
//   [x] Retry/recovery procedure is proven against already-reconciled state.
//   [x] #15 guarantees (published revisions, stable IDs, anonymous search) remain green.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.js";

const APPROVED_DATABASE = "soundhub_m1_test";
const APPROVED_PORT = 5433;
const APPROVED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

class TestGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestGuardError";
  }
}

function resolveDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new TestGuardError("TEST_DATABASE_URL is not set");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new TestGuardError(`invalid URL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TestGuardError(`not a postgres URL: ${parsed.protocol}`);
  }
  if (!APPROVED_HOSTS.has(parsed.hostname)) {
    throw new TestGuardError(`host ${parsed.hostname} is not an approved local host`);
  }
  if (Number(parsed.port || 5432) !== APPROVED_PORT) {
    throw new TestGuardError(`port ${parsed.port} must be ${APPROVED_PORT}`);
  }
  const database = parsed.pathname.replace(/^\/+/, "");
  if (database !== APPROVED_DATABASE) {
    throw new TestGuardError(`database ${database} must be ${APPROVED_DATABASE}`);
  }
  return url;
}

let prisma: PrismaClient;
let databaseUrl: string;

before(() => {
  databaseUrl = resolveDatabaseUrl();
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
});

after(async () => {
  // Restore the database to a clean post-migration + post-reconciliation state.
  // The transition test inserts synthetic fixtures and then runs #15 + #16.
  // Restoration drops the public schema, re-applies all migrations, and re-runs
  // the seed so subsequent test suites see canonical state.
  await prisma.$executeRawUnsafe(
    'DROP SCHEMA IF EXISTS "public" CASCADE; CREATE SCHEMA "public";',
  );
  await prisma.$disconnect();
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited with code ${code}`));
    });
  });
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  await runSeedInChild();
});

async function runSeedInChild(): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "prisma/seed.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed exited with code ${code}`));
    });
  });
}

function loadMigrationSql(filename: string): string {
  return readFileSync(new URL(filename, import.meta.url).pathname, "utf8");
}

function loadM11MigrationSqls(): string[] {
  return [
    loadMigrationSql("./migrations/20260808114423_m1_foundation/migration.sql"),
    loadMigrationSql("./migrations/20260808120000_drop_seed_markers/migration.sql"),
  ];
}

async function resetToM11Baseline(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'DROP SCHEMA IF EXISTS "public" CASCADE; CREATE SCHEMA "public";',
  );
  for (const sql of loadM11MigrationSqls()) {
    await prisma.$executeRawUnsafe(sql);
  }
}

async function applyMigrationSql(sql: string): Promise<void> {
  await prisma.$executeRawUnsafe(sql);
}

// loadReconciliationFixtures: insert representative M1.1 baseline fixtures
// that exercise all four reconciliation cases after #15 is applied:
//
//   Case A — orphaned ownerUserId: workspace has ownerUserId set but
//             NO corresponding membership. #16 must create an active
//             Owner membership.
//
//   Case B — non-Owner membership: workspace has ownerUserId set and
//             the user HAS a membership, but the authority is not Owner
//             (e.g., Editor from a prior invite flow). #16 must
//             reconcile authority to Owner without changing role.
//
//   Case C — already-correct: workspace has ownerUserId set and the
//             user already has an active Owner membership. #16 must
//             leave it stable and not duplicate.
//
//   Case D — control (no ownerUserId): workspace has no ownerUserId.
//             #16 must not create any membership for it.
//             Constructed AFTER #15 (see applyPost15NullOwnerControl)
//             because M1.1 requires ownerUserId NOT NULL.
//
//   Case E — removed membership (control): workspace has ownerUserId
//             set and a membership row exists but removedAt is NOT NULL.
//             #16 must NOT reactivate a deliberately removed membership.
//             Constructed AFTER #15 (see applyPost15RemovedMembership)
//             because removedAt does not exist in M1.1.
//
// Raw SQL is used because the Prisma client expects the post-migration
// schema, so .create() calls would fail with column-not-found against
// the M1.1-only baseline.
//
// NOTE: This function inserts ONLY M1.1 columns. The M2-only `authority`
// and `removedAt` columns are NOT present in the M1.1 schema and cannot
// be inserted here. After #15 runs, authority is automatically backfilled
// from role (Owner->Owner, Admin/Member->Editor). Case B's membership
// is created with role=Admin; #15 backfills authority=Editor, which is
// the pre-reconciliation state we need to verify the Step 2 reconciliation.
async function loadReconciliationFixtures(): Promise<{
  categoryId: string;
  offeringId: string;
}> {
  // One controlled category (needed for offerings) — uses gen_random_uuid()
  // so it never conflicts with seeded categories that use hard-coded keys.
  const categoryRow = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO service_categories (id, key, name, description, "bundleOnly", "createdAt")
    VALUES (gen_random_uuid()::text, 'music-production-recon', 'Music Production', 'Reconciliation test', false, NOW())
    RETURNING id
  `;
  const categoryId = categoryRow[0]?.id ?? "";

  // Four distinct users (one per case)
  for (const [id, email] of [
    ["user-recon-a", "owner-a@recon.test"],
    ["user-recon-b", "owner-b@recon.test"],
    ["user-recon-c", "owner-c@recon.test"],
    ["user-recon-d", "no-owner@recon.test"],
  ] as [string, string][]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO user_accounts (id, email, "createdAt", "updatedAt") VALUES ('${id}', '${email}', NOW(), NOW())`,
    );
  }

  // Three workspaces (M1.1-valid: each has a non-null ownerUserId):
  //   A: ownerUserId = userA, NO membership  → #16 creates Owner membership
  //   B: ownerUserId = userB, has Admin membership → #16 reconciles to Owner
  //   C: ownerUserId = userC, has Owner membership → #16 leaves stable
  // Case D (ownerUserId = NULL) is constructed AFTER #15 in
  // applyPost15NullOwnerControl because M1.1 requires ownerUserId NOT NULL.
  for (const [id, slug, ownerId] of [
    ["ws-recon-a", "recon-a", "user-recon-a"],
    ["ws-recon-b", "recon-b", "user-recon-b"],
    ["ws-recon-c", "recon-c", "user-recon-c"],
  ] as [string, string, string][]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO workspaces (id, slug, name, type, status, "ownerUserId", "createdAt", "updatedAt") VALUES ('${id}', '${slug}', 'Reconciliation ${slug}', 'Personal', 'Active', '${ownerId}', NOW(), NOW())`,
    );
  }

  // Seller capability for the M1.1-valid workspaces. Case D is excluded —
  // its workspace is constructed post-#15 and its assertions do not
  // reference capabilities, so creating one here is unnecessary.
  for (const wsId of ["ws-recon-a", "ws-recon-b", "ws-recon-c"]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO workspace_capabilities (id, "workspaceId", capability) VALUES ('cap-${wsId}', '${wsId}', 'Seller')`,
    );
  }

  // Seller profiles — created with Published status so they are canonical
  // and #15's backfill creates SellerProfileRevision rows for them.
  // Case D is excluded: its workspace is constructed post-#15 and the
  // Case D assertions do not reference a seller profile.
  for (const [spId, wsId, name] of [
    ["sp-recon-a", "ws-recon-a", "Reconciliation Seller A"],
    ["sp-recon-b", "ws-recon-b", "Reconciliation Seller B"],
    ["sp-recon-c", "ws-recon-c", "Reconciliation Seller C"],
  ] as [string, string, string][]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO seller_profiles (id, "workspaceId", "professionalName", bio, status, "basedInCountryCode", "createdAt", "updatedAt") VALUES ('${spId}', '${wsId}', '${name}', 'Bio', 'Published', 'US', NOW(), NOW())`,
    );
  }

  // An Active offering for ws-recon-a (seller sp-recon-a). This is created
  // BEFORE #15 runs so that #15's backfill creates the ServiceOfferingRevision.
  // The offering id is returned so the regression test can reference it.
  const offeringRow = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO service_offerings (id, slug, "sellerProfileId", title, description, status, "serviceMode", "primaryCategoryId", "genreTags", "createdAt", "updatedAt")
    VALUES ('of-recon-a', 'recon-offering-a', 'sp-recon-a', 'Reconciliation Offering A', 'An offering to verify #15 guarantees.', 'Active', 'Remote', ${categoryId}, ARRAY['Dancehall']::text[], NOW(), NOW())
    RETURNING id
  `;
  const offeringId = offeringRow[0]?.id ?? "";

  // Case B: userB already has a membership but with Admin role.
  // After #15 runs, authority will be backfilled as Editor (Admin->Editor).
  // This is the pre-reconciliation state that Step 2 of #16 must
  // reconcile to Owner authority.
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspace_memberships (id, "userId", "workspaceId", role, "createdAt") VALUES ('mem-recon-b-existing', 'user-recon-b', 'ws-recon-b', 'Admin'::"WorkspaceMembershipRole", NOW())`,
  );

  // Case C: userC already has the correct active Owner membership.
  // After #15 runs, authority will be backfilled as Owner (Owner->Owner).
  // This is already-reconciled state; #16 must leave it stable.
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspace_memberships (id, "userId", "workspaceId", role, "createdAt") VALUES ('mem-recon-c-correct', 'user-recon-c', 'ws-recon-c', 'Owner'::"WorkspaceMembershipRole", NOW())`,
  );

  // Case E: userE has a workspace with ownerUserId set. The removed
  // membership (removedAt IS NOT NULL) is created AFTER #15 applies
  // because removedAt does not exist in the M1.1 schema. #16 must NOT
  // reactivate it (removedAt stays non-NULL).
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_accounts (id, email, "createdAt", "updatedAt") VALUES ('user-recon-e', 'removed-owner@recon.test', NOW(), NOW())`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspaces (id, slug, name, type, status, "ownerUserId", "createdAt", "updatedAt") VALUES ('ws-recon-e', 'recon-e', 'Reconciliation E', 'Personal', 'Active', 'user-recon-e', NOW(), NOW())`,
  );

  return { categoryId, offeringId };
}

// applyPost15NullOwnerControl: create the Case D NULL-owner workspace
// AFTER #15 has applied (so workspaces.ownerUserId is nullable). This
// is called inside setupMigrationsUpTo15 so every test that uses the
// shared setup gets the M2-only control state. Case D is the control
// that proves #16 does not create a membership for a workspace whose
// ownerUserId is NULL.
async function applyPost15NullOwnerControl(): Promise<void> {
  // Case D: insert a workspace with ownerUserId = NULL. This state is
  // only valid AFTER #15 has made ownerUserId nullable.
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspaces (id, slug, name, type, status, "ownerUserId", "createdAt", "updatedAt") VALUES ('ws-recon-d', 'recon-d', 'Reconciliation D', 'Personal', 'Active', NULL, NOW(), NOW())`,
  );
}

// applyPost15RemovedMembership: create the Case E removed membership
// AFTER #15 has applied (so removedAt column exists). This is called
// inside setupMigrationsUpTo15 so every test that uses the shared setup
// gets the removed membership state. Tests that do not need Case E
// (e.g., the #15 boundary check) run setupMigrationsUpTo15 but the
// removed membership is inert for those cases.
async function applyPost15RemovedMembership(): Promise<void> {
  // Case E: insert a membership with removedAt NOT NULL. This workspace
  // has ownerUserId set; the deliberately deactivated membership must NOT
  // be reactivated by #16 reconciliation.
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspace_memberships (id, "userId", "workspaceId", role, authority, "createdAt", "removedAt") VALUES ('mem-recon-e-removed', 'user-recon-e', 'ws-recon-e', 'Owner'::"WorkspaceMembershipRole", 'Owner'::"WorkspaceMembershipAuthority", NOW(), NOW())`,
  );
}

// Shared setup: reset to M1.1, load fixtures (M1.1 columns only), apply #15,
// then apply post-#15 M2-only fixture state (Case D NULL-owner workspace and
// Case E removed membership — both require schema changes introduced by #15).
async function setupMigrationsUpTo15(): Promise<{ categoryId: string; offeringId: string }> {
  await resetToM11Baseline();
  const { categoryId, offeringId } = await loadReconciliationFixtures();
  await applyMigrationSql(
    loadMigrationSql("./migrations/20260816013319_m2_foundation_expand/migration.sql"),
  );
  // Case D NULL-owner workspace requires ownerUserId to be nullable, which
  // #15 introduces. Insert it after #15 is applied.
  await applyPost15NullOwnerControl();
  // Case E removed membership requires the removedAt column, which #15
  // introduces. Insert it after #15 is applied.
  await applyPost15RemovedMembership();
  return { categoryId, offeringId };
}

describe("M2.0B / Issue #16 workspace owner reconciliation transition coverage", () => {
  test("Case A: workspace with orphaned ownerUserId (no membership) gains an active Owner membership", async () => {
    await setupMigrationsUpTo15();

    // Verify pre-reconciliation state: workspace A has ownerUserId but NO membership.
    const preMembership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-a", workspaceId: "ws-recon-a" } },
    });
    assert.equal(
      preMembership,
      null,
      "precondition: workspace A must have no membership before #16 reconciliation",
    );

    // Apply the #16 reconciliation.
    await applyMigrationSql(
      loadMigrationSql(
        "./migrations/20260819000000_m2_workspace_owner_reconciliation/migration.sql",
      ),
    );

    // Post-reconciliation: workspace A must have an active Owner membership.
    const postMembership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-a", workspaceId: "ws-recon-a" } },
    });
    assert.ok(
      postMembership,
      "workspace A must have a membership after #16 reconciliation",
    );
    assert.equal(
      postMembership.authority,
      "Owner",
      "the created membership must have authority = Owner",
    );
    assert.equal(
      postMembership.role,
      "Owner",
      "the created membership must have role = Owner (the M1.1 legacy column is also set correctly)",
    );
    assert.equal(
      postMembership.removedAt,
      null,
      "the created membership must be active (removedAt = NULL)",
    );

    // Exactly one membership for this (userId, workspaceId) pair.
    const allMemberships = await prisma.workspaceMembership.findMany({
      where: { userId: "user-recon-a", workspaceId: "ws-recon-a" },
    });
    assert.equal(
      allMemberships.length,
      1,
      "exactly one membership must exist for workspace A (no duplication)",
    );
  });

  test("Case B: workspace whose ownerUserId has a non-Owner membership is reconciled to Owner authority", async () => {
    await setupMigrationsUpTo15();

    // After #15, authority is backfilled from role (Admin -> Editor).
    // Verify pre-reconciliation state: authority is Editor (not Owner).
    const preMembership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-b", workspaceId: "ws-recon-b" } },
    });
    assert.ok(
      preMembership,
      "precondition: workspace B must have a membership before reconciliation",
    );
    assert.equal(
      preMembership.authority,
      "Editor",
      "precondition: the existing membership must be Editor authority before #16 (backfilled from Admin role by #15)",
    );
    assert.equal(
      preMembership.role,
      "Admin",
      "precondition: the existing membership role must be Admin",
    );

    // Apply the #16 reconciliation.
    await applyMigrationSql(
      loadMigrationSql(
        "./migrations/20260819000000_m2_workspace_owner_reconciliation/migration.sql",
      ),
    );

    // Post-reconciliation: authority must be reconciled to Owner.
    // The role column must NOT be changed (preserved as legacy correspondence).
    const postMembership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-b", workspaceId: "ws-recon-b" } },
    });
    assert.ok(postMembership, "workspace B must still have exactly one membership");
    assert.equal(
      postMembership.authority,
      "Owner",
      "authority must be reconciled to Owner",
    );
    assert.equal(
      postMembership.role,
      "Admin",
      "role must NOT be changed (legacy correspondence preserved — Admin is not rewritten to Owner merely to mirror authority)",
    );
    assert.equal(
      postMembership.removedAt,
      null,
      "membership must remain active",
    );

    // Exactly one membership (no duplication).
    const all = await prisma.workspaceMembership.findMany({
      where: { userId: "user-recon-b", workspaceId: "ws-recon-b" },
    });
    assert.equal(
      all.length,
      1,
      "exactly one membership must exist for workspace B (no duplication)",
    );
  });

  test("Case C: workspace with already-correct Owner membership remains stable and is not duplicated", async () => {
    await setupMigrationsUpTo15();

    // Verify pre-reconciliation state.
    const preMembership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-c", workspaceId: "ws-recon-c" } },
    });
    assert.ok(
      preMembership,
      "precondition: workspace C must have an Owner membership before reconciliation",
    );
    assert.equal(preMembership.authority, "Owner");
    assert.equal(preMembership.role, "Owner");
    assert.equal(preMembership.removedAt, null);

    // Capture id and createdAt for stability assertion.
    const preId = preMembership.id;
    const preCreatedAt = preMembership.createdAt;

    // Apply the #16 reconciliation.
    await applyMigrationSql(
      loadMigrationSql(
        "./migrations/20260819000000_m2_workspace_owner_reconciliation/migration.sql",
      ),
    );

    // Post-reconciliation: membership must be unchanged (stable, no duplicate).
    const postMembership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-c", workspaceId: "ws-recon-c" } },
    });
    assert.ok(postMembership, "workspace C must still have a membership");
    assert.equal(postMembership.authority, "Owner");
    assert.equal(postMembership.role, "Owner");
    assert.equal(postMembership.removedAt, null);

    // Stability: id and createdAt must be preserved (not regenerated).
    assert.equal(
      postMembership.id,
      preId,
      "membership id must be preserved (not regenerated) after #16 reconciliation",
    );
    assert.equal(
      postMembership.createdAt.getTime(),
      preCreatedAt.getTime(),
      "membership createdAt must be preserved (not regenerated) after #16 reconciliation",
    );

    // Exactly one membership (no duplication).
    const all = await prisma.workspaceMembership.findMany({
      where: { userId: "user-recon-c", workspaceId: "ws-recon-c" },
    });
    assert.equal(
      all.length,
      1,
      "already-correct Owner membership must not be duplicated",
    );
  });

  test("Case D (control): workspace with no ownerUserId is not affected by reconciliation", async () => {
    await setupMigrationsUpTo15();

    // Verify pre-reconciliation: workspace D has no ownerUserId and no membership.
    const preWorkspace = await prisma.workspace.findUnique({
      where: { id: "ws-recon-d" },
    });
    assert.equal(
      preWorkspace?.ownerUserId,
      null,
      "precondition: workspace D must have no ownerUserId",
    );
    const preMembership = await prisma.workspaceMembership.findMany({
      where: { workspaceId: "ws-recon-d" },
    });
    assert.equal(
      preMembership.length,
      0,
      "precondition: workspace D must have no memberships before reconciliation",
    );

    // Apply the #16 reconciliation.
    await applyMigrationSql(
      loadMigrationSql(
        "./migrations/20260819000000_m2_workspace_owner_reconciliation/migration.sql",
      ),
    );

    // Post-reconciliation: workspace D must still have no ownerUserId and no membership.
    const postWorkspace = await prisma.workspace.findUnique({
      where: { id: "ws-recon-d" },
    });
    assert.equal(postWorkspace?.ownerUserId, null);
    const postMemberships = await prisma.workspaceMembership.findMany({
      where: { workspaceId: "ws-recon-d" },
    });
    assert.equal(
      postMemberships.length,
      0,
      "workspace with no ownerUserId must not gain a membership from reconciliation",
    );
  });

  test("Case E (control): workspace whose ownerUserId has a removed membership is NOT reactivated by reconciliation", async () => {
    await setupMigrationsUpTo15();

    // Verify pre-reconciliation: workspace E has ownerUserId but its membership
    // has removedAt NOT NULL (deliberately deactivated by later M2 behavior).
    const preMembership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-e", workspaceId: "ws-recon-e" } },
    });
    assert.ok(
      preMembership,
      "precondition: workspace E must have a membership before reconciliation",
    );
    assert.notEqual(
      preMembership.removedAt,
      null,
      "precondition: workspace E membership must be removed (removedAt IS NOT NULL)",
    );
    assert.equal(
      preMembership.authority,
      "Owner",
      "precondition: removed membership has Owner authority from M1.1 role",
    );

    // Apply the #16 reconciliation.
    await applyMigrationSql(
      loadMigrationSql(
        "./migrations/20260819000000_m2_workspace_owner_reconciliation/migration.sql",
      ),
    );

    // Post-reconciliation: the removed membership must remain removed.
    // #16 must NOT reactivate a deliberately removed membership.
    const postMembership = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-e", workspaceId: "ws-recon-e" } },
    });
    assert.ok(postMembership, "workspace E must still have a membership row");
    assert.notEqual(
      postMembership.removedAt,
      null,
      "removed membership must remain removed after #16 reconciliation (not reactivated)",
    );
    assert.equal(
      postMembership.authority,
      "Owner",
      "removed membership authority must be unchanged",
    );

    // No NEW membership should be created for ws-recon-e.
    const all = await prisma.workspaceMembership.findMany({
      where: { workspaceId: "ws-recon-e" },
    });
    assert.equal(
      all.length,
      1,
      "no new membership must be created for a workspace with a removed membership",
    );
  });

  test("reconciliation is idempotent: running twice produces identical state (retry/recovery)", async () => {
    await setupMigrationsUpTo15();

    // First reconciliation pass.
    await applyMigrationSql(
      loadMigrationSql(
        "./migrations/20260819000000_m2_workspace_owner_reconciliation/migration.sql",
      ),
    );

    // Capture state after first pass.
    const firstPassMemberships = await prisma.workspaceMembership.findMany({
      where: {
        workspaceId: { in: ["ws-recon-a", "ws-recon-b", "ws-recon-c"] },
      },
      orderBy: { workspaceId: "asc" },
    });
    const firstPassIds = firstPassMemberships.map((m) => m.id).sort();

    // Second reconciliation pass (retry/recovery simulation).
    await applyMigrationSql(
      loadMigrationSql(
        "./migrations/20260819000000_m2_workspace_owner_reconciliation/migration.sql",
      ),
    );

    // State must be identical after second pass (idempotent).
    const secondPassMemberships = await prisma.workspaceMembership.findMany({
      where: {
        workspaceId: { in: ["ws-recon-a", "ws-recon-b", "ws-recon-c"] },
      },
      orderBy: { workspaceId: "asc" },
    });
    const secondPassIds = secondPassMemberships.map((m) => m.id).sort();

    assert.deepEqual(
      secondPassIds,
      firstPassIds,
      "second reconciliation pass must not change membership IDs (idempotent)",
    );
    for (const m of firstPassMemberships) {
      const again = secondPassMemberships.find((x) => x.id === m.id);
      assert.ok(again, `membership ${m.id} must persist after second pass`);
      assert.equal(
        again?.authority,
        m.authority,
        `membership ${m.id} authority must be unchanged after second pass`,
      );
      assert.equal(
        again?.role,
        m.role,
        `membership ${m.id} role must be unchanged after second pass`,
      );
    }

    // No extra memberships were created by the retry.
    const countAfter = await prisma.workspaceMembership.count({
      where: { workspaceId: { in: ["ws-recon-a", "ws-recon-b", "ws-recon-c"] } },
    });
    assert.equal(
      countAfter,
      firstPassMemberships.length,
      "retry must not create duplicate memberships",
    );
  });

  test("the #15 guarantees (published revisions, stable IDs, anonymous search) remain green after #16 reconciliation", async () => {
    // The offering for sp-recon-a (of-recon-a) is created BEFORE #15 runs
    // by loadReconciliationFixtures, so #15's backfill creates the revision.
    await setupMigrationsUpTo15();
    await applyMigrationSql(
      loadMigrationSql(
        "./migrations/20260819000000_m2_workspace_owner_reconciliation/migration.sql",
      ),
    );

    // #15 guarantee 1: every canonical SellerProfile has one initial published revision.
    const profileRevision = await prisma.sellerProfileRevision.findUnique({
      where: { id: "rev-sp-recon-a-1" },
    });
    assert.ok(
      profileRevision,
      "SellerProfileRevision must exist after #16 reconciliation (#15 guarantee preserved)",
    );
    assert.equal(profileRevision.kind, "Published");
    assert.equal(profileRevision.revisionNumber, 1);
    assert.ok(profileRevision.publishedAt !== null);

    // #15 guarantee 2: every canonical ServiceOffering has one initial published revision.
    const offeringRevision = await prisma.serviceOfferingRevision.findUnique({
      where: { id: "rev-of-recon-a-1" },
    });
    assert.ok(
      offeringRevision,
      "ServiceOfferingRevision must exist after #16 reconciliation (#15 guarantee preserved)",
    );
    assert.equal(offeringRevision.kind, "Published");
    assert.equal(offeringRevision.revisionNumber, 1);

    // #15 guarantee 3: M1.1 anonymous search path still returns eligible sellers.
    // The seller sp-recon-a is Published, its workspace ws-recon-a is Active with
    // Seller capability, and its offering of-recon-a is Active — so it must appear.
    const eligible = await prisma.sellerProfile.findMany({
      where: {
        status: "Published",
        workspace: {
          is: {
            status: "Active",
            capabilities: { some: { capability: "Seller" } },
          },
        },
      },
      include: {
        offerings: { where: { status: "Active" } },
        workspace: true,
      },
    });
    const reconA = eligible.find((s) => s.id === "sp-recon-a");
    assert.ok(
      reconA,
      "sp-recon-a must appear in M1.1 anonymous search eligibility after #16",
    );
    assert.ok(
      reconA.offerings.some((o) => o.id === "of-recon-a"),
      "sp-recon-a must have an Active offering in the search result",
    );
  });

  test("the reconciliation migration is not applied by #15 alone (boundary check)", async () => {
    // Prove that the #16 migration is NOT included in the #15 migration.
    // After applying only #15, the reconciliation must NOT have happened.
    await setupMigrationsUpTo15();

    // After #15 only, Case A (orphaned ownerUserId) must NOT have a membership yet.
    const post15MembershipA = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-a", workspaceId: "ws-recon-a" } },
    });
    assert.equal(
      post15MembershipA,
      null,
      "#15 alone must not reconcile orphaned ownerUserId (Case A has no membership yet)",
    );

    // Case B (non-Owner membership) must be Editor after #15 only.
    // #15 backfilled authority=Editor from role=Admin.
    const post15MembershipB = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-b", workspaceId: "ws-recon-b" } },
    });
    assert.ok(post15MembershipB, "Case B must have membership after #15");
    assert.equal(
      post15MembershipB.authority,
      "Editor",
      "#15 alone must not reconcile Case B to Owner authority",
    );

    // Apply the #16 reconciliation and verify it now happens.
    await applyMigrationSql(
      loadMigrationSql(
        "./migrations/20260819000000_m2_workspace_owner_reconciliation/migration.sql",
      ),
    );

    const post16MembershipA = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-a", workspaceId: "ws-recon-a" } },
    });
    assert.ok(
      post16MembershipA,
      "Case A must gain a membership after #16 is applied",
    );
    assert.equal(post16MembershipA.authority, "Owner");

    const post16MembershipB = await prisma.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: "user-recon-b", workspaceId: "ws-recon-b" } },
    });
    assert.equal(
      post16MembershipB?.authority,
      "Owner",
      "Case B must be reconciled to Owner authority after #16",
    );
  });
});
