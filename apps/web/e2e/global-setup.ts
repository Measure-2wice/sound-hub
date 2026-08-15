// Global setup for the Playwright happy-path tracer.
//
// 1. Run the fail-closed full disposable test database cycle
//    (`pnpm db:test:cycle`) which:
//      - validates the approved exact target
//        (localhost:5433/soundhub_m1_test),
//      - drops and recreates the public schema,
//      - re-applies the reviewed migration from empty state,
//      - runs the deterministic seed twice and compares invariant
//        snapshots.
// 2. Wait until both the API (port 4000) and the web (port 3000)
//    respond.
//
// The webServer (Next.js + Express via `pnpm dev`) is started by
// Playwright and outlives the globalSetup.

import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  APPROVED_TEST_DATABASE_HOSTS,
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
} from "../../api/src/lib/test-database.js";

const API_PORT = Number(process.env.PORT_API ?? process.env.PORT ?? 4000);
const WEB_PORT = Number(process.env.PORT_WEB ?? 3000);
const API_HEALTH_URL = process.env.API_URL ?? `http://localhost:${API_PORT}/api/health`;
const WEB_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

function runStep(label: string, command: string, env: Record<string, string>): void {
  console.log(`▶ ${label}`);
  execSync(command, {
    cwd: "../..",
    stdio: "inherit",
    env: {
      ...process.env,
      ...env,
      NODE_ENV: (env.NODE_ENV ?? "test") as "test" | "development" | "production",
    },
  });
}

export default async function globalSetup(): Promise<void> {
  console.log(
    `▶ Approved disposable test target: host ∈ {${[...APPROVED_TEST_DATABASE_HOSTS].join(", ")}}, ` +
      `port = ${APPROVED_TEST_DATABASE_PORT}, database = ${APPROVED_TEST_DATABASE_NAME}`,
  );
  runStep(
    "Running fail-closed full disposable test database cycle",
    "apps/api/node_modules/.bin/tsx scripts/db-test-cycle.mjs",
    {
      TEST_DATABASE_URL: "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
      // The seed stores the canonical seller avatar as an absolute URL.
      // Playwright's `webServer.env` is not applied to global setup, so
      // propagate the configured browser origin into the database cycle
      // explicitly instead of falling back to localhost:3000.
      PUBLIC_FIXTURE_ORIGIN: WEB_URL,
      NODE_ENV: "test",
    },
  );

  console.log(`▶ Probing API health at ${API_HEALTH_URL}`);
  await waitForHttp(API_HEALTH_URL, 60_000);
  console.log(`▶ Probing web at ${WEB_URL}`);
  await waitForHttp(WEB_URL, 60_000);

  console.log("✅ Playwright global setup complete");
}
