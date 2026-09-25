// Test-only wrapper: seed a recovery-bound UserAccount so the
// M2 #82 Playwright spec can exercise the recovery surface.
//
// A recovery-bound user has TWO Owner Personal Workspace
// memberships. The convergence service's
// classifyPersonalWorkspaceState then classifies this user as
// `recovery: multiple-personal-workspaces` on sign-in, which
// drives the browser to render the `RecoverySurface`.
//
// Usage: `node scripts/db-seed-recovery-user.mjs <email>`
//
// Fails closed if `TEST_DATABASE_URL` does not match the approved
// disposable target (re-uses the test-database guard from
// `apps/api/src/lib/test-database.js`).

import { spawn } from "node:child_process";
import {
  resolveApprovedTestDatabaseUrl,
  TestDatabaseGuardError,
} from "../apps/api/src/lib/test-database.js";
import { appsApiTsx, packagesDbDir } from "./db-test-env.mjs";

const targetEmail = process.argv[2];
if (!targetEmail) {
  console.error("Usage: db-seed-recovery-user.mjs <email>");
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
    `▶ Seeding recovery-bound user ${targetEmail} on ${target.host}:${target.port}/${target.database}`,
  );

  await new Promise((resolve, reject) => {
    const child = spawn(appsApiTsx, ["prisma/seed-recovery-user.ts", targetEmail], {
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
