// Import-boundary regression guard for the auth-repository module.
//
// Background: M2 #82 review (P1-001) flagged that the repository
// adapter was importing `ConvergenceRaceError` and `ConvergenceKind`
// from the convergence service, while the service was importing the
// `AuthRepository` interface from the repository. This created a
// circular module seam and broke the approved architecture
// (auth service → convergence service → repository primitives).
//
// This test statically reads every `.ts` file under
// `apps/api/src/auth-repository/` and asserts that NONE of them
// import anything from `../services/`. The boundary is the contract:
// the auth-repository module owns persistence only; classification
// lives in the convergence service; both import domain types from
// `apps/api/src/lib/personal-workspace-convergence-domain.ts`.

/* eslint-disable @typescript-eslint/no-floating-promises */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const AUTH_REPOSITORY_DIR = join(import.meta.dirname, "..");
const SERVICES_DIR_NAME = "services";

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // Recurse into subdirectories (including __boundaries__).
      out.push(...listTypeScriptFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("auth-repository import boundaries", () => {
  test("no RUNTIME module under src/auth-repository/ imports from src/services/", () => {
    // Test files are the integration boundary — they may import
    // services to exercise the full auth-repository ↔ convergence
    // service stack. Only runtime modules are subject to the
    // import-boundary rule.
    const files = listTypeScriptFiles(AUTH_REPOSITORY_DIR).filter(
      (file) => !file.endsWith(".test.ts"),
    );
    assert.ok(files.length > 0, "expected at least one runtime .ts file in src/auth-repository/");

    const offenders: { readonly file: string; readonly line: string }[] = [];

    // A module under src/auth-repository/ can use a relative path
    // like `../services/...` to reach the services directory. We
    // also catch the absolute-from-cwd form via the `from` path
    // segment.
    const FORBIDDEN_PATTERNS: readonly RegExp[] = [
      /from\s+["']\.\.\/services\//,
      /from\s+["']\.\.\/\.\.\/services\//,
    ];

    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      const lines = contents.split("\n");
      lines.forEach((line, idx) => {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            offenders.push({
              file: file.replace(`${AUTH_REPOSITORY_DIR}/`, ""),
              line: `${idx + 1}: ${line.trim()}`,
            });
          }
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      `auth-repository runtime modules must not import from ${SERVICES_DIR_NAME}/\n` +
        offenders.map((o) => `  ${o.file}:${o.line}`).join("\n"),
    );
  });
});
