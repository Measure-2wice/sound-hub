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
 * Validate and return the approved disposable test target. Use this from
 * wrapper scripts (db:test:reset, db:test:migrate, db:test:seed) so the
 * validated URL is the only one passed to the destructive child command.
 */
export function resolveApprovedTestDatabaseUrl(): ApprovedTestTarget & { readonly url: string } {
  const url = readTestDatabaseUrl();
  const target = assertDisposableTestDatabase(url);
  return { url, ...target };
}
