// Disposable test database guard.
//
// The M1 repository integration tests, the seed, the migration commands,
// and the Playwright happy-path tracer must run only against the
// approved, exact, local disposable PostgreSQL target. Any destructive or
// schema-mutating operation funnels through this guard. If the URL is
// missing, remote, the wrong port, the wrong database name, or does not
// match the approved M1 disposable target, the guard fails closed before
// any query is issued.

import { createPrismaClient, type PrismaClient } from "@soundhub/db";

export interface TestDatabaseConfig {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly prisma: PrismaClient;
}

// The M1 disposable test database is a hardcoded, exact target. Any
// deviation must fail closed so the developer database or staging data
// can never be reached by M1.1 destructive or migration commands.
export const APPROVED_TEST_DATABASE_NAME = "soundhub_m1_test";
export const APPROVED_TEST_DATABASE_PORT = 5433;
export const APPROVED_TEST_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseGuardError";
  }
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

export interface ApprovedTestTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

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

export function createTestPrismaClient(): PrismaClient {
  const url = readTestDatabaseUrl();
  assertDisposableTestDatabase(url);
  return createPrismaClient(url);
}

export function loadTestDatabaseConfig(): TestDatabaseConfig {
  const url = readTestDatabaseUrl();
  const { host, port, database } = assertDisposableTestDatabase(url);
  return {
    url,
    host,
    port,
    database,
    prisma: createPrismaClient(url),
  };
}

/**
 * Read the configured manual-QA database URL. The manual-QA
 * session is a separate disposable target so destructive repository
 * tests cannot mutate the database a running QA server depends on.
 *
 * Manual QA reads from `QA_DATABASE_URL` (default
 * `postgresql://soundhub:password@localhost:5433/soundhub_qa`); the
 * destructive test scripts read from `TEST_DATABASE_URL`
 * (default `soundhub_m1_test`). The two never share a database name.
 */
export const APPROVED_QA_DATABASE_NAME = "soundhub_qa";
export const APPROVED_QA_DATABASE_PORT = 5433;
// The manual-QA database lives on the same local Compose instance as
// the disposable test database. Only loopback hosts are accepted; a
// remote host (even one that happens to expose a database named
// `soundhub_qa`) is rejected so migration and seed commands cannot
// reach an unintended remote database.
export const APPROVED_QA_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

export function readQaDatabaseUrl(): string {
  const url = process.env.QA_DATABASE_URL;
  if (url) return url;
  return `postgresql://soundhub:password@localhost:${APPROVED_QA_DATABASE_PORT}/${APPROVED_QA_DATABASE_NAME}`;
}

/**
 * Fail-closed guard for the manual-QA database.
 *
 * Background: the BG3 codebase ships QA wrappers
 * (`scripts/db-qa-{wait,migrate,seed}.mjs` and `scripts/dev-qa.mjs`)
 * that mutate the manual-QA database. Before this guard they only
 * validated the database name, so a URL such as
 * `postgresql://remote-host:5432/soundhub_qa` would silently pass and
 * the wrappers would migrate and seed an unintended remote database.
 *
 * This helper rejects any URL whose protocol is not postgresql, whose
 * host is not loopback, whose port is not 5433, or whose database name
 * is not the exact approved QA target. The wrappers import this
 * helper from `apps/api/src/lib/test-database.ts` so the guard is
 * centralised and the suite of regression tests below pins every
 * component (host, port, scheme, database name) to its expected
 * behaviour.
 */
export function assertApprovedQaDatabase(url: string): ApprovedTestTarget {
  const parsed = parsePostgresUrl(url);
  // WHATWG URL preserves the brackets around an IPv6 host
  // (`[::1]`). Strip them so the loopback-host set check matches the
  // canonical `::1` entry.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(parsed.port || 5432);
  const database = parsed.pathname.replace(/^\/+/, "");

  if (!APPROVED_QA_DATABASE_HOSTS.has(host)) {
    throw new TestDatabaseGuardError(
      `Refusing to use QA_DATABASE_URL: host ${host} is not the approved local host (${[...APPROVED_QA_DATABASE_HOSTS].join(", ")}).`,
    );
  }
  if (port !== APPROVED_QA_DATABASE_PORT) {
    throw new TestDatabaseGuardError(
      `Refusing to use QA_DATABASE_URL: port ${port} must be ${APPROVED_QA_DATABASE_PORT}.`,
    );
  }
  if (database !== APPROVED_QA_DATABASE_NAME) {
    throw new TestDatabaseGuardError(
      `Refusing to use QA_DATABASE_URL: database name '${database}' must be exactly '${APPROVED_QA_DATABASE_NAME}'.`,
    );
  }
  return { host, port, database };
}

/**
 * Read `QA_DATABASE_URL`, validate it against the approved
 * manual-QA target, and return both the validated components and the
 * original URL so wrapper scripts can pass the exact URL to child
 * commands. This mirrors `resolveApprovedTestDatabaseUrl` so the
 * QA wrappers and the destructive test wrappers share an identical
 * shape.
 */
export function resolveApprovedQaDatabaseUrl(): ApprovedTestTarget & { readonly url: string } {
  const url = readQaDatabaseUrl();
  const target = assertApprovedQaDatabase(url);
  return { url, ...target };
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
 * Validate and return the approved disposable test target. Use this from
 * wrapper scripts (db:test:reset, db:test:migrate, db:test:seed) so the
 * validated URL is the only one passed to the destructive child command.
 */
export function resolveApprovedTestDatabaseUrl(): ApprovedTestTarget & { readonly url: string } {
  const url = readTestDatabaseUrl();
  const target = assertDisposableTestDatabase(url);
  return { url, ...target };
}
