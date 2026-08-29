// Shared env loader and path constants for db-qa-* scripts. Loads
// QA_DATABASE_URL from the repo's .env if it is not already set.
//
// The QA database is the manual-QA target the dev API server reads
// when started via `pnpm dev:qa`. Destructive repository tests must
// NEVER target this database — see apps/api/src/lib/test-database.ts
// for the same-DB-name guard that enforces the separation.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const envExamplePath = fileURLToPath(new URL("../.env.example", import.meta.url));

const APPROVED_QA_DATABASE_NAME = "soundhub_qa";
const APPROVED_QA_DATABASE_PORT = 5433;
// The QA database lives on the local Compose instance; only loopback
// hosts are accepted by the centralised guard so a URL pointing at a
// remote database (even one named `soundhub_qa`) is rejected.
const APPROVED_QA_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const APPROVED_QA = {
  name: APPROVED_QA_DATABASE_NAME,
  port: APPROVED_QA_DATABASE_PORT,
  hosts: APPROVED_QA_DATABASE_HOSTS,
  defaultUrl: `postgresql://soundhub:password@localhost:${APPROVED_QA_DATABASE_PORT}/${APPROVED_QA_DATABASE_NAME}`,
};

/**
 * Fail-closed validation for `QA_DATABASE_URL`. Every QA wrapper
 * (wait / migrate / seed / dev) calls this helper before any
 * mutation; the helper rejects non-postgres schemes, non-loopback
 * hosts, the wrong port, and the wrong database name. The check is
 * centralised in `scripts/db-qa-env.mjs` so the QA scripts all share
 * the same guard, and so `scripts/db-qa-env.test.mjs` can pin every
 * branch to a regression test.
 */
export function assertApprovedQaDatabaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(
      `QA_DATABASE_URL is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(`QA_DATABASE_URL must be a postgresql:// URL (got ${parsed.protocol}).`);
  }
  // WHATWG URL preserves the brackets around an IPv6 host
  // (`[::1]`). Strip them so the loopback-host set check matches the
  // canonical `::1` entry.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(parsed.port || 5432);
  const database = parsed.pathname.replace(/^\/+/, "");
  if (!APPROVED_QA_DATABASE_HOSTS.has(host)) {
    throw new Error(
      `Refusing to use QA_DATABASE_URL: host ${host} is not the approved local host (${[...APPROVED_QA_DATABASE_HOSTS].join(", ")}).`,
    );
  }
  if (port !== APPROVED_QA_DATABASE_PORT) {
    throw new Error(
      `Refusing to use QA_DATABASE_URL: port ${port} must be ${APPROVED_QA_DATABASE_PORT}.`,
    );
  }
  if (database !== APPROVED_QA_DATABASE_NAME) {
    throw new Error(
      `Refusing to use QA_DATABASE_URL: database name '${database}' must be exactly '${APPROVED_QA_DATABASE_NAME}'.`,
    );
  }
  return { url, host, port, database };
}

/**
 * Load `QA_DATABASE_URL` (defaulting to the approved local QA
 * target) and validate it. Returns the validated components so
 * wrapper scripts can log the resolved target before mutating it.
 */
export function resolveApprovedQaDatabaseUrl() {
  const url = process.env.QA_DATABASE_URL ?? APPROVED_QA.defaultUrl;
  return assertApprovedQaDatabaseUrl(url);
}

export function loadQaDatabaseEnv() {
  if (process.env.QA_DATABASE_URL) return;
  // Prefer the developer's local `.env`; fall back to `.env.example`
  // so the wiring is documented and reproducible from a fresh clone.
  for (const candidate of [envPath, envExamplePath]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split(/\r?\n/)) {
      const match = line.match(/^QA_DATABASE_URL=(.+)$/);
      if (match) {
        process.env.QA_DATABASE_URL = match[1].replace(/^["']|["']$/g, "");
        return;
      }
    }
  }
}

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const packagesDbDir = fileURLToPath(new URL("../packages/db/", import.meta.url));
export const appsApiTsx = fileURLToPath(
  new URL("../apps/api/node_modules/.bin/tsx", import.meta.url),
);
