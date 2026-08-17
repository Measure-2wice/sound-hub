/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

// M2.0A / Gate 0 M1.1 -> M2 transition coverage.
//
// The transition test proves the M2 expand migration by
// independently constructing the M1.1 baseline (schema and
// representative pre-expand data) from the APPROVED M1.1 migration
// history on disk, applying the reviewed M2 migration SQL, and
// observing the backfill. The other tests in m2-foundation.test.ts
// inspect the post-migration state; this file proves the migration
// itself is the path that produces the post-migration state.
//
// The test runs against the disposable test database
// (TEST_DATABASE_URL, soundhub_m1_test@localhost:5433). The M1.1
// baseline is established by reading the approved
// 20260808114423_m1_foundation and 20260808120000_drop_seed_markers
// migration SQL files from disk and applying them directly — not by
// reconstructing an approximate baseline with hand-written drops. The
// reviewed M2 migration SQL is then applied and its backfill observed.
//
// The negative case proves the suite fails when the M2 migration SQL
// is intentionally broken: it removes the Admin/Member -> Editor
// backfill UPDATE, applies the remainder, and asserts that the
// canonical assertion detects the missing Editor mapping.

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
  // Restore the database to a clean post-migration state so the
  // subsequent m2-foundation.test.ts suite sees the canonical
  // fixture set. The transition test inserts M1.1-only fixtures
  // and then runs the M2 migration; the canonical seed would
  // otherwise create conflicting category / offering ids. The
  // restoration drops the public schema, re-applies all
  // migrations, and re-runs the seed so the next test suite
  // starts from the canonical post-migration state.
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS "public" CASCADE; CREATE SCHEMA "public";');
  await prisma.$disconnect();
  // Use the test:db:scaffold binary to apply migrations + seed.
  // This is a child-process step so the running Prisma client is
  // disconnected and a fresh migration apply can succeed.
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          TEST_DATABASE_URL: databaseUrl,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited with code ${code}`));
    });
  });
  // Re-instantiate the Prisma client against the re-applied
  // schema and run the seed.
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
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TEST_DATABASE_URL: databaseUrl,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed exited with code ${code}`));
    });
  });
}

// loadMigrationSql: read the M2 expand migration.sql from disk. The
// transition suite applies the SQL directly so a regression in the
// migration file is observable as a test failure.
function loadMigrationSql(): string {
  return readFileSync(
    new URL("./migrations/20260816013319_m2_foundation_expand/migration.sql", import.meta.url)
      .pathname,
    "utf8",
  );
}

// loadM11MigrationSqls: read the approved M1.1 migration SQL files
// in the order they must be applied. The transition suite applies the
// M1.1 history directly from disk so the baseline cannot drift from
// the approved source.
function loadM11MigrationSqls(): string[] {
  return [
    readFileSync(
      new URL("./migrations/20260808114423_m1_foundation/migration.sql", import.meta.url).pathname,
      "utf8",
    ),
    readFileSync(
      new URL("./migrations/20260808120000_drop_seed_markers/migration.sql", import.meta.url)
        .pathname,
      "utf8",
    ),
  ];
}

// resetToM11Baseline: snap the database to a fresh M1.1 baseline by
// dropping the public schema and applying the approved M1.1 migration
// history in order. This is the authoritative source of the M1.1
// schema; the test never reconstructs it from hand-written drops.
async function resetToM11Baseline(): Promise<void> {
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS "public" CASCADE; CREATE SCHEMA "public";');
  for (const sql of loadM11MigrationSqls()) {
    await prisma.$executeRawUnsafe(sql);
  }
}

// applyMigrationSql: execute the M2 migration SQL. The dominant
// outcome is the add-DDL + backfill + trigger DDL. Existing-M2
// "already exists" errors do not arise because resetToM11Baseline
// drops the schema first.
async function applyMigrationSql(sql: string): Promise<void> {
  await prisma.$executeRawUnsafe(sql);
}

