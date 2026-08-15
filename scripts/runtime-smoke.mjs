// M1.7 runtime smoke through the Next.js proxy.
//
// Boots the real Express API and the real Next.js dev server against the
// disposable test PostgreSQL. Drives four canonical cases through the
// browser proxy (`/api/search`) and asserts each response:
//
//   1. successful — a canonical search returns 200, a seller result, and
//      the expected strategy;
//   2. invalid — a malformed required payload returns 400 and the safe
//      INVALID_SEARCH_CRITERIA envelope;
//   3. empty — a non-matching query returns 200 with `results: []`;
//   4. unavailable — a second API instance pointed at an unreachable
//      PostgreSQL returns the safe SEARCH_UNAVAILABLE 503 envelope.
//
// The script is the lightweight runtime-smoke companion to the heavy
// Playwright browser tracers; it exercises the same proxy, the same
// Express route, the same TalentSearchService, and the same Prisma
// adapter end to end without requiring a Chromium driver.
//
// Lifecycle:
//   1. Resolve the approved disposable test target via the
//      `resolveApprovedTestDatabaseUrl` guard.
//   2. Start two API instances: a "real" one pointed at the
//      disposable database, and a "failing" one pointed at an
//      unreachable port (covers case 4).
//   3. Start the Next.js dev server. It rewrites `/api/:path*` to
//      the REAL API instance only; the failing instance is reached
//      directly for case 4 so the proxy transport is the same as
//      the buyer-facing surface.
//   4. Drive the four cases; print a single line per case; exit
//      non-zero if any assertion fails.
//   5. Tear down all child processes so the gate can run repeatedly.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveApprovedTestDatabaseUrl } from "../apps/api/src/lib/test-database.js";
import { loadTestDatabaseEnv, repoRoot } from "./db-test-env.mjs";

// The disposable test target may live in `.env.test` instead of the
// current process environment. Load it explicitly so this script can
// run from the gate (which already sets it) and from the developer
// shell (which may rely on `.env.test`).
loadTestDatabaseEnv();

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://soundhub:password@localhost:5433/soundhub_m1_test";

const API_PORT = Number(process.env.PORT_API ?? 4000);
const FAILING_API_PORT = API_PORT + 1;
const WEB_PORT = Number(process.env.PORT_WEB ?? 3000);

const API_URL = `http://127.0.0.1:${API_PORT}`;
const FAILING_API_URL = `http://127.0.0.1:${FAILING_API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

let apiProcess = null;
let failingApiProcess = null;
let webProcess = null;
let shuttingDown = false;

function startChild(label, command, args, env, cwd) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    cwd,
  });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${label}:stdout] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${label}:stderr] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `❌ [${label}] exited prematurely with code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    process.exitCode = 1;
    void shutdown();
  });
  return child;
}

