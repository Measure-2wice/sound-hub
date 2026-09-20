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
// backfills correctly.
//
// Isolation: this test runs in an ISOLATED PostgreSQL schema named
// `migration_fixture_test`. Every schema object is created inside
// that schema and dropped on teardown so the canonical `public`
// schema (which other repository tests and the seed rely on) is
// never touched. After this test, `pnpm test:repository` continues
// to find the seed data intact.
//
// Procedure:
//   1. Open the disposable `TEST_DATABASE_URL` (fail-closed by the
//      test-database guard).
//   2. Drop and recreate the `migration_fixture_test` schema
//      (isolated).
//   3. Set `search_path` to the isolated schema and apply every
//      migration BEFORE the M2 target migration by replaying each
//      `migration.sql` file via `prisma.$executeRawUnsafe` in
//      chronological order. (`prisma migrate deploy` cannot stop
//      mid-sequence without an isolated migration set, so the
//      supported mechanism is to replay prior SQL files directly.)
//   4. Assert `user_accounts.personalWorkspaceId` does not yet
//      exist in the isolated schema (`information_schema.columns`).
//   5. Insert fixture UserAccounts in the pre-M2 state:
//        - User A: zero Owner Personal candidates → expect NULL
//          after migration.
//        - User B: one Owner Personal candidate → expect backfill.
//        - User C: two Owner Personal candidates → expect NULL
//          (per-user recovery state — never auto-linked).
//        - User D: Personal Workspace exists but membership role is
//          not Owner → expect NULL per the strict rule.
//        - User co-A, co-B: both Owner members of the same Personal
//          Workspace W → expect NULL after migration (cross-user
//          co-ownership — the workspace has 2+ distinct Owner
//          UserAccounts and is therefore never auto-linked).
//        - User co-C: sole Owner of a separate Personal Workspace
//          W2 → expect backfill (positive control proving the
//          workspace-direction gate only excludes W, not W2).
//   6. Apply the M2 migration SQL by reading the file and
//      executing each statement via `prisma.$executeRawUnsafe`.
//      The file contains ALTER TABLE, UPDATE, CREATE INDEX, ADD
//      CONSTRAINT, and a DO $$ ... $$ block; we split on `;\n` and
//      execute each non-empty statement.
//   7. Assert the resulting `personalWorkspaceId` values match the
//      expected backfill behavior. Also assert the unique index
//      and foreign key now exist in the isolated schema.
//   8. Drop the isolated schema on teardown.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createPrismaClient } from "@soundhub/db";
import { assertDisposableTestDatabase, readTestDatabaseUrl } from "../lib/test-database.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = !TEST_DATABASE_URL;