// loadM11Fixtures: insert a representative M1.1 baseline using raw
// SQL. The fixtures cover every M1.1 surface used by the
// migration's backfill statements (Admin and Member roles, bundled
// IncludedService rows) so the backfill can be observed end to
// end. Raw SQL is used because the test runs AFTER resetToM11Baseline
// has reset the schema to M1.1 only; the Prisma client expects the
// post-migration schema, so .create() would fail with
// column-not-found.
async function loadM11Fixtures(): Promise<{
  workspaceAId: string;
  workspaceBId: string;
  workspaceCId: string;
  profileAId: string;
  offeringAId: string;
  offeringBId: string;
  categoryId: string;
}> {
  // Two controlled categories.
  const categoryARow = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO service_categories (id, key, name, description, "bundleOnly", "createdAt")
    VALUES (gen_random_uuid()::text, 'music-production', 'Music Production', 'Transition test', false, NOW())
    RETURNING id
  `;
  const categoryAId = categoryARow[0]?.id ?? "";
  const categoryBRow = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO service_categories (id, key, name, description, "bundleOnly", "createdAt")
    VALUES (gen_random_uuid()::text, 'songwriting', 'Songwriting', 'Bundle-only', false, NOW())
    RETURNING id
  `;
  const categoryBId = categoryBRow[0]?.id ?? "";
  const specialtyRow = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO specialties (id, key, name)
    VALUES (gen_random_uuid()::text, 'Producer', 'Producer')
    RETURNING id
  `;
  const specialtyId = specialtyRow[0]?.id ?? "";

  // Three users.
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_accounts (id, email, "createdAt", "updatedAt") VALUES ('user-m2-transition-a', 'owner.a@m2-transition.test', NOW(), NOW());`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_accounts (id, email, "createdAt", "updatedAt") VALUES ('user-m2-transition-b', 'admin.b@m2-transition.test', NOW(), NOW());`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO user_accounts (id, email, "createdAt", "updatedAt") VALUES ('user-m2-transition-c', 'member.c@m2-transition.test', NOW(), NOW());`,
  );

  // Three workspaces.
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspaces (id, slug, name, type, status, "ownerUserId", "createdAt", "updatedAt") VALUES ('ws-m2-transition-a', 'm2-transition-a', 'M2 Transition A', 'Personal', 'Active', 'user-m2-transition-a', NOW(), NOW());`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspaces (id, slug, name, type, status, "ownerUserId", "createdAt", "updatedAt") VALUES ('ws-m2-transition-b', 'm2-transition-b', 'M2 Transition B', 'Personal', 'Active', 'user-m2-transition-a', NOW(), NOW());`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspaces (id, slug, name, type, status, "ownerUserId", "createdAt", "updatedAt") VALUES ('ws-m2-transition-c', 'm2-transition-c', 'M2 Transition C', 'Personal', 'Active', 'user-m2-transition-a', NOW(), NOW());`,
  );
  for (const wsId of ["ws-m2-transition-a", "ws-m2-transition-b", "ws-m2-transition-c"]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO workspace_capabilities (id, "workspaceId", capability) VALUES ('cap-${wsId}', '${wsId}', 'Seller');`,
    );
  }

  // Memberships: one Owner, one Admin, one Member.
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspace_memberships (id, "userId", "workspaceId", role, "createdAt") VALUES ('mem-m2-transition-a', 'user-m2-transition-a', 'ws-m2-transition-a', 'Owner', NOW());`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspace_memberships (id, "userId", "workspaceId", role, "createdAt") VALUES ('mem-m2-transition-b', 'user-m2-transition-b', 'ws-m2-transition-b', 'Admin', NOW());`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO workspace_memberships (id, "userId", "workspaceId", role, "createdAt") VALUES ('mem-m2-transition-c', 'user-m2-transition-c', 'ws-m2-transition-c', 'Member', NOW());`,
  );

  // A canonical seller profile with specialties and Caribbean
  // affiliations.
  await prisma.$executeRawUnsafe(
    `INSERT INTO seller_profiles (id, "workspaceId", "professionalName", bio, status, "basedInCity", "basedInRegion", "basedInCountryCode", "avatarUrl", "createdAt", "updatedAt") VALUES ('sp-m2-transition-a', 'ws-m2-transition-a', 'Transition Test Seller', 'Bio', 'Published', 'Brooklyn', 'NY', 'US', NULL, NOW(), NOW());`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO seller_profile_specialties ("sellerProfileId", "specialtyId") VALUES ('sp-m2-transition-a', '${specialtyId}');`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO caribbean_affiliations (id, "sellerProfileId", "countryCode") VALUES ('ca-m2-transition-a', 'sp-m2-transition-a', 'HT');`,
  );

  // Two offerings: one with no bundled IncludedService, one with
  // a bundled IncludedService.
  await prisma.$executeRawUnsafe(
    `INSERT INTO service_offerings (id, slug, "sellerProfileId", title, description, status, "serviceMode", "primaryCategoryId", "genreTags", "createdAt", "updatedAt") VALUES ('of-m2-transition-a', 'm2-transition-a', 'sp-m2-transition-a', 'M2 transition offering A', 'A canonical offering for the M2 transition test.', 'Active', 'Remote', '${categoryAId}', ARRAY['Dancehall']::text[], NOW(), NOW());`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO service_offerings (id, slug, "sellerProfileId", title, description, status, "serviceMode", "primaryCategoryId", "genreTags", "createdAt", "updatedAt") VALUES ('of-m2-transition-b', 'm2-transition-b', 'sp-m2-transition-a', 'M2 transition offering B (bundled)', 'A bundled offering for the M2 transition test.', 'Active', 'Remote', '${categoryAId}', ARRAY['Soca']::text[], NOW(), NOW());`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO offering_pricing (id, "offeringId", kind, "amountMinor", currency, "unitId") VALUES ('op-m2-transition-a', 'of-m2-transition-a', 'StartingAt', 50000, 'USD', NULL);`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO offering_service_areas (id, "offeringId", city, region, "countryCode") VALUES ('osa-m2-transition-a', 'of-m2-transition-a', NULL, NULL, 'US');`,
  );
  // The bundled IncludedService row. The migration's
  // service_offering_revision_included_services backfill must
  // copy this row into the offering revision's bundle children.
  await prisma.$executeRawUnsafe(
    `INSERT INTO included_services (id, "offeringId", "categoryId", "purchaseMode") VALUES ('is-m2-transition-b', 'of-m2-transition-b', '${categoryBId}', 'BundleOnly');`,
  );

  return {
    workspaceAId: "ws-m2-transition-a",
    workspaceBId: "ws-m2-transition-b",
    workspaceCId: "ws-m2-transition-c",
    profileAId: "sp-m2-transition-a",
    offeringAId: "of-m2-transition-a",
    offeringBId: "of-m2-transition-b",
    categoryId: categoryAId,
  };
}

