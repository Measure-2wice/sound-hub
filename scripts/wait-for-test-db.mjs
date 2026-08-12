// Block until the disposable test PostgreSQL on port 5433 accepts TCP
// connections. Avoids importing the `pg` package so this script has no
// workspace dependency to resolve. Loads TEST_DATABASE_URL from the
// repo's .env.test if it is not already set.
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import {
  APPROVED_TEST_DATABASE_NAME,
  APPROVED_TEST_DATABASE_PORT,
  resolveApprovedTestDatabaseUrl,
  TestDatabaseGuardError,
} from "../apps/api/src/lib/test-database.js";
import { loadTestDatabaseEnv } from "./db-test-env.mjs";

loadTestDatabaseEnv();

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

if (
  target.port !== APPROVED_TEST_DATABASE_PORT ||
  target.database !== APPROVED_TEST_DATABASE_NAME
) {
  console.error(
    `❌ Refusing to wait: target ${target.host}:${target.port}/${target.database} is not the approved disposable test target.`,
  );
  process.exit(1);
}

const deadline = Date.now() + 60_000;
let attempt = 0;
while (Date.now() < deadline) {
  attempt += 1;
  const ok = await new Promise((resolve) => {
    const socket = net.createConnection({ host: target.host, port: target.port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (ok) {
    console.log(
      `✅ Disposable test database is ready on ${target.host}:${target.port} (attempt ${attempt})`,
    );
    process.exit(0);
  }
  await sleep(1_000);
}
console.error(
  `❌ Disposable test database at ${target.host}:${target.port} did not become ready in 60s`,
);
process.exit(1);
