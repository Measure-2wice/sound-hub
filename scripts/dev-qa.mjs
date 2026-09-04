// Start the dev API server bound to the manual-QA database.
//
// Loads QA_DATABASE_URL from the repo's `.env` (or `.env.example`)
// and exports it as DATABASE_URL before launching `apps/api`'s dev
// script. `dotenv/config` does not override an existing process
// env, so the QA URL wins over any `.env` value the developer has
// configured.
//
// Usage:
//   pnpm db:test:up
//   pnpm db:qa:migrate
//   pnpm db:qa:seed
//   pnpm dev:qa
//
// Destructive repository tests must NEVER target this database —
// see apps/api/src/lib/test-database.ts for the same-DB-name guard
// that enforces the separation.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveApprovedQaDatabaseUrl } from "./db-qa-env.mjs";

let target;
try {
  target = resolveApprovedQaDatabaseUrl();
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const { url, host, port, database } = target;

const appsApiDir = fileURLToPath(new URL("../apps/api/", import.meta.url));
const appsApiTsxWatch = fileURLToPath(
  new URL("../apps/api/node_modules/.bin/tsx", import.meta.url),
);

console.log(`▶ Starting API dev server bound to QA target ${host}:${port}/${database}`);

const child = spawn(appsApiTsxWatch, ["watch", "src/server.ts"], {
  cwd: appsApiDir,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: url,
    QA_DATABASE_URL: url,
    SOUNDHUB_RUN_MODE: "qa",
  },
});

const forwardSignal = (signal) => {
  try {
    child.kill(signal);
  } catch {
    // child may have already exited
  }
};
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    console.log(`\ndev:qa received ${signal}; exiting.`);
    process.exit(0);
  }
  process.exit(code ?? 0);
});
