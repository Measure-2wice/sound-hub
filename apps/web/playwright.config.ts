import { defineConfig, devices } from "@playwright/test";

// The Playwright happy-path tracer spins up the real Next.js dev server, the
// real Express API, and the disposable soundhub_m1_test PostgreSQL service.
// It must not mock fetch, the API, the repository, or the database.
//
// The setup script (e2e/global-setup.ts) ensures the test database is
// migrated and seeded before the test session begins, then waits for the
// API and the web to be ready. The webServer command runs both the API and
// the web through `concurrently` (matching `pnpm dev`) and exits cleanly
// when the test session ends.

const PORT_WEB = Number(process.env.PORT_WEB ?? 3000);
const PORT_API = Number(process.env.PORT_API ?? 4000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT_WEB}`;
const API_URL = process.env.API_URL ?? `http://localhost:${PORT_API}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm dev`,
    cwd: "../..",
    port: PORT_WEB,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT_API),
      API_URL,
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
      NODE_ENV: "test",
      FRONTEND_URL: BASE_URL,
      PORT_WEB: String(PORT_WEB),
    },
  },
  metadata: {
    expectedSellerName: "Marc-André Pierre",
    expectedOfferingTitle: "Haitian dancehall single production — remote",
  },
});
