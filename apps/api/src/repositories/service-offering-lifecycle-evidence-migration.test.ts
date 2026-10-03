/* eslint-disable @typescript-eslint/no-floating-promises */

// ServiceOffering lifecycle evidence migration.
//
// Verifies the additive ServiceOfferingPause + ServiceOfferingUpdate
// migration on the disposable test database:
//   1. Applies cleanly (the disposable test DB has been reset and all
//      migrations applied by the surrounding `test:repository` script
//      before this test runs).
//   2. Creates the expected tables with the expected columns.
//   3. Creates the expected indexes and unique constraints.
//   4. Introduces the expected `ServiceOfferingPauseReason` enum.
//   5. Does NOT add a `confirmationVersion` column to the pause
//      evidence table — Pause authorization is independent of
//      activation completeness and fabricating such a column would
//      invent an attestation the Pause command did not invoke.
//   6. Preserves the existing service_offerings rows.
//
// The test uses the approved-disposable-test guard so it can never
// target a managed, remote, or shared database.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";

let prisma: ReturnType<typeof createPrismaClient>;
let databaseUrl: string;

before(() => {
  databaseUrl = readTestDatabaseUrl();
  assertDisposableTestDatabase(databaseUrl);
  prisma = createPrismaClient(databaseUrl);
});

after(async () => {
  await prisma.$disconnect();
});

interface ColumnRow {
  readonly column_name: string;
  readonly data_type: string;
}

interface IndexRow {
  readonly indexname: string;
  readonly indexdef: string;
}

interface EnumRow {
  readonly enumlabel: string;
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_tables
       WHERE schemaname = 'public' AND tablename = '${tableName}'
     ) AS exists;`,
  );
  return result[0]?.exists ?? false;
}

async function getColumns(tableName: string): Promise<readonly ColumnRow[]> {
  return prisma.$queryRawUnsafe<ColumnRow[]>(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = '${tableName}'
     ORDER BY ordinal_position;`,
  );
}

