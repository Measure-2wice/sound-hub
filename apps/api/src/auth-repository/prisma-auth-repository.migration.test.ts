// Prisma-backed Personal Workspace migration fixture test (M2 #82).
//
// Background: Codex review (P1-004(a)) flagged that the M2 #82
// migration's backfill semantics were not directly exercised. The
// migration
// `packages/db/prisma/migrations/20260918120000_m2_personal_workspace_convergence/migration.sql`
// adds the `personalWorkspaceId` column to `user_accounts`, backfills
// it from a strict rule (link only when exactly ONE Owner Personal
// membership exists; zero or multiple candidates → leave NULL), and
// installs the unique index + foreign key.
//
// Running assertions against an already-migrated database is
// INSUFFICIENT — the test must prove the migration SQL itself
// backfills correctly. This test:
//
//   1. Opens the disposable `TEST_DATABASE_URL` (fail-closed by the
//      test-database guard).
//   2. Drops the public schema to start from an empty database.
//   3. Applies every migration BEFORE the M2 migration by replaying
//      each `migration.sql` file via `prisma.$executeRawUnsafe` in
//      chronological order. (`prisma migrate deploy` cannot stop
//      mid-sequence without an isolated migration set, so the
//      supported mechanism is to replay prior SQL files directly.)
//   4. Asserts `user_accounts.personalWorkspaceId` does not yet
//      exist (`information_schema.columns`).
//   5. Inserts four fixture UserAccounts in the pre-M2 state:
//        - User A: zero Owner Personal candidates → expect NULL
//          after migration.
//        - User B: one Owner Personal candidate → expect backfill.
//        - User C: two Owner Personal candidates → expect NULL
//          (recovery state — never auto-linked).
//        - User D: Personal Workspace exists but membership role is
//          not Owner → expect NULL per the strict rule.
//   6. Applies the M2 migration SQL by reading the file and
//      executing each statement via `prisma.$executeRawUnsafe`. The
//      file contains ALTER TABLE, UPDATE, CREATE INDEX, ADD
//      CONSTRAINT, and a DO $$ ... $$ block; we split on `;\n` and
//      execute each non-empty statement.
//   7. Asserts the resulting `personalWorkspaceId` values match the
//      expected backfill behavior. Also asserts the unique index and
//      foreign key now exist.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