describe("M2.0A Gate 0 M1.1 -> M2 transition coverage", () => {
  test("the M2 migration creates every M2 table and enum from the M1.1 baseline", async () => {
    // Build the M1.1 baseline from the approved M1.1 migration
    // history. The migration under test must be the path that
    // creates the M2 DDL from that authoritative source.
    await resetToM11Baseline();
    await loadM11Fixtures();

    // Pre-migration: no M2 tables exist.
    const preM2Tables = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'audit_events', 'acceptances', 'document_versions', 'workspace_invitations',
        'service_offering_revisions', 'seller_profile_revisions'
      )
    `;
    assert.equal(
      preM2Tables[0]?.count,
      0,
      "M2 tables must not exist before the migration is applied",
    );

    // Apply the reviewed migration.
    await applyMigrationSql(loadMigrationSql());

    // Post-migration: every M2 table the migration creates must
    // be present.
    const m2Tables = [
      "audit_events",
      "acceptances",
      "document_versions",
      "workspace_invitations",
      "service_offering_revisions",
      "service_offering_revision_included_services",
      "service_offering_revision_service_areas",
      "seller_profile_revisions",
      "seller_profile_revision_specialties",
      "seller_profile_revision_caribbean_affiliations",
      "authentication_identities",
      "magic_link_challenges",
      "user_account_security",
      "sessions",
      "workspace_control_freezes",
      "marketplace_reports",
      "workspace_closures",
      "user_account_closures",
      "idempotency_keys",
    ];
    for (const table of m2Tables) {
      const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ${table}
        ) AS exists
      `;
      assert.ok(rows[0]?.exists, `M2 table ${table} must be created by the migration`);
    }

    // The migrations also create the M2 enum types.
    const m2Enums = [
      "WorkspaceMembershipAuthority",
      "AuthenticationProvider",
      "WorkspaceClosureState",
      "UserAccountClosureState",
      "MarketplaceReportStatus",
      "MarketplaceReportReason",
      "AcceptanceKind",
      "DocumentKind",
      "PolicyUpdateClass",
      "RetentionClass",
      "AuditEventOutcome",
      "WorkspaceControlFreezeState",
      "IdempotencyStatus",
      "SellerProfileRevisionKind",
      "ServiceOfferingRevisionKind",
      "WorkspaceInvitationStatus",
    ];
    for (const enumName of m2Enums) {
      const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = ${enumName} AND n.nspname = 'public'
        ) AS exists
      `;
      assert.ok(rows[0]?.exists, `M2 enum ${enumName} must be created by the migration`);
    }
  });

  test("the M2 migration backfills WorkspaceMembership.authority for Owner, Admin, and Member roles", async () => {
    await resetToM11Baseline();
    await loadM11Fixtures();

    // Pre-migration: the memberships have only `role`; `authority`
    // does not exist yet.
    const membershipAuthority = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'workspace_memberships'
          AND column_name = 'authority'
      ) AS exists
    `;
    assert.equal(
      membershipAuthority[0]?.exists,
      false,
      "authority column must not exist before the migration",
    );

    // Apply the migration. The migration adds the column as
    // NULLABLE, runs the UPDATE OWNER branch, runs the UPDATE
    // ADMIN/MEMBER branch, and finally promotes the column to
    // NOT NULL.
    await applyMigrationSql(loadMigrationSql());

    // Post-migration: every membership has the correct authority.
    const ownerMembership = await prisma.workspaceMembership.findUniqueOrThrow({
      where: { id: "mem-m2-transition-a" },
    });
    assert.equal(
      ownerMembership.authority,
      "Owner",
      "Owner role must be mapped to Owner authority by the migration",
    );
    const adminMembership = await prisma.workspaceMembership.findUniqueOrThrow({
      where: { id: "mem-m2-transition-b" },
    });
    assert.equal(
      adminMembership.authority,
      "Editor",
      "Admin role must be mapped to Editor authority by the migration",
    );
    const memberMembership = await prisma.workspaceMembership.findUniqueOrThrow({
      where: { id: "mem-m2-transition-c" },
    });
    assert.equal(
      memberMembership.authority,
      "Editor",
      "Member role must be mapped to Editor authority by the migration",
    );
  });

  test("the M2 migration backfills canonical SellerProfileRevision and ServiceOfferingRevision records", async () => {
    await resetToM11Baseline();
    const ids = await loadM11Fixtures();

    await applyMigrationSql(loadMigrationSql());

    // SellerProfileRevision: one initial published revision for
    // the canonical seller profile.
    const profileRevision = await prisma.sellerProfileRevision.findUniqueOrThrow({
      where: { id: `rev-${ids.profileAId}-1` },
    });
    assert.equal(profileRevision.revisionNumber, 1);
    assert.equal(profileRevision.kind, "Published");
    assert.equal(profileRevision.professionalName, "Transition Test Seller");
    assert.equal(profileRevision.basedInCountryCode, "US");
    assert.ok(profileRevision.publishedAt, "published revision must have publishedAt");

    // Specialty and CaribbeanAffiliation snapshot children.
    const profileSpecialties = await prisma.sellerProfileRevisionSpecialty.findMany({
      where: { sellerProfileRevisionId: profileRevision.id },
    });
    assert.equal(profileSpecialties.length, 1, "specialty join must be backfilled");
    const profileAffiliations = await prisma.sellerProfileRevisionCaribbeanAffiliation.findMany({
      where: { sellerProfileRevisionId: profileRevision.id },
    });
    assert.equal(profileAffiliations.length, 1, "CaribbeanAffiliation must be backfilled");
    assert.equal(profileAffiliations[0]?.countryCode, "HT");

    // ServiceOfferingRevision: one initial published revision per
    // offering, with denormalized pricing and service areas.
    const offeringARevision = await prisma.serviceOfferingRevision.findUniqueOrThrow({
      where: { id: `rev-${ids.offeringAId}-1` },
    });
    assert.equal(offeringARevision.revisionNumber, 1);
    assert.equal(offeringARevision.kind, "Published");
    assert.equal(offeringARevision.title, "M2 transition offering A");
    assert.equal(offeringARevision.pricingKind, "StartingAt");
    assert.equal(offeringARevision.pricingAmountMinor, 50000);
    assert.equal(offeringARevision.pricingCurrency, "USD");
    const offeringAServiceAreas = await prisma.serviceOfferingRevisionServiceArea.findMany({
      where: { serviceOfferingRevisionId: offeringARevision.id },
    });
    assert.equal(offeringAServiceAreas.length, 1, "service area must be backfilled");

    // The bundled offering's revision must include the
    // bundled IncludedService row (the migration backfills
    // service_offering_revision_included_services from the M1.1
    // included_services table).
    const offeringBRevision = await prisma.serviceOfferingRevision.findUniqueOrThrow({
      where: { id: `rev-${ids.offeringBId}-1` },
    });
    assert.equal(offeringBRevision.kind, "Published");
    const bundledRevisionRows = await prisma.serviceOfferingRevisionIncludedService.findMany({
      where: { serviceOfferingRevisionId: offeringBRevision.id },
    });
    assert.equal(
      bundledRevisionRows.length,
      1,
      "bundled IncludedService row must be backfilled into the revision graph",
    );
    // Verify the bundled category is the songwriting category
    // (which is the bundle-only category in the M1.1 fixtures).
    const bundledCategory = await prisma.serviceCategory.findUniqueOrThrow({
      where: { id: bundledRevisionRows[0]?.categoryId ?? "" },
    });
    assert.equal(bundledCategory.key, "songwriting");
    assert.equal(bundledRevisionRows[0]?.purchaseMode, "BundleOnly");
  });

  test("the M2 migration drops the M1.1 workspaces.ownerUserId foreign key constraint", async () => {
    await resetToM11Baseline();
    await loadM11Fixtures();

    // The M1.1 migration creates the FK constraint. The expanded
    // M2 migration drops it. After the migration is applied, the
    // FK must not exist.
    await applyMigrationSql(loadMigrationSql());

    const fkRows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'workspaces'
          AND c.contype = 'f'
          AND c.conname = 'workspaces_ownerUserId_fkey'
          AND n.nspname = 'public'
      ) AS exists
    `;
    assert.equal(
      fkRows[0]?.exists,
      false,
      "workspaces.ownerUserId FK must be dropped by the M2 migration",
    );
  });

  test("the M2 migration installs append-only triggers on audit_events and the immutability triggers on revisions", async () => {
    await resetToM11Baseline();
    await loadM11Fixtures();
    await applyMigrationSql(loadMigrationSql());

    // Verify the audit_events append-only triggers are installed.
    const auditTriggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid = 'audit_events'::regclass
    `;
    const auditNames = auditTriggers.map((t) => t.tgname);
    assert.ok(auditNames.includes("audit_events_no_update"), "audit_events_no_update must exist");
    assert.ok(auditNames.includes("audit_events_no_delete"), "audit_events_no_delete must exist");

    // Verify the seller profile / service offering revision
    // immutability triggers are installed.
    const profileTriggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid = 'seller_profile_revisions'::regclass
    `;
    assert.ok(
      profileTriggers.some((t) => t.tgname === "seller_profile_revisions_no_update_published"),
      "seller_profile_revisions_no_update_published must exist",
    );
    const offeringTriggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid = 'service_offering_revisions'::regclass
    `;
    assert.ok(
      offeringTriggers.some((t) => t.tgname === "service_offering_revisions_no_update_published"),
      "service_offering_revisions_no_update_published must exist",
    );
  });

  test("the suite fails when the Admin/Member -> Editor backfill UPDATE is intentionally broken", async () => {
    // Reviewer verification: prove the suite catches a broken
    // backfill. The test rebuilds the M1.1 baseline, applies a
    // mutated migration that omits the Admin/Member UPDATE, and
    // asserts that the resulting Admin membership has authority
    // NULL (the migration adds the column NULLABLE then promotes
    // it to NOT NULL only if every row has a value). The test
    // therefore catches the regression by observing the NULL
    // authority on the Admin row.
    await resetToM11Baseline();
    await loadM11Fixtures();

    // Build a broken migration: remove the Admin/Member UPDATE
    // and the NOT NULL promotion so the Admin row ends up with
    // a NULL authority.
    const originalSql = loadMigrationSql();
    const brokenSql = originalSql
      .replace(
        /UPDATE "workspace_memberships"\s*\nSET "authority" = 'Editor'\s*\nWHERE "role" IN \('Admin', 'Member'\);/,
        "",
      )
      .replace(/ALTER TABLE "workspace_memberships" ALTER COLUMN "authority" SET NOT NULL;/, "");

    // Sanity-check: the original SQL must contain the UPDATE; the
    // broken SQL must not. If the regex missed, the test silently
    // passes without exercising the regression.
    assert.ok(
      originalSql.includes("WHERE \"role\" IN ('Admin', 'Member')"),
      "precondition: original migration must contain the Admin/Member UPDATE",
    );
    assert.ok(
      !brokenSql.includes("WHERE \"role\" IN ('Admin', 'Member')"),
      "broken migration must remove the Admin/Member UPDATE so the test exercises the regression",
    );

    // Apply the broken migration. The Admin membership will be
    // left with authority = NULL because the broken UPDATE and
    // the broken NOT NULL promotion are removed.
    await applyMigrationSql(brokenSql);

    // The Admin membership must have NULL authority — the
    // canonical assertion detects the broken backfill.
    const adminMembership = await prisma.$queryRaw<
      Array<{ authority: string | null }>
    >`SELECT authority FROM workspace_memberships WHERE id = 'mem-m2-transition-b'`;
    assert.equal(
      adminMembership[0]?.authority,
      null,
      "broken Admin/Member UPDATE must leave the Admin membership with NULL authority",
    );

    // Restore the canonical migration so the subsequent tests
    // see the post-migration state.
    await applyMigrationSql(
      `UPDATE "workspace_memberships" SET "authority" = 'Editor'::"WorkspaceMembershipAuthority" WHERE "role" IN ('Admin'::"WorkspaceMembershipRole", 'Member'::"WorkspaceMembershipRole");`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "workspace_memberships" ALTER COLUMN "authority" SET NOT NULL;`,
    );
  });
});