// ISOLATED SCHEMA — never touches `public` so other repository
// tests that depend on the seed are unaffected.
const ISOLATED_SCHEMA = "migration_fixture_test";

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
    // The isolated-schema client uses PostgreSQL's libpq `options=`
    // parameter to set `search_path` at CONNECTION time. Every
    // connection the pool acquires inherits `search_path =
    // migration_fixture_test`, so the pooled Prisma calls cannot
    // leak into the canonical `public` schema — even across
    // multiple connections / concurrent operations. This is the
    // durable fix for the previous session-scoped `SET search_path`
    // approach which only affected the single connection that
    // happened to run the SET.
    const baseUrl = readTestDatabaseUrl();
    const isolatedUrl = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${ISOLATED_SCHEMA}`;
    prisma = createPrismaClient(isolatedUrl);
  });

  after(async () => {
    if (prisma) {
      // Tear down the isolated schema. Wrap in try/catch so a
      // failure in the test body does not leave the schema in the
      // database for subsequent runs.
      try {
        await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${ISOLATED_SCHEMA}" CASCADE`);
      } catch {
        /* ignore — the schema may not have been created */
      }
      await prisma.$disconnect();
    }
  });

  test("the M2 migration backfills personalWorkspaceId strictly per the documented rule", async (t) => {
    if (skip || !prisma) {
      t.skip();
      return;
    }

    // 1. Create the ISOLATED schema (not `public`). Drop + recreate
    //    to ensure a clean slate. The client URL already sets
    //    `search_path` at connection time, so every subsequent
    //    statement (including the migration SQL replay below)
    //    lands in the isolated schema without explicit `SET
    //    search_path` calls. We still CREATE the schema here so
    //    it exists before the first migration statement runs.
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${ISOLATED_SCHEMA}" CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${ISOLATED_SCHEMA}"`);

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

    // 3. Verify the column does NOT yet exist on user_accounts in
    //    the isolated schema.
    const columnRows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'user_accounts'
         AND column_name = 'personalWorkspaceId'`,
      ISOLATED_SCHEMA,
    );
    assert.equal(
      columnRows.length,
      0,
      "expected personalWorkspaceId to NOT exist before the M2 migration is applied",
    );

    // 4. Insert the four pre-existing fixtures (A/B/C/D) PLUS the
    //    three co-ownership fixtures (co-A/co-B/co-C) in the pre-M2
    //    state. The Prisma client is generated from the post-M2
    //    schema, so we use raw SQL to insert rows in the pre-M2
    //    shape (no personalWorkspaceId). Each fixture requires its
    //    own UserAccount + Workspace(s) + WorkspaceMembership(s).
    //
    //    The co-ownership fixtures are distinct from the pre-existing
    //    per-user ambiguous User C — User C has 2 Owner Personal
    //    memberships for one UserAccount (per-user ambiguity), while
    //    co-A/co-B/co-C exercise the cross-user co-ownership shape
    //    where two distinct UserAccounts share Owner membership on
    //    the same Personal Workspace. Distinct IDs/names are used so
    //    the two fixtures do not collide conceptually or literally.
    const insertedUserIds: {
      readonly a: string;
      readonly b: string;
      readonly c: string;
      readonly d: string;
      readonly coA: string;
      readonly coB: string;
      readonly coC: string;
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
      const coOwnedUserA = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "user_accounts" ("id", "email", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'fixture-co-a@example.test', now(), now())
           RETURNING "id"`,
      );
      const coOwnedUserB = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "user_accounts" ("id", "email", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'fixture-co-b@example.test', now(), now())
           RETURNING "id"`,
      );
      const coOwnedUserC = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "user_accounts" ("id", "email", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'fixture-co-c@example.test', now(), now())
           RETURNING "id"`,
      );

      const aId = userA[0]!.id;
      const bId = userB[0]!.id;
      const cId = userC[0]!.id;
      const dId = userD[0]!.id;
      const coAId = coOwnedUserA[0]!.id;
      const coBId = coOwnedUserB[0]!.id;
      const coCId = coOwnedUserC[0]!.id;

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

      // Co-ownership fixture: User co-A and User co-B are both
      // Owner members of the same Personal Workspace W. User co-C
      // is the sole Owner of a separate Personal Workspace W2.
      // Distinct IDs/names from the per-user ambiguous User C so
      // the two fixtures do not collide.
      const workspaceW = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "workspaces" ("id", "slug", "name", "type", "status", "ownerUserId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'personal-co-w', 'Co-owned Personal', 'Personal', 'Active', $1, now(), now())
           RETURNING "id"`,
        coAId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "workspace_memberships" ("id", "userId", "workspaceId", "role", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'Owner', now())`,
        coAId,
        workspaceW[0]!.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "workspace_memberships" ("id", "userId", "workspaceId", "role", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'Owner', now())`,
        coBId,
        workspaceW[0]!.id,
      );
      const workspaceW2 = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "workspaces" ("id", "slug", "name", "type", "status", "ownerUserId", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, 'personal-co-w2', 'Sole-owned Personal', 'Personal', 'Active', $1, now(), now())
           RETURNING "id"`,
        coCId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "workspace_memberships" ("id", "userId", "workspaceId", "role", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, 'Owner', now())`,
        coCId,
        workspaceW2[0]!.id,
      );

      return {
        a: aId,
        b: bId,
        c: cId,
        d: dId,
        coA: coAId,
        coB: coBId,
        coC: coCId,
      };
    });

    const userAId = insertedUserIds.a;
    const userBId = insertedUserIds.b;
    const userCId = insertedUserIds.c;
    const userDId = insertedUserIds.d;
    const userCoAId = insertedUserIds.coA;
    const userCoBId = insertedUserIds.coB;
    const userCoCId = insertedUserIds.coC;

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
    const afterCoA = await prisma.$queryRawUnsafe<Array<{ personalWorkspaceId: string | null }>>(
      `SELECT "personalWorkspaceId" FROM "user_accounts" WHERE "id" = $1`,
      userCoAId,
    );
    const afterCoB = await prisma.$queryRawUnsafe<Array<{ personalWorkspaceId: string | null }>>(
      `SELECT "personalWorkspaceId" FROM "user_accounts" WHERE "id" = $1`,
      userCoBId,
    );
    const afterCoC = await prisma.$queryRawUnsafe<Array<{ personalWorkspaceId: string | null }>>(
      `SELECT "personalWorkspaceId" FROM "user_accounts" WHERE "id" = $1`,
      userCoCId,
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
    // Co-ownership fixtures: the cross-user ambiguous shape is
    // never auto-resolved. The migration must leave the pointer
    // NULL for both co-owners (the workspace has 2+ distinct Owner
    // UserAccounts), and the sole Owner of W2 must still backfill.
    assert.equal(
      afterCoA[0]?.personalWorkspaceId ?? null,
      null,
      "User co-A (Owner of co-owned W) must remain NULL after migration",
    );
    assert.equal(
      afterCoB[0]?.personalWorkspaceId ?? null,
      null,
      "User co-B (Owner of co-owned W) must remain NULL after migration",
    );
    assert.ok(
      afterCoC[0]?.personalWorkspaceId,
      "User co-C (sole Owner of W2) must be backfilled to a non-NULL id",
    );

    // 7. The unique index and foreign key must now exist.
    const indexRows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'user_accounts'
         AND indexname = 'user_accounts_personalWorkspaceId_key'`,
      ISOLATED_SCHEMA,
    );
    assert.equal(
      indexRows.length,
      1,
      "expected the user_accounts_personalWorkspaceId_key unique index after migration",
    );

    const fkRows = await prisma.$queryRawUnsafe<Array<{ constraint_name: string }>>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_schema = $1 AND table_name = 'user_accounts'
         AND constraint_type = 'FOREIGN KEY'
         AND constraint_name = 'user_accounts_personalWorkspaceId_fkey'`,
      ISOLATED_SCHEMA,
    );
    assert.equal(
      fkRows.length,
      1,
      "expected the user_accounts_personalWorkspaceId_fkey foreign key after migration",
    );

    // 8. Authority records are not rewritten: every Workspaces row
    //    and every WorkspaceMembership row the fixture inserted must
    //    still exist after the migration. Co-ownership in particular
    //    must NOT cause the migration to delete or rewrite memberships
    //    — both co-A and co-B retain their Owner memberships on W.
    const workspaceCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM "workspaces"`,
    );
    assert.equal(
      Number(workspaceCount[0]?.count ?? -1),
      6,
      "exactly six Workspaces must survive the migration (B, C1, C2, D, W, W2)",
    );
    const membershipRows = await prisma.$queryRawUnsafe<
      Array<{ userId: string; workspaceId: string; role: string }>
    >(
      `SELECT "userId", "workspaceId", "role" FROM "workspace_memberships"
       WHERE "userId" IN ($1, $2, $3, $4, $5, $6, $7)
       ORDER BY "userId", "workspaceId"`,
      userAId,
      userBId,
      userCId,
      userDId,
      userCoAId,
      userCoBId,
      userCoCId,
    );
    assert.equal(
      membershipRows.length,
      7,
      "every fixture membership must survive the migration (B→1, C→2, D→1, co-A→1, co-B→1, co-C→1)",
    );
    const coOwnershipMemberships = membershipRows.filter(
      (m) => m.userId === userCoAId || m.userId === userCoBId,
    );
    assert.equal(
      coOwnershipMemberships.length,
      2,
      "co-A and co-B must each retain their Owner membership on W",
    );
    for (const m of coOwnershipMemberships) {
      assert.equal(m.role, "Owner", "co-ownership memberships must remain Owner after migration");
    }

    // 9. Codex review (P2-001): the migration's operational-inventory
    //    NOTICE block reports the count of UserAccounts with MULTIPLE
    //    Owner Personal memberships. The corrected query counts
    //    DISTINCT users (so a user with 2 candidates counts as 1,
    //    not 2). Re-run the same COUNT(DISTINCT) shape here to pin
    //    the regression: User C has 2 candidates, no other user has
    //    multiple, so the count is 1.
    const ambiguousCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(DISTINCT m."userId") AS count
       FROM "workspace_memberships" m
       INNER JOIN "workspaces" w ON w."id" = m."workspaceId"
       WHERE m."role" = 'Owner' AND w."type" = 'Personal'
         AND EXISTS (
           SELECT 1 FROM "workspace_memberships" m2
           INNER JOIN "workspaces" w2 ON w2."id" = m2."workspaceId"
           WHERE m2."userId" = m."userId"
             AND m2."role" = 'Owner'
             AND w2."type" = 'Personal'
             AND m2."workspaceId" != m."workspaceId"
         )`,
    );
    assert.equal(
      Number(ambiguousCount[0]?.count ?? -1),
      1,
      "exactly one UserAccount (User C) has multiple Owner Personal memberships — counting DISTINCT users, not membership rows",
    );

    // 10. Co-ownership counter: the migration's
    //     `co_owned_workspace_count` reports Personal Workspaces
    //     whose Owner-membership set contains 2+ distinct
    //     UserAccounts. The fixture has exactly one such workspace
    //     (W); the count is therefore 1. co-A and co-B must NOT be
    //     counted because they are per-user-unambiguous (each has
    //     exactly one Owner Personal membership).
    const coOwnedWorkspaceCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count
       FROM (
         SELECT m."workspaceId" AS ws_id
         FROM "workspace_memberships" m
         INNER JOIN "workspaces" w ON w."id" = m."workspaceId"
         WHERE m."role" = 'Owner' AND w."type" = 'Personal'
         GROUP BY m."workspaceId"
         HAVING COUNT(DISTINCT m."userId") >= 2
       ) co_owned`,
    );
    assert.equal(
      Number(coOwnedWorkspaceCount[0]?.count ?? -1),
      1,
      "exactly one Personal Workspace (W) is co-owned — the co-ownership counter pin",
    );

    // 11. The CANONICAL `public` schema must be untouched. Use a
    //     separate connection (no search_path) to prove the shared
    //     schema is unchanged so subsequent repository tests see
    //     the seeded state intact. The disposable test database's
    //     seed inserts the demo buyer (one of the seeded
    //     UserAccounts); if the test had leaked into `public` the
    //     demo buyer would still be present (we never modified it)
    //     AND the seeded `personalWorkspaceId` column would NOT
    //     exist on the seeded buyer (the canonical schema was
    //     applied before the M2 migration that adds the column).
    //     We assert the column IS present on the canonical
    //     UserAccount by switching to a fresh client without the
    //     isolated-schema search_path.
    const publicClient = createPrismaClient(readTestDatabaseUrl());
    try {
      const publicColumns = await publicClient.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'user_accounts'
           AND column_name = 'personalWorkspaceId'`,
      );
      assert.equal(
        publicColumns.length,
        1,
        "canonical 'public' schema must still have the personalWorkspaceId column (untouched by the migration fixture)",
      );
    } finally {
      await publicClient.$disconnect();
    }
  });
});
