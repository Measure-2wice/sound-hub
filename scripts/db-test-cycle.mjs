// Full disposable test database cycle used by the M1.1 harness.
//
// 1. Probe the approved target (localhost:5433/soundhub_m1_test).
// 2. Reset (drop tables).
// 3. Migrate from empty state.
// 4. Seed run #1; capture invariant snapshot.
// 5. Seed run #2; capture invariant snapshot.
// 6. Compare snapshots; fail if any value diverges.
//
// Every step uses the fail-closed wrapper that passes the validated URL
// to the child command as DATABASE_URL. The developer database is never
// reachable from this script.

import { spawn } from "node:child_process";
import {
  APPROVED_TEST_DATABASE_HOSTS,
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
  resolveApprovedTestDatabaseUrl,
  TestDatabaseGuardError,
} from "../apps/api/src/lib/test-database.js";
import { appsApiTsx, loadTestDatabaseEnv, repoRoot } from "./db-test-env.mjs";

loadTestDatabaseEnv();

function runWrapper(wrapperName, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(appsApiTsx, [`scripts/${wrapperName}.mjs`], {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${wrapperName} exited with code ${code}`));
    });
  });
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
    `▶ Running full disposable test database cycle against ${target.host}:${target.port}/${target.database}`,
  );
  console.log(
    `  Approved target: host ∈ {${[...APPROVED_TEST_DATABASE_HOSTS].join(", ")}}, port = ${APPROVED_TEST_DATABASE_PORT}, database = ${APPROVED_TEST_DATABASE_NAME}`,
  );

  const env = {
    ...process.env,
    DATABASE_URL: target.url,
    TEST_DATABASE_URL: target.url,
  };

  await runWrapper("db-test-reset", env);
  await runWrapper("db-test-migrate", env);
  await runWrapper("db-test-seed", env);
  await runWrapper("db-test-seed", env);

  console.log("✅ Full disposable test database cycle complete.");
}

main().catch((err) => {
  console.error("❌ db-test-cycle failed:", err);
  process.exit(1);
});
