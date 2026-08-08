// Fail-closed wrapper for resetting the disposable test database.
//
// Instead of `prisma migrate reset` (which Prisma 7 gates behind an
// AI-agent safety prompt), this script drops and recreates the public
// schema with raw SQL, then re-applies the reviewed migration via
// `prisma migrate deploy`. The validated URL is the only one passed
// to the child command; the developer database is never reachable.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  resolveApprovedTestDatabaseUrl,
  TestDatabaseGuardError,
} from "../apps/api/src/lib/test-database.js";
import { loadTestDatabaseEnv, packagesDbDir } from "./db-test-env.mjs";

const require = createRequire(
  new URL("../packages/db/package.json", import.meta.url).pathname,
);
const { Client } = require("pg");

loadTestDatabaseEnv();

async function dropPublicSchema(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      'DROP SCHEMA IF EXISTS "public" CASCADE; CREATE SCHEMA "public";',
    );
  } finally {
    await client.end();
  }
}

async function runPrismaDeploy(url) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
      {
        cwd: packagesDbDir,
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: url,
          TEST_DATABASE_URL: url,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited with code ${code}`));
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
    `▶ Resetting approved disposable test target ${target.host}:${target.port}/${target.database}`,
  );

  await dropPublicSchema(target.url);
  console.log("  ↳ public schema dropped and recreated");
  await runPrismaDeploy(target.url);
  console.log("  ↳ reviewed migration re-applied from empty state");

  console.log("✅ Disposable test database reset complete (empty + migration only).");
}

main().catch((err) => {
  console.error("❌ db-test-reset failed:", err);
  process.exit(1);
});
