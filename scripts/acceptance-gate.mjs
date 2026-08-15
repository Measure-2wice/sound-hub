// M1.7 acceptance gate orchestrator.
//
// Runs every quality, privacy, determinism, lifecycle, and
// stale-request assertion that the M1.7 acceptance criteria
// require, in dependency order. Stops on the first failure so
// the surface area of any regression is obvious.
//
// Steps:
//   1. forbidden-dependency check (fail-closed; catches AI,
//      vector, Redis, storage, wallet, and blockchain references
//      in package.json, the lockfile, and TypeScript source).
//   2. full disposable test database cycle (clean → migrate →
//      seed twice → snapshot equality) — AC#1.
//   3. format check, lint, type-check, full test suite, build,
//      Playwright browser suite (stale-request + concurrency +
//      outage), and runtime smoke — AC#2, AC#3, AC#4.
//
// AC#5 (no external credentials) is enforced fail-closed by step
// 1 before any other step runs.
//
// AC#4 (privacy, deterministic ordering, strict validation,
// lifecycle eligibility, and stale-request assertions) is
// covered by:
//   - the unit/integration test suite run in step 6 (privacy,
//     deterministic ordering, strict validation, lifecycle
//     eligibility via API contract + service + repository tests
//     and the web-side `useSearch` stale-response unit tests);
//   - the Playwright browser suite run in step 8 (browser-side
//     stale-request and concurrency assertions, plus the real
//     PostgreSQL outage path through the proxy).
// None of those tests require external credentials; step 1
// enforces that no forbidden dependency ever reaches this gate.
//
// The gate is intentionally a thin wrapper around the existing
// scripts (db-test-cycle, pnpm check, pnpm test:e2e,
// runtime-smoke) so every step can also be run individually
// during development.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The workspace keeps `tsx` in `apps/api/node_modules/.bin/tsx` (it
// is a dev dependency of `@soundhub/api`). Resolve the absolute
// path so the gate can spawn child scripts via `tsx` from the repo
// root without relying on a PATH lookup that varies between shells.
const TSX_BIN = join(REPO_ROOT, "apps", "api", "node_modules", ".bin", "tsx");
if (!existsSync(TSX_BIN)) {
  console.error(
    `❌ Expected tsx at ${TSX_BIN}; run \`pnpm install\` before invoking the acceptance gate.`,
  );
  process.exit(1);
}

const STEPS = [
  {
    label: "forbidden-dependency check",
    // Direct Node invocation keeps the gate self-contained.
    command: process.execPath,
    args: ["scripts/check-forbidden-deps.mjs"],
    cwd: REPO_ROOT,
    env: {},
  },
  {
    label: "disposable test database cycle (clean → migrate → seed twice)",
    // The cycle script validates the disposable target itself;
    // pass through any TEST_DATABASE_URL the operator already
    // exported so the gate honors the documented convention.
    command: TSX_BIN,
    args: ["scripts/db-test-cycle.mjs"],
    cwd: REPO_ROOT,
    env: {},
  },
  {
    label: "format check (Prettier)",
    command: "pnpm",
    args: ["format:check"],
    cwd: REPO_ROOT,
    env: {},
  },
  {
    label: "lint (ESLint flat config)",
    command: "pnpm",
    args: ["lint"],
    cwd: REPO_ROOT,
    env: {},
  },
  {
    label: "type-check (TypeScript across the workspace)",
    command: "pnpm",
    args: ["type-check"],
    cwd: REPO_ROOT,
    env: {},
  },
  {
    label: "tests (API service + route + repository + web unit)",
    // The workspace test script composes API, web, and repository
    // tests so step 6 covers privacy, deterministic ordering,
    // strict validation, and lifecycle eligibility assertions.
    command: "pnpm",
    args: ["test"],
    cwd: REPO_ROOT,
    env: {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
    },
  },
  {
    label: "build (Next.js + Express + Prisma)",
    command: "pnpm",
    args: ["build"],
    cwd: REPO_ROOT,
    env: {},
  },
  {
    label: "Playwright browser suite (stale-request + concurrency + outage through the proxy)",
    // P1-003 (Codex review) flagged that the cited browser
    // stale-request and concurrency assertions live in the
    // Playwright suite and were not executed by the gate. Step 8
    // invokes `pnpm test:e2e`, which boots its own API + web
    // via Playwright's `webServer` config and tears them down on
    // exit. The disposable PostgreSQL on port 5433 must be
    // reachable; the global-setup script runs the full
    // `pnpm db:test:cycle` before the browser tests start so the
    // suite operates against a clean canonical state. The
    // chromium-outage project stops and restarts the disposable
    // PostgreSQL container during the outage test; the
    // `test.afterAll` hook restores the container so subsequent
    // steps in the gate still find it reachable.
    command: "pnpm",
    args: ["test:e2e"],
    cwd: REPO_ROOT,
    env: {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
    },
  },
  {
    label: "runtime smoke through the Next.js proxy (successful, invalid, empty, unavailable)",
    // The runtime-smoke script boots its own API + web instances
    // (a real one and a failing one whose DATABASE_URL points at
    // an unreachable port) and tears them down on exit. The
    // successful, invalid, empty, and unavailable cases all drive
    // through the browser proxy so the four-case claim is
    // literally exercised (P1-002 Codex remediation).
    command: TSX_BIN,
    args: ["scripts/runtime-smoke.mjs"],
    cwd: REPO_ROOT,
    env: {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://soundhub:password@localhost:5433/soundhub_m1_test",
      PUBLIC_FIXTURE_ORIGIN: process.env.PUBLIC_FIXTURE_ORIGIN ?? "http://127.0.0.1:3000",
    },
  },
];

function runStep(step) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(step.command, step.args, {
      stdio: "inherit",
      cwd: step.cwd ?? REPO_ROOT,
      env: { ...process.env, ...step.env },
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${step.label} exited with code ${code}`));
      }
    });
  });
}

async function main() {
  console.log("▶ M1.7 acceptance gate");
  console.log(
    "  Five acceptance criteria: (1) clean DB + seed twice, (2) runtime smoke through the proxy, " +
      "(3) type-check/lint/tests/build/format, (4) privacy/deterministic/strict/lifecycle/stale, " +
      "(5) no external credentials/dependencies.",
  );
  const started = Date.now();
  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];
    const stepStart = Date.now();
    console.log(`\n[${i + 1}/${STEPS.length}] ${step.label}`);
    try {
      await runStep(step);
      const elapsedMs = Date.now() - stepStart;
      console.log(`  ✓ Step ${i + 1} passed in ${(elapsedMs / 1000).toFixed(1)}s`);
    } catch (err) {
      console.error(`\n❌ Acceptance gate FAILED at step ${i + 1}: ${err.message}`);
      process.exit(1);
    }
  }
  const totalElapsed = Date.now() - started;
  console.log(
    `\n✅ M1.7 acceptance gate PASSED in ${(totalElapsed / 1000).toFixed(1)}s. READY FOR CODEX REVIEW.`,
  );
}

main().catch((err) => {
  console.error("❌ Acceptance gate errored:", err);
  process.exit(1);
});
