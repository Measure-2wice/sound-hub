// Fail-closed wrapper for the M1.1 seed. Validates TEST_DATABASE_URL
// against the exact approved target, then spawns the seed with that
// exact URL as DATABASE_URL.

import { spawn } from "node:child_process";
import {
  resolveApprovedTestDatabaseUrl,
  TestDatabaseGuardError,
} from "../apps/api/src/lib/test-database.js";
import { loadTestDatabaseEnv, packagesDbDir } from "./db-test-env.mjs";

loadTestDatabaseEnv();

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
    `▶ Seeding approved disposable test target ${target.host}:${target.port}/${target.database}`,
  );

  await new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["tsx", "prisma/seed.ts"],
      {
        cwd: packagesDbDir,
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: target.url,
          TEST_DATABASE_URL: target.url,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`seed exited with code ${code}`));
    });
  });

  console.log("✅ Seed complete.");
}

main().catch((err) => {
  console.error("❌ db-test-seed failed:", err);
  process.exit(1);
});
