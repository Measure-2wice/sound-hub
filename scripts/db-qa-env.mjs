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

export const APPROVED_QA = {
  name: APPROVED_QA_DATABASE_NAME,
  port: APPROVED_QA_DATABASE_PORT,
  defaultUrl: `postgresql://soundhub:password@localhost:${APPROVED_QA_DATABASE_PORT}/${APPROVED_QA_DATABASE_NAME}`,
};

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
