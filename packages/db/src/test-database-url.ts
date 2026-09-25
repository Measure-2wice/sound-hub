// Disposable-test-database URL guard.
//
// Background: Codex review (P2-001) flagged a `db → api → db` module
// cycle. The Milestone 2 recovery-user seed
// (`packages/db/prisma/seed-recovery-user.ts`) imported the
// disposable-target guard from `apps/api/src/lib/test-database.ts`,
// and that API module imports `@soundhub/db` for its Prisma client
// factory. The cycle made the seed's URL guard a transitive
// dependency on the API module, defeating the dependency direction
// the repository documents (`packages/db` has no application-layer
// dependencies).
//
// This module owns the URL-only guard so both
// `packages/db/prisma/*` and `apps/api/src/lib/test-database.ts`
// can apply the same fail-closed check from a DB-owned module. The
// API module continues to import this guard and re-exports it for
// every existing apps/api/* test caller.
//
// Scope of this guard:
//   - parse a postgres URL;
//   - read TEST_DATABASE_URL with a clear error message when unset;
//   - assert the URL is the exact approved disposable test target;
//   - assert the URL is NOT the manual-QA target (soundhub_qa);
//   - resolve the approved test URL plus its components in one call.
//
// Scope NOT covered here (stays in apps/api):
//   - manual-QA URL reading (`readQaDatabaseUrl` reads QA_DATABASE_URL);
//   - manual-QA URL assertion (`assertApprovedQaDatabase`);
//   - Prisma client construction (`createTestPrismaClient`,
//     `loadTestDatabaseConfig`) — those still need
//     `@soundhub/db`'s `createPrismaClient` and therefore belong in
//     the API module.
//   - The QA port/host constants used by the QA-only helpers
//     (`assertApprovedQaDatabase`). Those constants are duplicated
//     here for the cross-target isolation guard so packages/db can
//     fail closed against the QA name without dragging in the
//     QA-only URL validators.

export const APPROVED_TEST_DATABASE_NAME = "soundhub_m1_test";
export const APPROVED_TEST_DATABASE_PORT = 5433;
export const APPROVED_TEST_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

// Duplicated for the isolation guard. The QA database lives on the
// same port/host as the disposable test database but uses a
// different database name. Mirrors the constant the API module
// exposes — they MUST stay in sync.
export const APPROVED_QA_DATABASE_NAME = "soundhub_qa";

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseGuardError";
  }
}

export interface ApprovedTestTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

export function readTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new TestDatabaseGuardError(
      "TEST_DATABASE_URL is not set; refuse to run a test-database operation without an explicit target.",
    );
  }
  return url;
}

function parsePostgresUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new TestDatabaseGuardError(
      `TEST_DATABASE_URL is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TestDatabaseGuardError(
      `TEST_DATABASE_URL must be a postgresql:// URL (got ${parsed.protocol})`,
    );
  }
  return parsed;
}

/**
 * Fail closed if the destructive test target is the same database
 * as the manual-QA session. The two are required to live on
 * separate databases so a repository test cannot drop tables or
 * truncate data a running dev/QA server depends on. The check is a
 * pure same-DB-name comparison; it does not compare hosts because
 * both databases run on the same local Compose network.
 */
export function assertNotQaDatabase(url: string): void {
  const parsed = parsePostgresUrl(url);
  const database = parsed.pathname.replace(/^\/+/, "");
  if (database === APPROVED_QA_DATABASE_NAME) {
    throw new TestDatabaseGuardError(
      `Refusing to use database '${database}': this is the manual-QA target, not the destructive test target. Set TEST_DATABASE_URL to '${APPROVED_TEST_DATABASE_NAME}' (or any other non-QA database) before running repository tests.`,
    );
  }
}

/**
 * Assert that a URL points at the exact approved disposable test
 * database. Fail-closed: a missing, remote, wrong-port, or
 * wrong-database-name URL throws BEFORE any caller proceeds.
 */
export function assertDisposableTestDatabase(url: string): ApprovedTestTarget {
  const parsed = parsePostgresUrl(url);
  const host = parsed.hostname;
  const port = Number(parsed.port || 5432);
  const database = parsed.pathname.replace(/^\/+/, "");

  // Same-DB guard runs FIRST so a misconfigured QA URL surfaces
  // the QA-specific message rather than the generic database-name
  // mismatch.
  assertNotQaDatabase(url);

  if (!APPROVED_TEST_DATABASE_HOSTS.has(host)) {
    throw new TestDatabaseGuardError(
      `Refusing to use TEST_DATABASE_URL: host ${host} is not the approved local host (${[...APPROVED_TEST_DATABASE_HOSTS].join(", ")}).`,
    );
  }
  if (port !== APPROVED_TEST_DATABASE_PORT) {
    throw new TestDatabaseGuardError(
      `Refusing to use TEST_DATABASE_URL: port ${port} must be ${APPROVED_TEST_DATABASE_PORT}.`,
    );
  }
  if (database !== APPROVED_TEST_DATABASE_NAME) {
    throw new TestDatabaseGuardError(
      `Refusing to use TEST_DATABASE_URL: database name '${database}' must be exactly '${APPROVED_TEST_DATABASE_NAME}'.`,
    );
  }
  return { host, port, database };
}

/**
 * Validate and return the approved disposable test target. Use this from
 * wrapper scripts (db:test:reset, db:test:migrate, db:test:seed) so the
 * validated URL is the only one passed to the destructive child command.
 */
export function resolveApprovedTestDatabaseUrl(): ApprovedTestTarget & { readonly url: string } {
  const url = readTestDatabaseUrl();
  const target = assertDisposableTestDatabase(url);
  return { url, ...target };
}