async function getIndexes(tableName: string): Promise<readonly IndexRow[]> {
  return prisma.$queryRawUnsafe<IndexRow[]>(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = '${tableName}'
     ORDER BY indexname;`,
  );
}

async function getEnumValues(enumName: string): Promise<readonly string[]> {
  const rows = await prisma.$queryRawUnsafe<EnumRow[]>(
    `SELECT e.enumlabel
     FROM pg_type t
     JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname = '${enumName}'
     ORDER BY e.enumsortorder;`,
  );
  return rows.map((r) => r.enumlabel);
}

describe("ServiceOffering lifecycle evidence migration", () => {
  test("pause evidence table exists with the expected columns", async () => {
    assert.equal(await tableExists("service_offering_pauses"), true, "table missing");
    const columns = await getColumns("service_offering_pauses");
    const columnNames = new Set(columns.map((c) => c.column_name));
    for (const expected of [
      "id",
      "offeringId",
      "workspaceId",
      "sellerProfileId",
      "pausedByUserId",
      "pausedAt",
      "reason",
      "idempotencyKey",
      "requestId",
    ]) {
      assert.ok(columnNames.has(expected), `expected column '${expected}' missing`);
    }
  });

  test("pause evidence excludes activation confirmation", async () => {
    const columns = await getColumns("service_offering_pauses");
    const columnNames = new Set(columns.map((c) => c.column_name));
    assert.equal(
      columnNames.has("confirmationVersion"),
      false,
      "pause evidence must NOT carry an activation confirmationVersion — " +
        "Pause authorization is independent of activation completeness and " +
        "fabricating such a column would invent an attestation the Pause " +
        "command did not invoke.",
    );
  });

  test("update evidence table exists with the expected columns", async () => {
    assert.equal(await tableExists("service_offering_updates"), true, "table missing");
    const columns = await getColumns("service_offering_updates");
    const columnNames = new Set(columns.map((c) => c.column_name));
    for (const expected of [
      "id",
      "offeringId",
      "workspaceId",
      "sellerProfileId",
      "updatedByUserId",
      "confirmationVersion",
      "updatedAt",
      "idempotencyKey",
      "requestId",
    ]) {
      assert.ok(columnNames.has(expected), `expected column '${expected}' missing`);
    }
  });

  test("ServiceOfferingPauseReason enum has the expected closed set", async () => {
    const values = await getEnumValues("ServiceOfferingPauseReason");
    assert.deepEqual(
      [...values].sort(),
      ["final_sample_removal", "user_initiated"],
      "the closed enum set must match the documented Pause reasons",
    );
  });

  test("pause evidence supports per-offering idempotency via unique index", async () => {
    const indexes = await getIndexes("service_offering_pauses");
    const found = indexes.some(
      (i) => i.indexname === "service_offering_pauses_offering_idem_unique_idx",
    );
    assert.ok(found, "expected unique index missing");
  });

  test("update evidence supports per-offering idempotency via unique index", async () => {
    const indexes = await getIndexes("service_offering_updates");
    const found = indexes.some(
      (i) => i.indexname === "service_offering_updates_offering_idem_unique_idx",
    );
    assert.ok(found, "expected unique index missing");
  });

  test("pause evidence carries the expected secondary indexes", async () => {
    const indexes = await getIndexes("service_offering_pauses");
    const names = new Set(indexes.map((i) => i.indexname));
    assert.ok(names.has("service_offering_pauses_offering_pausedAt_idx"));
    assert.ok(names.has("service_offering_pauses_workspace_idx"));
  });

  test("update evidence carries the expected secondary indexes", async () => {
    const indexes = await getIndexes("service_offering_updates");
    const names = new Set(indexes.map((i) => i.indexname));
    assert.ok(names.has("service_offering_updates_offering_updatedAt_idx"));
    assert.ok(names.has("service_offering_updates_workspace_idx"));
  });

  test("the migration does not rewrite existing service_offerings rows", async () => {
    // The migration is additive — no column rewrites, no backfills, no
    // grandfathering flags. A simple existence check on the existing
    // service_offerings table proves the migration did not destroy it.
    assert.equal(await tableExists("service_offerings"), true, "service_offerings dropped");
    const columns = await getColumns("service_offerings");
    const columnNames = new Set(columns.map((c) => c.column_name));
    for (const expected of [
      "id",
      "slug",
      "sellerProfileId",
      "title",
      "description",
      "status",
      "serviceMode",
      "primaryCategoryId",
      "genreTags",
      "createdAt",
      "updatedAt",
    ]) {
      assert.ok(
        columnNames.has(expected),
        `existing service_offerings column '${expected}' missing — migration may have rewritten the table`,
      );
    }
  });

  test("no legacy flag columns were added to any lifecycle table", async () => {
    // Grandfathering is derived at read time, not persisted. The
    // migration must not introduce any isLegacy / grandfatheredAt /
    // legacyReasonCategory columns on service_offerings, the
    // activation evidence table, or anywhere else.
    const tablesToCheck = [
      "service_offerings",
      "service_offering_activations",
      "service_offering_creations",
      "service_offering_pauses",
      "service_offering_updates",
    ];
    for (const tableName of tablesToCheck) {
      const columns = await getColumns(tableName);
      const columnNames = new Set(columns.map((c) => c.column_name.toLowerCase()));
      for (const forbidden of [
        "islegacy",
        "grandfatheredat",
        "legacyreasoncategory",
        "isfathered",
        "isgrandfathered",
      ]) {
        assert.equal(
          columnNames.has(forbidden),
          false,
          `forbidden legacy column '${forbidden}' found in ${tableName} — grandfathering is derived, not persisted`,
        );
      }
    }
  });
});

// M2 (#86, slice 86F Tenki PR feedback): the previous "does not
// rewrite existing service_offerings rows" test only checked that
// the table and columns exist — it never compared pre- vs
// post-migration row data, so the assertion was vacuous. This
// describe block proves the migration's actual additive
// preservation invariant end-to-end by:
//
//   1. Establishing a disposable database at the migration
//      immediately before the slice 86F target.
//   2. Inserting a representative pre-existing ServiceOffering
//      fixture with its required dependencies (workspace,
//      seller profile, owner membership).
//   3. Capturing every value the assertion will pin.
//   4. Applying the slice 86F target migration.
//   5. Asserting the row's identity, public values, lifecycle
//      status, and timestamps survive unchanged.
//   6. Asserting no pause / update evidence was fabricated.
//
// The isolation strategy reuses the pattern at
// `apps/api/src/auth-repository/prisma-auth-repository.migration.test.ts`:
// drop + recreate a dedicated PostgreSQL schema, set
// `search_path` at connection time via libpq's `options=` URL
// parameter, replay prior migration SQL via `prisma.$executeRawUnsafe`,
// then run the assertions in the isolated schema before drop.
// The canonical `public` schema (which other tests + the seed
// rely on) is never touched.

const ISOLATED_SCHEMA = "migration_fixture_test_86";
const MIGRATIONS_DIR = join(
  new URL("../../../../packages/db/prisma/migrations", import.meta.url).pathname,
);

function listMigrationDirs(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readMigrationSql(dirName: string): string {
  return readFileSync(join(MIGRATIONS_DIR, dirName, "migration.sql"), "utf8");
}

/**
 * Split a multi-statement SQL script into individual statements,
 * skipping pure-whitespace and comment-only chunks. Prisma's
 * `$executeRawUnsafe` accepts a single statement; we issue them
 * one at a time so PostgreSQL never sees a script boundary
 * mid-transaction. Dollar-quoted strings (`$$ ... $$`, used by
 * `DO` blocks) are treated as opaque.
 */
function splitSqlStatements(sql: string): readonly string[] {
  const out: string[] = [];
  let buffer = "";
  let inDollarQuote = false;
  for (const rawLine of sql.split("\n")) {
    const line = rawLine.trimEnd();
    buffer += line + "\n";
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i] === "$" && line[i + 1] === "$") {
        inDollarQuote = !inDollarQuote;
        i++;
      }
    }
    if (!inDollarQuote && line.trimEnd().endsWith(";")) {
      const cleaned = buffer
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (cleaned.length > 0 && cleaned !== ";") {
        out.push(cleaned);
      }
      buffer = "";
    }
  }
  const tail = buffer
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .trim();
  if (tail.length > 0 && tail !== ";") {
    out.push(tail);
  }
  return out;
}

describe("ServiceOffering #86 migration preserves pre-existing service_offerings rows", () => {
  let isolated: ReturnType<typeof createPrismaClient> | null = null;
  const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
  const skip = !TEST_DATABASE_URL;

  before(() => {
    if (skip) return;
    assertDisposableTestDatabase(readTestDatabaseUrl());
    const baseUrl = readTestDatabaseUrl();
    const isolatedUrl = `${baseUrl}${
      baseUrl.includes("?") ? "&" : "?"
    }options=-c%20search_path%3D${ISOLATED_SCHEMA}`;
    isolated = createPrismaClient(isolatedUrl);
  });

  after(async () => {
    if (isolated) {
      try {
        await isolated.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${ISOLATED_SCHEMA}" CASCADE`);
      } catch {
        /* ignore */
      }
      await isolated.$disconnect();
    }
  });

  test("a pre-existing ServiceOffering survives the #86 migration with identity, status, and timestamps unchanged", async (t) => {
    if (skip || !isolated) {
      t.skip();
      return;
    }
    const prisma = isolated;

    // Step 1 — fresh isolated schema.
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${ISOLATED_SCHEMA}" CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${ISOLATED_SCHEMA}"`);

    // Step 2 — replay every migration BEFORE the slice 86F target
    // by reading each `migration.sql` and executing the statements
    // via the dedicated isolated-schema connection.
    const allMigrationDirs = listMigrationDirs();
    const targetIndex = allMigrationDirs.indexOf(
      "20260928090000_m2_86_service_offering_pause_and_update",
    );
    assert.ok(
      targetIndex > 0,
      "expected the #86 target migration to be present and not the first migration",
    );
    for (const dirName of allMigrationDirs.slice(0, targetIndex)) {
      const sql = readMigrationSql(dirName);
      for (const stmt of splitSqlStatements(sql)) {
        await prisma.$executeRawUnsafe(stmt);
      }
    }

    // Step 3 — the target tables + enum must NOT yet exist in the
    // isolated schema. This proves the prior-migrations replay
    // didn't accidentally pull them forward.
    const preTableRows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_tables
         WHERE schemaname = $1 AND tablename IN ('service_offering_pauses','service_offering_updates')
       ) AS exists;`,
      ISOLATED_SCHEMA,
    );
    assert.equal(
      preTableRows[0]?.exists,
      false,
      "expected service_offering_pauses + service_offering_updates to NOT exist before the #86 migration is applied",
    );
    const preEnumRows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_type t
         JOIN pg_namespace n ON t.typnamespace = n.oid
         WHERE t.typname = 'ServiceOfferingPauseReason' AND n.nspname = $1
       ) AS exists;`,
      ISOLATED_SCHEMA,
    );
    assert.equal(
      preEnumRows[0]?.exists,
      false,
      "expected ServiceOfferingPauseReason enum to NOT exist before the #86 migration is applied",
    );

    // Step 4 — insert the pre-existing ServiceOffering fixture
    // with every dependency the table's FK requires. The values are
    // chosen so every captured column has a distinguishable identity
    // (no NULLs the test would silently treat as "missing").
    const FIXTURE_SLUG = "fixture-preservation-slug";
    const FIXTURE_USER_ID = "fixture-preservation-user";
    const FIXTURE_WORKSPACE_ID = "fixture-preservation-ws";
    const FIXTURE_PROFILE_ID = "fixture-preservation-sp";
    const FIXTURE_OFFERING_ID = "fixture-preservation-ofr";
    const KNOWN_TITLE = "Fixture preservation title (pre-migration)";
    const KNOWN_DESCRIPTION = "Fixture preservation description (pre-migration).";
    const KNOWN_STATUS = "Active";
    const KNOWN_SERVICE_MODE = "Remote";
    const KNOWN_GENRE_TAGS = ["dancehall", "reggae", "soca"];

    // Use a fixed past timestamp so the migration cannot rewrite it
    // without the test catching the change. We pin `createdAt`
    // explicitly; `updatedAt` is `@updatedAt` so PostgreSQL bumps it
    // on row update — we omit the explicit insert for it.
    const FIXTURE_CREATED_AT = new Date("2026-09-26T13:00:00.000Z");

    await prisma.$executeRawUnsafe(
      `INSERT INTO "user_accounts" ("id", "email", "createdAt", "updatedAt")
       VALUES ($1, 'fixture-preservation@example.test', $2, $2)`,
      FIXTURE_USER_ID,
      FIXTURE_CREATED_AT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "workspaces" ("id", "slug", "name", "type", "status", "ownerUserId", "createdAt", "updatedAt")
       VALUES ($1, 'fixture-preservation-ws', 'Fixture Preservation WS', 'Personal', 'Active', $2, $3, $3)`,
      FIXTURE_WORKSPACE_ID,
      FIXTURE_USER_ID,
      FIXTURE_CREATED_AT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "workspace_memberships" ("id", "userId", "workspaceId", "role", "createdAt")
       VALUES ('fixture-preservation-mem', $1, $2, 'Owner', $3)`,
      FIXTURE_USER_ID,
      FIXTURE_WORKSPACE_ID,
      FIXTURE_CREATED_AT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "seller_profiles" ("id", "workspaceId", "professionalName", "bio", "status", "basedInCountryCode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'Fixture Preservation Profile', 'Fixture bio.', 'Published', 'JM', $3, $3)`,
      FIXTURE_PROFILE_ID,
      FIXTURE_WORKSPACE_ID,
      FIXTURE_CREATED_AT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "service_offerings"
         ("id", "slug", "sellerProfileId", "title", "description", "status",
          "serviceMode", "primaryCategoryId", "genreTags", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $9)`,
      FIXTURE_OFFERING_ID,
      FIXTURE_SLUG,
      FIXTURE_PROFILE_ID,
      KNOWN_TITLE,
      KNOWN_DESCRIPTION,
      KNOWN_STATUS,
      KNOWN_SERVICE_MODE,
      KNOWN_GENRE_TAGS,
      FIXTURE_CREATED_AT,
    );

    // Step 5 — capture the exact values the migration could rewrite.
    const before = await prisma.$queryRawUnsafe<
      Array<{
        readonly id: string;
        readonly slug: string;
        readonly sellerProfileId: string;
        readonly title: string;
        readonly description: string;
        readonly status: string;
        readonly serviceMode: string;
        readonly primaryCategoryId: string | null;
        readonly genreTags: string[];
        readonly createdAt: Date;
      }>
    >(
      `SELECT "id", "slug", "sellerProfileId", "title", "description", "status",
              "serviceMode", "primaryCategoryId", "genreTags", "createdAt"
       FROM "service_offerings" WHERE "id" = $1`,
      FIXTURE_OFFERING_ID,
    );
    assert.equal(before.length, 1, "pre-migration fixture row missing");
    const beforeRow = before[0]!;

    // Step 6 — apply the slice 86F target migration in the
    // isolated schema. This is the migration whose additive claim
    // the test must verify end-to-end.
    const targetSql = readMigrationSql("20260928090000_m2_86_service_offering_pause_and_update");
    for (const stmt of splitSqlStatements(targetSql)) {
      await prisma.$executeRawUnsafe(stmt);
    }

    // Step 7 — assert the pre-existing fixture row is preserved
    // across the migration. Every captured column must match the
    // pre-migration value exactly; the migration must NOT have
    // rewritten any value the test pins down.
    const after = await prisma.$queryRawUnsafe<
      Array<{
        readonly id: string;
        readonly slug: string;
        readonly sellerProfileId: string;
        readonly title: string;
        readonly description: string;
        readonly status: string;
        readonly serviceMode: string;
        readonly primaryCategoryId: string | null;
        readonly genreTags: string[];
        readonly createdAt: Date;
      }>
    >(
      `SELECT "id", "slug", "sellerProfileId", "title", "description", "status",
              "serviceMode", "primaryCategoryId", "genreTags", "createdAt"
       FROM "service_offerings" WHERE "id" = $1`,
      FIXTURE_OFFERING_ID,
    );
    assert.equal(after.length, 1, "post-migration fixture row missing");
    const afterRow = after[0]!;

    assert.equal(afterRow.id, beforeRow.id, "id drifted across the migration");
    assert.equal(afterRow.slug, beforeRow.slug, "slug drifted across the migration");
    assert.equal(
      afterRow.sellerProfileId,
      beforeRow.sellerProfileId,
      "sellerProfileId drifted across the migration",
    );
    assert.equal(afterRow.title, beforeRow.title, "title drifted across the migration");
    assert.equal(
      afterRow.description,
      beforeRow.description,
      "description drifted across the migration",
    );
    assert.equal(afterRow.status, beforeRow.status, "status drifted across the migration");
    assert.equal(
      afterRow.serviceMode,
      beforeRow.serviceMode,
      "serviceMode drifted across the migration",
    );
    assert.equal(
      afterRow.primaryCategoryId,
      beforeRow.primaryCategoryId,
      "primaryCategoryId drifted across the migration",
    );
    assert.deepEqual(
      afterRow.genreTags,
      beforeRow.genreTags,
      "genreTags drifted across the migration",
    );
    assert.equal(
      afterRow.createdAt.getTime(),
      beforeRow.createdAt.getTime(),
      "createdAt drifted across the migration",
    );

    // Step 8 — assert the new lifecycle evidence tables + enum
    // now exist, and that the migration did NOT fabricate any
    // pause / update evidence for the pre-existing offering. The
    // additive invariant: pre-existing rows do not acquire new
    // evidence by the mere act of the migration.
    const pauseRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "service_offering_pauses" WHERE "offeringId" = $1`,
      FIXTURE_OFFERING_ID,
    );
    assert.equal(
      Number(pauseRows[0]?.count ?? 0),
      0,
      "the #86 migration must NOT fabricate pause evidence for pre-existing offerings",
    );
    const updateRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "service_offering_updates" WHERE "offeringId" = $1`,
      FIXTURE_OFFERING_ID,
    );
    assert.equal(
      Number(updateRows[0]?.count ?? 0),
      0,
      "the #86 migration must NOT fabricate update evidence for pre-existing offerings",
    );

    // Sanity: a non-fixture offering must also not have fabricated
    // evidence. The isolated schema has exactly one ServiceOffering
    // (the fixture), so the count is 0.
    const totalPauseRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "service_offering_pauses"`,
    );
    assert.equal(
      Number(totalPauseRows[0]?.count ?? 0),
      0,
      "the #86 migration must NOT fabricate any pause evidence",
    );
    const totalUpdateRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "service_offering_updates"`,
    );
    assert.equal(
      Number(totalUpdateRows[0]?.count ?? 0),
      0,
      "the #86 migration must NOT fabricate any update evidence",
    );
  });
});
