// Fail-closed wrapper for seeding the manual-QA database. Validates
// QA_DATABASE_URL against the approved QA target, then spawns the
// canonical seed with that exact URL as DATABASE_URL.
//
// Mirrors scripts/db-test-seed.mjs but targets the QA database.

import { spawn } from "node:child_process";
import { resolveApprovedQaDatabaseUrl, packagesDbDir, appsApiTsx } from "./db-qa-env.mjs";

let target;
try {
  target = resolveApprovedQaDatabaseUrl();
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const { url, host, port, database } = target;

async function main() {
  console.log(`▶ Seeding approved QA target ${host}:${port}/${database}`);
  await new Promise((resolve, reject) => {
    const child = spawn(appsApiTsx, ["prisma/seed.ts"], {
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
      else reject(new Error(`seed exited with code ${code}`));
    });
  });
  console.log("✅ Seed complete on QA database.");
}

main().catch((err) => {
  console.error("❌ db-qa-seed failed:", err);
  process.exit(1);
});
