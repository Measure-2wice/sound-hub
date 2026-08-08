// Fail-closed wrapper for `prisma migrate deploy` against the disposable
// test database. Validates TEST_DATABASE_URL against the exact approved
// target, then spawns Prisma with that exact URL as DATABASE_URL.

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
    `▶ Applying migrations to approved disposable test target ${target.host}:${target.port}/${target.database}`,
  );

  await new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
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
      else reject(new Error(`prisma migrate deploy exited with code ${code}`));
    });
  });

  console.log("✅ Migrations applied.");
}

main().catch((err) => {
  console.error("❌ db-test-migrate failed:", err);
  process.exit(1);
});