const MIGRATIONS_DIR = join(
  new URL("../../../../packages/db/prisma/migrations", import.meta.url).pathname,
);
const TARGET_MIGRATION_DIR = join(
  MIGRATIONS_DIR,
  "20260918120000_m2_personal_workspace_convergence",
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
 * `$executeRawUnsafe` accepts a single statement (or a `Prisma.sql`
 * template); we issue statements one at a time so PostgreSQL never
 * sees a script boundary mid-transaction.
 *
 * Dollar-quoted strings (`$$ ... $$`, used by `DO` blocks in
 * PostgreSQL) are treated as opaque — no statement splitting happens
 * inside them.
 */
function splitSqlStatements(sql: string): readonly string[] {
  const out: string[] = [];
  let buffer = "";
  let inDollarQuote = false;
  for (const rawLine of sql.split("\n")) {
    const line = rawLine.trimEnd();
    buffer += line + "\n";

    // Track dollar-quote state across lines. The migration's
    // operational-inventory block uses `DO $$ ... $$`.
    for (let i = 0; i < line.length - 1; i++) {
      if (line[i] === "$" && line[i + 1] === "$") {
        inDollarQuote = !inDollarQuote;
        i++;
      }
    }

    if (!inDollarQuote && line.trimEnd().endsWith(";")) {
      // Strip pure-comment lines from the buffered statement.
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

describe("PrismaAuthRepository — M2 #82 migration fixture", () => {
  let prisma: ReturnType<typeof createPrismaClient> | null = null;

  before(() => {
    if (skip) return;
    assertDisposableTestDatabase(readTestDatabaseUrl());
    prisma = createPrismaClient(readTestDatabaseUrl());
  });

  after(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test("the M2 migration backfills personalWorkspaceId strictly per the documented rule", async (t) => {
    if (skip || !prisma) {
      t.skip();
      return;
    }

    // 1. Drop the public schema so we start from an empty database.
    await prisma.$executeRawUnsafe("DROP SCHEMA public CASCADE");
    await prisma.$executeRawUnsafe("CREATE SCHEMA public");

    // 2. Apply every migration BEFORE the M2 target migration by
    //    replaying the prior `migration.sql` files in order.
    const allMigrationDirs = listMigrationDirs();
    const targetIndex = allMigrationDirs.indexOf(
      "20260918120000_m2_personal_workspace_convergence",
    );
    assert.ok(
      targetIndex > 0,
      "expected the M2 migration to be present and not the first migration",
    );
    const priorMigrations = allMigrationDirs.slice(0, targetIndex);

    for (const dirName of priorMigrations) {
      const sql = readMigrationSql(dirName);
      for (const stmt of splitSqlStatements(sql)) {
        await prisma.$executeRawUnsafe(stmt);
      }
    }

    // 3. Verify the column does NOT yet exist on user_accounts.
    const columnRows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'user_accounts'
         AND column_name = 'personalWorkspaceId'`,
    );
    assert.equal(
      columnRows.length,
      0,
      "expected personalWorkspaceId to NOT exist before the M2 migration is applied",
    );

    // 4. Insert the four fixture UserAccounts in the pre-M2 state.
    //    The Prisma client is generated from the post-M2 schema, so
    //    we use raw SQL to insert rows in the pre-M2 shape (no
    //    personalWorkspaceId). Each fixture requires its own
    //    UserAccount + Workspace(s) + WorkspaceMembership(s).
    const insertedUserIds: {
      readonly a: string;
      readonly b: string;
      readonly c: string;
      readonly d: string;
    } = await prisma.$transaction(async (tx) => {
      const userA = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "user_accounts" ("id", "email", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'fixture-a@example.test', now(), now())
           RETURNING "id"`,
      );
      const userB = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "user_accounts" ("id", "email", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'fixture-b@example.test', now(), now())
           RETURNING "id"`,
      );
      const userC = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "user_accounts" ("id", "email", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'fixture-c@example.test', now(), now())
           RETURNING "id"`,
      );
      const userD = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "user_accounts" ("id", "email", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'fixture-d@example.test', now(), now())
           RETURNING "id"`,
      );

      const aId = userA[0]!.id;
      const bId = userB[0]!.id;
      const cId = userC[0]!.id;
      const dId = userD[0]!.id;

      // Workspace for User B (single Owner Personal candidate).
      const workspaceB = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "workspaces" ("id", "slug", "name", "type", "status", "ownerUserId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'personal-b', 'B Personal', 'Personal', 'Active', $1, now(), now())
           RETURNING "id"`,
        bId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "workspace_memberships" ("id", "userId", "workspaceId", "role", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'Owner', now())`,
        bId,
        workspaceB[0]!.id,
      );

      // Two Personal Workspaces for User C — ambiguous.
      const workspaceC1 = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "workspaces" ("id", "slug", "name", "type", "status", "ownerUserId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'personal-c1', 'C Personal 1', 'Personal', 'Active', $1, now(), now())
           RETURNING "id"`,
        cId,
      );
      const workspaceC2 = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "workspaces" ("id", "slug", "name", "type", "status", "ownerUserId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'personal-c2', 'C Personal 2', 'Personal', 'Active', $1, now(), now())
           RETURNING "id"`,
        cId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "workspace_memberships" ("id", "userId", "workspaceId", "role", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'Owner', now())`,
        cId,
        workspaceC1[0]!.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "workspace_memberships" ("id", "userId", "workspaceId", "role", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'Owner', now())`,
        cId,
        workspaceC2[0]!.id,
      );

      // Workspace for User D — Personal type but membership is
      // NOT Owner. Migration must leave personalWorkspaceId NULL
      // because the strict rule requires `role = 'Owner'`.
      const workspaceD = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "workspaces" ("id", "slug", "name", "type", "status", "ownerUserId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'personal-d', 'D Personal', 'Personal', 'Active', $1, now(), now())
           RETURNING "id"`,
        dId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "workspace_memberships" ("id", "userId", "workspaceId", "role", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'Member', now())`,
        dId,
        workspaceD[0]!.id,
      );

      return { a: aId, b: bId, c: cId, d: dId };
    });

    const userAId = insertedUserIds.a;
    const userBId = insertedUserIds.b;
    const userCId = insertedUserIds.c;
    const userDId = insertedUserIds.d;

    // 5. Apply the M2 migration SQL by reading the file and
    //    executing each statement via $executeRawUnsafe.
    const m2Sql = readFileSync(join(TARGET_MIGRATION_DIR, "migration.sql"), "utf8");
    for (const stmt of splitSqlStatements(m2Sql)) {
      await prisma.$executeRawUnsafe(stmt);
    }

    // 6. Assert each user's resulting personalWorkspaceId matches
    //    the expected backfill behavior. We use raw SQL because the
    //    fixture rows were inserted without `personalWorkspaceId`,
    //    so the typed client (generated against the post-M2 schema)
    //    can still read them.
    const afterA = await prisma.$queryRawUnsafe<Array<{ personalWorkspaceId: string | null }>>(
      `SELECT "personalWorkspaceId" FROM "user_accounts" WHERE "id" = $1`,
      userAId,
    );
    const afterB = await prisma.$queryRawUnsafe<Array<{ personalWorkspaceId: string | null }>>(
      `SELECT "personalWorkspaceId" FROM "user_accounts" WHERE "id" = $1`,
      userBId,
    );
    const afterC = await prisma.$queryRawUnsafe<Array<{ personalWorkspaceId: string | null }>>(
      `SELECT "personalWorkspaceId" FROM "user_accounts" WHERE "id" = $1`,
      userCId,
    );
    const afterD = await prisma.$queryRawUnsafe<Array<{ personalWorkspaceId: string | null }>>(
      `SELECT "personalWorkspaceId" FROM "user_accounts" WHERE "id" = $1`,
      userDId,
    );

    assert.equal(
      afterA[0]?.personalWorkspaceId ?? null,
      null,
      "User A (zero candidates) must remain NULL after migration",
    );
    assert.ok(
      afterB[0]?.personalWorkspaceId,
      "User B (single Owner Personal candidate) must be backfilled to a non-NULL id",
    );
    assert.equal(
      afterC[0]?.personalWorkspaceId ?? null,
      null,
      "User C (two Owner Personal candidates — ambiguous) must remain NULL",
    );
    assert.equal(
      afterD[0]?.personalWorkspaceId ?? null,
      null,
      "User D (Personal type but non-Owner membership) must remain NULL per the strict rule",
    );

    // 7. The unique index and foreign key must now exist.
    const indexRows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'user_accounts'
         AND indexname = 'user_accounts_personalWorkspaceId_key'`,
    );
    assert.equal(
      indexRows.length,
      1,
      "expected the user_accounts_personalWorkspaceId_key unique index after migration",
    );

    const fkRows = await prisma.$queryRawUnsafe<Array<{ constraint_name: string }>>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND table_name = 'user_accounts'
         AND constraint_type = 'FOREIGN KEY'
         AND constraint_name = 'user_accounts_personalWorkspaceId_fkey'`,
    );
    assert.equal(
      fkRows.length,
      1,
      "expected the user_accounts_personalWorkspaceId_fkey foreign key after migration",
    );
  });
});
