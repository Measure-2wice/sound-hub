// BG7 deterministic-audio-fixture database-target guard.
//
// Background: ticket #65 (BG7) requires the seed to insert a single
// deterministic audio-sample fixture so the integrated browser
// journey can preview audio without managed storage. Environment
// flags alone cannot prove the fixture will land on an approved
// disposable test database — a caller could combine
// NODE_ENV=test + BG2_STORAGE_BACKEND=deterministic +
// BG7_DETERMINISTIC_AUDIO_FIXTURE=1 with a managed DATABASE_URL and
// silently rewrite managed metadata. This guard verifies that the
// actual DATABASE_URL points at the exact approved disposable local
// PostgreSQL database the seed test suite uses, so the fixture can
// never reach a managed, remote, or shared target. If the URL cannot
// be proven safe, the caller MUST treat the guard as failed and
// skip fixture insertion.
//
// The rule mirrors the predicate the seed test suite already uses
// (packages/db/prisma/seed.test.ts) so the seed and the test
// harness stay in lock-step. The guard is deliberately small and
// ticket-scoped: it only knows the four canonical
// disposable-test-DB facts (host, port, database name, protocol).
// It is NOT a generalised infrastructure layer.
//
// The four canonical facts:
//   - protocol is postgresql or postgres
//   - hostname is one of localhost / 127.0.0.1 / ::1 (the loopback
//     set used by the local Docker Compose test database)
//   - port is 5433 (the disposable-test port reserved by
//     docker-compose.test.yml)
//   - database is soundhub_m1_test (the disposable-test database
//     owned by the seed test suite)

const APPROVED_DATABASE = "soundhub_m1_test";
const APPROVED_PORT = 5433;
const APPROVED_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

export interface ApprovedDisposableTestDbConfig {
  readonly database: string;
  readonly port: number;
  readonly hosts: ReadonlySet<string>;
}

export const APPROVED_DISPOSABLE_TEST_DB: ApprovedDisposableTestDbConfig = Object.freeze({
  database: APPROVED_DATABASE,
  port: APPROVED_PORT,
  hosts: APPROVED_HOSTS,
});

export type ApprovedDisposableTestDbCheck =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: string };

export class ApprovedDisposableTestDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovedDisposableTestDbError";
  }
}

/**
 * Verify that a database URL points at the exact approved disposable
 * local PostgreSQL. The check is fail-closed: a missing or unparseable
 * URL is not approved. The reason field carries a bounded diagnostic
 * (host/port/database name, no credentials) so callers can log without
 * leaking secrets.
 */
export function checkApprovedDisposableTestDatabase(
  url: string | undefined,
): ApprovedDisposableTestDbCheck {
  if (!url) {
    return { approved: false, reason: "DATABASE_URL is not set" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    return {
      approved: false,
      reason: `invalid URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return { approved: false, reason: `not a postgres URL: ${parsed.protocol}` };
  }
  if (!APPROVED_HOSTS.has(parsed.hostname)) {
    return { approved: false, reason: `host ${parsed.hostname} is not an approved local host` };
  }
  if (Number(parsed.port || 5432) !== APPROVED_PORT) {
    return {
      approved: false,
      reason: `port ${parsed.port || "default"} must be ${APPROVED_PORT}`,
    };
  }
  const database = parsed.pathname.replace(/^\/+/, "");
  if (database !== APPROVED_DATABASE) {
    return { approved: false, reason: `database ${database} must be ${APPROVED_DATABASE}` };
  }
  return { approved: true };
}

export function isApprovedDisposableTestDatabase(url: string | undefined): boolean {
  return checkApprovedDisposableTestDatabase(url).approved;
}
