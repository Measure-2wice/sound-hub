// Block until the disposable test PostgreSQL on port 5433 accepts TCP
// connections. Avoids importing the `pg` package so this script has no
// workspace dependency to resolve.
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import { URL } from "node:url";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is not set");
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch (err) {
  console.error(`TEST_DATABASE_URL is not a valid URL: ${err.message}`);
  process.exit(1);
}

const host = parsed.hostname;
const port = Number(parsed.port || 5432);

const deadline = Date.now() + 60_000;
let attempt = 0;
while (Date.now() < deadline) {
  attempt += 1;
  const ok = await new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
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
    console.log(`✅ Disposable test database is ready on ${host}:${port} (attempt ${attempt})`);
    process.exit(0);
  }
  await sleep(1_000);
}

console.error(`❌ Disposable test database at ${host}:${port} did not become ready in 60s`);
process.exit(1);
