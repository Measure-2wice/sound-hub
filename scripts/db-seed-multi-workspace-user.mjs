// Test-only wrapper: seed a multi-Workspace user so the M2 #83
// Playwright spec can exercise the cross-Workspace switch
// interstitial.
//
// A multi-Workspace user has ONE Personal Workspace + ONE
// Organization Workspace + Owner memberships on BOTH. The
// Personal Workspace is the convergence pointer, so sign-in
// classifies the user as `converged` against the Personal
// Workspace. A deep-link to the Organization Workspace is then
// "different from the current acting Workspace" and triggers
// the switch interstitial.
//
// Usage: `node scripts/db-seed-multi-workspace-user.mjs <email>`
//
// Fails closed if `TEST_DATABASE_URL` does not match the approved
// disposable target (re-uses the test-database guard from
// `apps/api/src/lib/test-database.js`).
//
// The fixture is test-only — it stages an Organization
// membership directly against Prisma. The product flow never
// creates Organization membership without an invitation
// pathway, and #83 does NOT add such a pathway.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveApprovedTestDatabaseUrl,
  TestDatabaseGuardError,
} from "../apps/api/src/lib/test-database.js";
import { appsApiTsx } from "./db-test-env.mjs";

// The helper lives at `apps/api/src/test-helpers/multi-workspace-user.ts`.
// The previous version spawned `"../test-helpers/multi-workspace-user.ts"`
// with `cwd: packagesDbDir`, which resolved to a nonexistent
// `<repo>/packages/test-helpers/` path. Resolve an ABSOLUTE path
// relative to THIS script (`import.meta.url`) so the spawn target is
// always found regardless of the cwd of the wrapper. Exported so the
// focused unit test can assert the resolution contract.
export function resolveMultiWorkspaceHelperPath() {
  return fileURLToPath(
    new URL("../apps/api/src/test-helpers/multi-workspace-user.ts", import.meta.url),
  );
}

// Only run the seed wrapper's main() when this file is invoked
// directly, not when it is imported by the regression-test suite
// (`scripts/db-seed-multi-workspace-user.test.mjs`). The same guard
// pattern as `scripts/check-forbidden-deps.mjs`.
const isDirectInvocation = (() => {
  if (typeof process === "undefined") return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("/db-seed-multi-workspace-user.mjs");
})();

async function main() {
  const targetEmail = process.argv[2];
  if (!targetEmail) {
    console.error("Usage: db-seed-multi-workspace-user.mjs <email>");
    process.exit(1);
  }

  let target;
  try {
    target = resolveApprovedTestDatabaseUrl();
  } catch (err) {
    if (err instanceof TestDatabaseGuardError) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  console.log(
    `▶ Seeding multi-workspace user ${targetEmail} on ${target.host}:${target.port}/${target.database}`,
  );

  const helperPath = resolveMultiWorkspaceHelperPath();
  await new Promise((resolve, reject) => {
    const child = spawn(appsApiTsx, [helperPath, targetEmail], {
      env: { ...process.env, TEST_DATABASE_URL: target.url },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed helper exited with code ${code}`));
    });
  });
}

if (isDirectInvocation) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
