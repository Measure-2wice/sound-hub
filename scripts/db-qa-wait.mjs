// Block until the QA PostgreSQL on port 5433 accepts TCP connections.
//
// Mirrors scripts/wait-for-test-db.mjs but targets the QA database
// so the QA migrate / seed / dev-server commands never run against a
// Postgres container whose initdb hook has not yet provisioned the
// database. We probe TCP only — the official `postgres` image
// accepts TCP connections before the entrypoint hook completes
// (which would race a Prisma migrate call against a still-loading
// init script). The migrate/seed wrappers re-validate the database
// name against the approved QA target before any DDL runs.
//
// Avoiding a `pg` import keeps this script dependency-free.

import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import { resolveApprovedQaDatabaseUrl } from "./db-qa-env.mjs";

let target;
try {
  target = resolveApprovedQaDatabaseUrl();
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const { host, port, database } = target;

async function tcpReady() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onError = () => {
      socket.destroy();
      resolve(false);
    };
    socket.setTimeout(1500);
    socket.once("error", onError);
    socket.once("timeout", onError);
    socket.connect(port, host, () => {
      socket.end();
      resolve(true);
    });
  });
}

async function main() {
  const deadline = Date.now() + 60_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    if (await tcpReady()) {
      console.log(`✅ QA database TCP ready at ${host}:${port}/${database} (attempt ${attempt})`);
      return;
    }
    await sleep(1000);
  }
  console.error(
    `❌ QA database ${host}:${port}/${database} did not become reachable within 60s. ` +
      `Confirm \`pnpm db:test:up\` has finished and the initdb hook created the database.`,
  );
  process.exit(1);
}

main();
