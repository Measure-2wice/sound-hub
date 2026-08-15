import { defineConfig, devices } from "@playwright/test";

// The Playwright happy-path tracer spins up the real Next.js dev server, the
// real Express API, and the disposable soundhub_m1_test PostgreSQL service.
// By default it must not mock fetch, the API, the repository, or the database:
// every request is supposed to traverse the real proxy, the real Express
// route, and the real Prisma client so regressions in the production
// transport path are observable.
//
// Two narrowly-scoped exceptions to that rule exist and are intentional:
//
//   1. Fault-injection mocks are permitted to inject a specific error
//      response shape (for example the safe SEARCH_UNAVAILABLE 503 envelope)
//      when the assertion under test is the buyer-facing UI affordance —
//      a retry button, a preserved brief, an error card. The real
//      PostgreSQL outage path is covered by a separate fully-unmocked
//      test that stops the disposable container and drives the proxy,
//      Express, and Prisma client end to end. The fault-injection mocks
//      must always `route.fallback()` for any request they do not
//      specifically intercept, so the real proxy and API still receive
//      every other request unchanged.
//
//   2. Time/ordering-control mocks are permitted to hold specific
//      responses pending so deterministic ordering assertions
//      (older in-flight response cannot overwrite newer submission)
//      can be observed. Without response-time control the real
//      request path resolves too fast to distinguish older from newer
//      completions. These mocks must always `route.fallback()` for any
//      request outside the order they explicitly intend to delay.
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
      // The deterministic seed stores the canonical non-null avatar
      // fixture as an absolute URL composed from PUBLIC_FIXTURE_ORIGIN.
      // Match the origin the browser will actually request from so the
      // seeded URL resolves end to end (contract requires `z.string().url()`).
      PUBLIC_FIXTURE_ORIGIN: BASE_URL,
      PORT_WEB: String(PORT_WEB),
    },
  },
  metadata: {
    expectedSellerName: "Marc-André Pierre",
    expectedOfferingTitle: "Haitian dancehall single production — remote",
  },
});
