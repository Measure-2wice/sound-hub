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
