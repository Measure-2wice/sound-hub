// This destructive acceptance test has its own Playwright project, which
// depends on the ordinary Chromium project. It therefore runs only after all
// non-destructive browser tests have completed. Restarting PostgreSQL restores
// the disposable service for later commands, but the test does not assume the
// already-running API process can recover its existing Prisma connection pool.

import { execSync } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, type Page } from "@playwright/test";

const DOCKER_COMPOSE_FILE = `${process.cwd()}/../../docker-compose.test.yml`;
const TEST_DB_HOST = "localhost";
const TEST_DB_PORT = 5433;

async function loadHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Find Caribbean talent" })).toBeVisible();
}

function runDockerCompose(args: string): void {
  execSync(`docker compose -f ${DOCKER_COMPOSE_FILE} ${args}`, {
    cwd: `${process.cwd()}/../..`,
    stdio: "pipe",
    timeout: 30_000,
  });
}

async function waitForTcpState(
  desiredAvailable: boolean,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: TEST_DB_HOST, port: TEST_DB_PORT }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", (err) => {
        socket.destroy();
        lastError = err;
        resolve(false);
      });
      socket.setTimeout(1_000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable === desiredAvailable) return;
    await sleep(pollIntervalMs);
  }
  const direction = desiredAvailable ? "accept" : "stop accepting";
  throw new Error(
    `Test database at ${TEST_DB_HOST}:${TEST_DB_PORT} did not ${direction} TCP within ${timeoutMs}ms (last error: ${String(
      lastError,
    )})`,
  );
}

async function restoreTestDatabase(): Promise<void> {
  try {
    runDockerCompose("start postgres_test");
  } catch {
    runDockerCompose("up -d postgres_test");
  }
  await waitForTcpState(true, 60_000, 500);
}

test.describe.serial("M1.6: real PostgreSQL unavailability through Express and the proxy", () => {
  test.afterAll(async () => {
    await restoreTestDatabase();
  });

  test("stops PostgreSQL, drives a search through the proxy + Express + real Prisma, and renders SEARCH_UNAVAILABLE with a retry affordance", async ({
    page,
    request,
  }) => {
    const sanity = await request.get(
      `${process.env.API_URL ?? "http://localhost:4000"}/api/health`,
    );
    expect(sanity.status()).toBe(200);

    try {
      runDockerCompose("stop postgres_test");
      await waitForTcpState(false, 15_000, 250);

      await loadHome(page);
      const query = "Haitian dancehall single production";
      await page.getByTestId("search-input").fill(query);
      await page.getByTestId("search-submit").click();

      const errorCard = page.getByTestId("search-error");
      await expect(errorCard).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("search-error-message")).toContainText(
        /temporarily unavailable/i,
      );
      const requestIdText = (
        (await page.getByTestId("search-error-request-id").textContent()) ?? ""
      ).trim();
      expect(requestIdText.length).toBeGreaterThan(0);

      await expect(page.getByTestId("search-retry")).toBeVisible();
      await expect(page.getByTestId("search-input")).toHaveValue(query);
      await expect(page.getByTestId("result-card")).toHaveCount(0);
      await expect(page.getByTestId("search-empty")).toHaveCount(0);
    } finally {
      await restoreTestDatabase();
    }
  });
});
