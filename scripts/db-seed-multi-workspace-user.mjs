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
import {
  resolveApprovedTestDatabaseUrl,
  TestDatabaseGuardError,
} from "../apps/api/src/lib/test-database.js";
import { appsApiTsx, packagesDbDir } from "./db-test-env.mjs";

const targetEmail = process.argv[2];
if (!targetEmail) {
  console.error("Usage: db-seed-multi-workspace-user.mjs <email>");
  process.exit(1);
}

async function main() {
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

  await new Promise((resolve, reject) => {
    const child = spawn(appsApiTsx, ["../test-helpers/multi-workspace-user.ts", targetEmail], {
      cwd: packagesDbDir,
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
