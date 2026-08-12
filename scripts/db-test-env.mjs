// Shared env loader and path constants for db-test-* scripts. Loads
// TEST_DATABASE_URL from the repo's .env.test if it is not already set.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envTestPath = fileURLToPath(new URL("../.env.test", import.meta.url));

export function loadTestDatabaseEnv() {
  if (process.env.TEST_DATABASE_URL) return;
  if (!existsSync(envTestPath)) return;
  for (const line of readFileSync(envTestPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^TEST_DATABASE_URL=(.+)$/);
    if (match) {
      process.env.TEST_DATABASE_URL = match[1].replace(/^["']|["']$/g, "");
      return;
    }
  }
}

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const packagesDbDir = fileURLToPath(new URL("../packages/db/", import.meta.url));
export const appsApiTsx = fileURLToPath(
  new URL("../apps/api/node_modules/.bin/tsx", import.meta.url),
);
