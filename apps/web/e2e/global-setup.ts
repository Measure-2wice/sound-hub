// Global setup for the Playwright happy-path tracer.
//
// 1. Verify the disposable test database is reachable.
// 2. Apply the reviewed migration to the disposable database (no-op if
//    already applied).
// 3. Apply the deterministic seed (no-op if already applied).
// 4. Wait until both the API (port 4000) and the web (port 3000) respond.
//
// The webServer (Next.js + Express via `pnpm dev`) is started by Playwright
// and outlives the globalSetup, so we only need to wait for it to be ready.

import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://soundhub:password@localhost:5433/soundhub_m1_test";
const API_PORT = Number(process.env.PORT_API ?? process.env.PORT ?? 4000);
const WEB_PORT = Number(process.env.PORT_WEB ?? 3000);
const API_HEALTH_URL = process.env.API_URL ?? `http://localhost:${API_PORT}/api/health`;
const WEB_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeTcp(host, port, 2000)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for TCP ${host}:${port}`);
}

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
    env: { ...process.env, ...env },
  });
}

export default async function globalSetup(): Promise<void> {
  const dbUrl = new URL(TEST_DATABASE_URL);
  const dbHost = dbUrl.hostname;
  const dbPort = Number(dbUrl.port || 5432);
  console.log(`▶ Probing disposable test database at ${dbHost}:${dbPort}`);
  await waitForTcp(dbHost, dbPort, 60_000);

  runStep("Applying migration", "pnpm --filter @soundhub/db db:migrate:deploy", {
    DATABASE_URL: TEST_DATABASE_URL,
    NODE_ENV: "test",
  });
  runStep("Applying deterministic seed (idempotent)", "pnpm --filter @soundhub/db db:seed", {
    DATABASE_URL: TEST_DATABASE_URL,
    NODE_ENV: "test",
  });

  console.log(`▶ Probing API health at ${API_HEALTH_URL}`);
  await waitForHttp(API_HEALTH_URL, 60_000);
  console.log(`▶ Probing web at ${WEB_URL}`);
  await waitForHttp(WEB_URL, 60_000);

  console.log("✅ Playwright global setup complete");
}
