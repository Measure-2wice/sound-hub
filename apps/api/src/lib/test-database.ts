// Disposable test database guard.
//
// The M1 repository integration tests and the Playwright happy-path tracer
// must run only against a local, isolated, `_test`-suffixed database. Any
// destructive operation funnels through this guard. If the URL is missing,
// remote, or the database name does not end in `_test`, the guard fails
// closed before any query is issued.

import { createPrismaClient, type PrismaClient } from "@soundhub/db";

export interface TestDatabaseConfig {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly prisma: PrismaClient;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

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

export function assertDisposableTestDatabase(url: string): {
  host: string;
  port: number;
  database: string;
} {
  const parsed = parsePostgresUrl(url);
  const host = parsed.hostname;
  const port = Number(parsed.port || 5432);
  const database = parsed.pathname.replace(/^\/+/, "");
  if (!LOCAL_HOSTS.has(host)) {
    throw new TestDatabaseGuardError(
      `Refusing to use TEST_DATABASE_URL: host ${host} is not local. Disposable test databases must run locally.`,
    );
  }
  if (!database.endsWith("_test")) {
    throw new TestDatabaseGuardError(
      `Refusing to use TEST_DATABASE_URL: database name '${database}' must end in '_test'.`,
    );
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new TestDatabaseGuardError(
      `Refusing to use TEST_DATABASE_URL: invalid port ${parsed.port}`,
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
