// Import-boundary regression guard for the @soundhub/db package.
//
// Background: Codex review (P2-001) flagged a `db → api → db` module
// cycle. The Milestone 2 recovery-user seed
// (`packages/db/prisma/seed-recovery-user.ts`) imported the
// disposable-target guard from `apps/api/src/lib/test-database.ts`,
// while that API module imported `createPrismaClient` from
// `@soundhub/db`. The cycle made the seed's URL guard a transitive
// dependency on the API module, defeating the documented package
// ownership (`packages/db` has no application-layer dependencies).
//
// Fix: the URL-only guard lives in `packages/db/src/test-database-url.ts`
// and is re-exported from `@soundhub/db`. The seed and its guard
// tests now import the guard from the sibling `test-database-url.js`
// module directly (the seed runs via tsx with the package's own
// project config, which doesn't carry the apps/api → @soundhub/db
// workspace types; relative sibling imports keep the boundary clear
// without depending on the cross-package type resolution path).
//
// This test statically reads every runtime `.ts` file under
// `packages/db/` (skipping test files, which are explicitly allowed
// to import the cycle for verification) and asserts that NONE of them
// import anything from `apps/api/`. The boundary is the contract: a
// future contributor who reintroduces the upward import path fails
// this test.
//
// Why no `describe` wrapper: the existing audio-sample-fixture.test.ts
// in this package uses bare `test()` calls (the package's tsconfig
// does not configure the node:test namespace merge the apps/api
// tsconfig enables). Matching that pattern keeps the boundary test
// consistent with the rest of the package.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const PACKAGES_DB_ROOT = join(import.meta.dirname, "..", "..");

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // Recurse into subdirectories (including `__boundaries__`,
      // `prisma/`, `src/generated/`).
      out.push(...listTypeScriptFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

test("no RUNTIME module under packages/db/ imports from apps/api/", () => {
  // Test files are explicitly allowed to import the cycle for
  // verification (the guard's own test imports from the sibling
  // `test-database-url.js` module — never from apps/api — but a
  // future cycle test could legitimately reach into apps/api to
  // prove the boundary). Only runtime modules are subject to the
  // boundary rule.
  const files = listTypeScriptFiles(PACKAGES_DB_ROOT).filter((file) => !file.endsWith(".test.ts"));
  assert.ok(files.length > 0, "expected at least one runtime .ts file under packages/db/");

  const offenders: { readonly file: string; readonly line: string }[] = [];

  // Match any `import ... from "..."` or dynamic `import("...")`
  // whose module specifier includes `apps/api/`. This catches
  // relative paths like `../../../apps/api/src/lib/test-database.js`,
  // absolute-from-cwd paths, and the monorepo-relative `apps/api/...`
  // form a contributor might use.
  const FORBIDDEN_PATTERNS: readonly RegExp[] = [
    /from\s+["'][^"']*apps\/api\//,
    /import\s*\(\s*["'][^"']*apps\/api\//,
  ];

  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    const lines = contents.split("\n");
    lines.forEach((line, idx) => {
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(line)) {
          offenders.push({
            file: file.replace(`${PACKAGES_DB_ROOT}/`, ""),
            line: `${idx + 1}: ${line.trim()}`,
          });
        }
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `packages/db runtime modules must not import from apps/api/.\n` +
      `The URL-only guard lives in @soundhub/db; do not reach into apps/api/.\n` +
      offenders.map((o) => `  ${o.file}:${o.line}`).join("\n"),
  );
});

test("the URL-only guard is reachable from @soundhub/db (regression pin)", () => {
  // Pin the public re-export so a future refactor cannot silently
  // move the guard back to apps/api/. The seed and its test rely
  // on these symbols being accessible from a packages/db-owned
  // module (the relative sibling import resolves to the same
  // module re-exported from `@soundhub/db`).
  const indexSource = readFileSync(join(PACKAGES_DB_ROOT, "src", "index.ts"), "utf8");
  for (const symbol of [
    "APPROVED_TEST_DATABASE_NAME",
    "APPROVED_TEST_DATABASE_PORT",
    "APPROVED_TEST_DATABASE_HOSTS",
    "TestDatabaseGuardError",
    "assertDisposableTestDatabase",
    "assertNotQaDatabase",
    "readTestDatabaseUrl",
    "resolveApprovedTestDatabaseUrl",
  ]) {
    assert.match(
      indexSource,
      new RegExp(`\\b${symbol}\\b`),
      `expected @soundhub/db's public surface to re-export ${symbol} from test-database-url`,
    );
  }
});
