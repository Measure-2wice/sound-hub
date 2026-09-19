// Disposable test database guard.
//
// The M1 repository integration tests, the seed, the migration commands,
// and the Playwright happy-path tracer must run only against the
// approved, exact, local disposable PostgreSQL target. Any destructive or
// schema-mutating operation funnels through this guard. If the URL is
// missing, remote, the wrong port, the wrong database name, or does not
// match the approved M1 disposable target, the guard fails closed before
// any query is issued.
//
// M2 (#82 P2-001): the URL-only guard (`assertDisposableTestDatabase`,
// `readTestDatabaseUrl`, the approved-target constants, and the
// same-DB-name QA isolation check) now lives in `@soundhub/db` so the
// `packages/db/prisma/*` scripts can apply the same fail-closed check
// without reaching into apps/api (which would create a `db → api → db`
// module cycle). This module re-exports those symbols from
// `@soundhub/db` for every existing apps/api/* test caller and keeps
// the API-specific concerns (Prisma client factories, manual-QA
// validators, manual-QA URL reading) here.
//
// The re-exports below use `export { x as y }` so every existing
// apps/api/* caller keeps the same symbol identity (in particular the
// `TestDatabaseGuardError` class, so `instanceof` checks across the
// boundary still work).

import { createPrismaClient, type PrismaClient } from "@soundhub/db";
import {
  APPROVED_TEST_DATABASE_HOSTS as APPROVED_TEST_DATABASE_HOSTS_SRC,
  APPROVED_TEST_DATABASE_NAME as APPROVED_TEST_DATABASE_NAME_SRC,
  APPROVED_TEST_DATABASE_PORT as APPROVED_TEST_DATABASE_PORT_SRC,
  APPROVED_QA_DATABASE_NAME as APPROVED_QA_DATABASE_NAME_SRC,
  TestDatabaseGuardError,
  assertDisposableTestDatabase,
  assertNotQaDatabase,
  readTestDatabaseUrl,
  resolveApprovedTestDatabaseUrl,
  type ApprovedTestTarget,
} from "@soundhub/db";

export interface TestDatabaseConfig {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly prisma: PrismaClient;
}

// Re-exports for backward compatibility. Use the `as` form so the
// symbol identity (class instance, ReadonlySet instance, value
// reference) is identical to the `@soundhub/db` source.
export const APPROVED_TEST_DATABASE_NAME = APPROVED_TEST_DATABASE_NAME_SRC;
export const APPROVED_TEST_DATABASE_PORT = APPROVED_TEST_DATABASE_PORT_SRC;
export const APPROVED_TEST_DATABASE_HOSTS: ReadonlySet<string> = APPROVED_TEST_DATABASE_HOSTS_SRC;
export { TestDatabaseGuardError };
export { assertDisposableTestDatabase };
export { assertNotQaDatabase };
export { readTestDatabaseUrl };
export { resolveApprovedTestDatabaseUrl };
export type { ApprovedTestTarget };

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
export const APPROVED_QA_DATABASE_PORT = 5433;
// The manual-QA database lives on the same local Compose instance as the
// disposable test database. Only loopback hosts are accepted; a remote
// host (even one that happens to expose a database named `soundhub_qa`)
// is rejected so migration and seed commands cannot reach an unintended
// remote database.
export const APPROVED_QA_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);
// QA database name constant comes from `@soundhub/db` (mirrored here
// as `APPROVED_QA_DATABASE_NAME` for callers that read it directly).
export const APPROVED_QA_DATABASE_NAME: string = APPROVED_QA_DATABASE_NAME_SRC;

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

// Local WHATWG URL parser for the manual-QA validator. The
// disposable-test-database validator's parser is private to
// `@soundhub/db`'s module and intentionally not exported; the QA
// validator here needs its own so the helpers stay self-contained.
function parsePostgresUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new TestDatabaseGuardError(
      `QA_DATABASE_URL is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new TestDatabaseGuardError(
      `QA_DATABASE_URL must be a postgresql:// URL (got ${parsed.protocol})`,
    );
  }
  return parsed;
}
