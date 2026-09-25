// Focused verification of the multi-workspace seed wrapper.
//
// The wrapper spawns `apps/api/src/test-helpers/multi-workspace-user.ts`
// via `tsx`. A previous version spawned
// `"../test-helpers/multi-workspace-user.ts"` with `cwd: packagesDbDir`
// (`<repo>/packages/db/`), which resolved to a nonexistent
// `<repo>/packages/test-helpers/` directory.
//
// These tests pin the fix at the source level (same pattern as
// `apps/web/src/app/components/SessionProvider.test.tsx`): the
// wrapper MUST derive the helper path via `fileURLToPath(new URL(...,
// import.meta.url))` from THIS script (NOT from `packagesDbDir`), the
// resolved path MUST exist as a real file with the canonical
// `seedMultiWorkspaceUser` export, and the wrapper MUST NOT spawn
// with `cwd: packagesDbDir` (which was the root cause of the broken
// resolution).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wrapperSource = readFileSync(
  fileURLToPath(new URL("./db-seed-multi-workspace-user.mjs", import.meta.url)),
  "utf8",
);
const helperPath = fileURLToPath(
  new URL("../apps/api/src/test-helpers/multi-workspace-user.ts", import.meta.url),
);

describe("db-seed-multi-workspace-user.mjs — helper path resolution", () => {
  test("wrapper computes the helper path via import.meta.url (NOT via packagesDbDir)", () => {
    // The fix: derive the helper path relative to THIS script
    // (`import.meta.url`) so it resolves to the canonical
    // `apps/api/src/test-helpers/multi-workspace-user.ts` location
    // regardless of cwd. The previous broken form was
    // `spawn(appsApiTsx, ["../test-helpers/multi-workspace-user.ts",
    // targetEmail], { cwd: packagesDbDir, ... })`.
    assert.match(
      wrapperSource,
      /new\s+URL\(\s*["']\.\.\/apps\/api\/src\/test-helpers\/multi-workspace-user\.ts["']\s*,\s*import\.meta\.url\s*\)/,
      "wrapper MUST resolve the helper via `new URL('../apps/api/src/test-helpers/multi-workspace-user.ts', import.meta.url)` so the path is anchored to this script, not to packagesDbDir",
    );
    assert.match(
      wrapperSource,
      /fileURLToPath\(/,
      "wrapper MUST call fileURLToPath on the URL so spawn receives an absolute path",
    );
  });

  test("wrapper no longer spawns with cwd: packagesDbDir (the root-cause of the broken resolution)", () => {
    // The previous wrapper passed `cwd: packagesDbDir`, which combined
    // with the relative path `"../test-helpers/multi-workspace-user.ts"`
    // produced `<repo>/packages/test-helpers/multi-workspace-user.ts` —
    // a directory that does not exist. Pin that this option is gone.
    // Strip line comments before regex matching so the rationale block
    // above this test does not match.
    const codeOnly = wrapperSource
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    assert.equal(
      /cwd:\s*packagesDbDir\b/.test(codeOnly),
      false,
      "wrapper MUST NOT spawn with `cwd: packagesDbDir` (was the root cause of the broken helper resolution)",
    );
    // Belt-and-braces: pin the relative path that used to fail is no
    // longer a bare string arg to spawn.
    assert.equal(
      /spawn\(\s*appsApiTsx\s*,\s*\[\s*["']\.\.\/test-helpers\//.test(codeOnly),
      false,
      "wrapper MUST NOT pass `'../test-helpers/...'` as a relative spawn arg (was the second half of the broken resolution)",
    );
  });

  test("the resolved helper path points at the canonical file on disk", () => {
    assert.ok(
      helperPath.endsWith("/apps/api/src/test-helpers/multi-workspace-user.ts"),
      `helper path MUST end with /apps/api/src/test-helpers/multi-workspace-user.ts; got ${helperPath}`,
    );
    assert.ok(existsSync(helperPath), `helper file MUST exist on disk: ${helperPath}`);
    assert.ok(statSync(helperPath).isFile(), `helper path MUST be a regular file: ${helperPath}`);
  });

  test("the helper file exports the canonical seed entry point", () => {
    const source = readFileSync(helperPath, "utf8");
    assert.ok(
      /export\s+async\s+function\s+seedMultiWorkspaceUser\b/.test(source),
      "the helper MUST export seedMultiWorkspaceUser so it can be invoked from Playwright fixtures",
    );
    assert.ok(
      /assertDisposableTestDatabase\(/.test(source),
      "the helper MUST call assertDisposableTestDatabase so it cannot write to a non-disposable database",
    );
    assert.ok(
      /readTestDatabaseUrl\(/.test(source),
      "the helper MUST read TEST_DATABASE_URL through the canonical reader so the wrapper's env forwarding reaches it",
    );
  });

  test("the helper path is NOT the broken packages/test-helpers/ location the previous wrapper produced", () => {
    // The previous version spawned `"../test-helpers/multi-workspace-user.ts"`
    // with `cwd: packagesDbDir` = `<repo>/packages/db/`, which resolved
    // to `<repo>/packages/test-helpers/multi-workspace-user.ts` —
    // a directory that does not exist.
    assert.ok(
      !helperPath.includes("/packages/test-helpers/"),
      `helper path MUST NOT be the broken /packages/test-helpers/ location; got ${helperPath}`,
    );
    assert.ok(
      !helperPath.includes("/packages/db/"),
      `helper path MUST NOT live under packages/db/; got ${helperPath}`,
    );
  });
});