async function waitForHttp(url, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch {
      // Connection refused / not ready yet.
    }
    await sleep(250);
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms`);
}

async function shutdown() {
  shuttingDown = true;
  for (const child of [apiProcess, failingApiProcess, webProcess]) {
    if (!child) continue;
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
  // Give processes a moment to flush, then SIGKILL any survivors.
  await sleep(500);
  for (const child of [apiProcess, failingApiProcess, webProcess]) {
    if (!child) continue;
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

async function runCase(label, fn) {
  console.log(`▶ ${label}`);
  try {
    await fn();
    console.log(`✅ ${label}`);
  } catch (err) {
    console.error(`❌ ${label}: ${err.message}`);
    process.exitCode = 1;
    throw err;
  }
}

async function main() {
  // Validate the disposable test target so the script fails closed
  // before any child process is launched.
  const target = resolveApprovedTestDatabaseUrl();
  console.log(
    `▶ Approved disposable test target: ${target.host}:${target.port}/${target.database}`,
  );

  // Case 4 uses an unreachable PostgreSQL URL so we exercise the
  // real SEARCH_UNAVAILABLE envelope without disturbing the
  // disposable service the successful case relies on.
  const failingDatabaseUrl = `postgresql://soundhub:invalid@127.0.0.1:1/soundhub_m1_test?connect_timeout=2`;

  apiProcess = startChild(
    "api",
    "node",
    ["--import", "tsx", "src/server.ts"],
    {
      PORT: String(API_PORT),
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
      NODE_ENV: "test",
      API_URL: WEB_URL,
      FRONTEND_URL: WEB_URL,
      PUBLIC_FIXTURE_ORIGIN: WEB_URL,
    },
    `${repoRoot}/apps/api`,
  );

  failingApiProcess = startChild(
    "failing-api",
    "node",
    ["--import", "tsx", "src/server.ts"],
    {
      PORT: String(FAILING_API_PORT),
      DATABASE_URL: failingDatabaseUrl,
      TEST_DATABASE_URL: failingDatabaseUrl,
      NODE_ENV: "test",
      API_URL: WEB_URL,
      FRONTEND_URL: WEB_URL,
      PUBLIC_FIXTURE_ORIGIN: WEB_URL,
    },
    `${repoRoot}/apps/api`,
  );

  webProcess = startChild(
    "web",
    "pnpm",
    ["--filter", "@soundhub/web", "dev"],
    {
      PORT_WEB: String(WEB_PORT),
      PORT_API: String(API_PORT),
      API_URL,
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
      NODE_ENV: "test",
      FRONTEND_URL: WEB_URL,
      PUBLIC_FIXTURE_ORIGIN: WEB_URL,
    },
    repoRoot,
  );

  // Wait for both API instances and the Next.js dev server to come up.
  await waitForHttp(`${API_URL}/api/health`, "real API", 30_000);
  await waitForHttp(`${FAILING_API_URL}/api/health`, "failing API", 30_000);
  await waitForHttp(WEB_URL, "Next.js dev server", 60_000);

  try {
    // Case 1 — successful search through the Next.js proxy.
    await runCase(
      "Case 1 (successful): canonical search returns 200 + a canonical result through the proxy",
      async () => {
        const response = await postJson(`${WEB_URL}/api/search`, {
          query: "Haitian dancehall single production",
        });
        if (response.status !== 200) {
          throw new Error(`expected 200, got ${response.status}`);
        }
        if (response.body.metadata?.strategy !== "postgres-text-v1") {
          throw new Error(
            `expected strategy postgres-text-v1, got ${JSON.stringify(response.body.metadata)}`,
          );
        }
        const top = response.body.results?.[0];
        if (!top || top.seller?.professionalName !== "Marc-André Pierre") {
          throw new Error(
            `expected first result to be Marc-André Pierre, got ${JSON.stringify(top)}`,
          );
        }
      },
    );

    // Case 2 — invalid request through the Next.js proxy returns
    // the safe INVALID_SEARCH_CRITERIA envelope.
    await runCase(
      "Case 2 (invalid): malformed required criteria returns 400 + INVALID_SEARCH_CRITERIA through the proxy",
      async () => {
        const response = await postJson(`${WEB_URL}/api/search`, {
          required: { basedIn: { countryCode: "12" } },
        });
        if (response.status !== 400) {
          throw new Error(`expected 400, got ${response.status}`);
        }
        if (response.body.error?.code !== "INVALID_SEARCH_CRITERIA") {
          throw new Error(
            `expected INVALID_SEARCH_CRITERIA, got ${JSON.stringify(response.body.error)}`,
          );
        }
        if (typeof response.body.error?.requestId !== "string") {
          throw new Error("expected the safe envelope to carry a requestId");
        }
      },
    );

    // Case 3 — non-matching query through the Next.js proxy returns
    // 200 with `results: []` (and no error envelope).
    await runCase(
      "Case 3 (empty): non-matching query returns 200 + results: [] through the proxy",
      async () => {
        const response = await postJson(`${WEB_URL}/api/search`, {
          query: "zzzzz-no-such-thing",
        });
        if (response.status !== 200) {
          throw new Error(`expected 200, got ${response.status}`);
        }
        if (!Array.isArray(response.body.results) || response.body.results.length !== 0) {
          throw new Error(`expected results: [], got ${JSON.stringify(response.body.results)}`);
        }
        if (response.body.error !== undefined) {
          throw new Error(
            `expected no error envelope on empty success, got ${JSON.stringify(response.body.error)}`,
          );
        }
      },
    );

    // Case 4 — failing API instance pointed at an unreachable
    // PostgreSQL returns the safe SEARCH_UNAVAILABLE envelope when
    // the buyer reaches it directly. We hit the FAILING_API_URL
    // (not the proxy) for this case because the proxy is wired to
    // the real API; the failing API's contract is identical to the
    // real one, so reaching it exercises the same Express route
    // and the same Prisma client. The proxy-vs-direct preservation
    // is asserted separately by `search-failures.spec.ts`.
    await runCase(
      "Case 4 (unavailable): unreachable PostgreSQL returns 503 + SEARCH_UNAVAILABLE through the failing API",
      async () => {
        const response = await postJson(`${FAILING_API_URL}/api/search`, {
          query: "Haitian dancehall single production",
        });
        if (response.status !== 503) {
          throw new Error(`expected 503, got ${response.status}`);
        }
        if (response.body.error?.code !== "SEARCH_UNAVAILABLE") {
          throw new Error(
            `expected SEARCH_UNAVAILABLE, got ${JSON.stringify(response.body.error)}`,
          );
        }
      },
    );
  } finally {
    await shutdown();
  }

  if (process.exitCode && process.exitCode !== 0) {
    console.error("❌ Runtime smoke FAILED.");
    process.exit(process.exitCode);
  }
  console.log(
    "✅ Runtime smoke PASSED: successful, invalid, empty, and unavailable cases all round-trip.",
  );
}

main().catch(async (err) => {
  console.error("❌ Runtime smoke errored:", err);
  await shutdown();
  process.exit(1);
});
