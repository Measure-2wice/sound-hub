// Fail-closed wrapper for `prisma migrate deploy` against the manual-QA
// database. Validates QA_DATABASE_URL against the approved QA target,
// then spawns Prisma with that exact URL as DATABASE_URL.
//
// The QA database is the manual-QA target the dev API server reads
// when started via `pnpm dev:qa`. Destructive repository tests must
// NEVER target this database — see apps/api/src/lib/test-database.ts
// for the same-DB-name guard that enforces the separation.

import { spawn } from "node:child_process";
import { resolveApprovedQaDatabaseUrl, packagesDbDir } from "./db-qa-env.mjs";

let target;
try {
  target = resolveApprovedQaDatabaseUrl();
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const { url, host, port, database } = target;

async function main() {
  console.log(`▶ Applying migrations to approved QA target ${host}:${port}/${database}`);
  await new Promise((resolve, reject) => {
    const child = spawn("npx", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
      cwd: packagesDbDir,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: url,
        QA_DATABASE_URL: url,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited with code ${code}`));
    });
  });
  console.log("✅ Migrations applied to QA database.");
}

main().catch((err) => {
  console.error("❌ db-qa-migrate failed:", err);
  process.exit(1);
});
