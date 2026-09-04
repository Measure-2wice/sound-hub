// Regression coverage for `scripts/check-forbidden-deps.mjs`.
//
// P1-001 (Codex review) flagged that the previous lockfile matcher
// assumed a leading-slash key format that pnpm v9 dropped. Without
// fixture-based regression coverage, the green gate step did not
// prove that forbidden resolved or transitive packages were
// actually absent. This suite pins the v9 matcher (and the package
// + source scanners) to representative forbidden-package fixtures
// so a regression in any scanner exits non-zero with the right
// evidence.
//
// The fixtures are constructed in tmp directories so the suite
// cannot pollute the repository tree, and each test invokes the
// exported `scanLockfile` / `scanPackageJsonFiles` /
// `scanSourceFiles` functions directly rather than spawning a
// subprocess (the script's `isDirectInvocation` guard would
// otherwise short-circuit on import).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { scanLockfile, scanPackageJsonFiles, scanSourceFiles } from "./check-forbidden-deps.mjs";

// Minimal pnpm v9 lockfile header. Only `importers:` and
// `packages:` carry dependency keys; the rest is structural
// padding so the YAML parses with the canonical indentation.
const LOCKFILE_HEADER = `lockfileVersion: "9.0"

settings:
  autoInstallPeers: true

importers:
  .:
    dependencies:
      lodash:
        specifier: ^4.17.0
        version: 4.17.21

packages:

`;

function makeLockfile(extraEntries) {
  return `${LOCKFILE_HEADER}${extraEntries.join("\n\n")}\n`;
}

function makeTmpRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "forbidden-deps-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(dir, relativePath);
    if (relativePath.endsWith("/")) {
      mkdirSync(full, { recursive: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function violationByName(violations, name) {
  return violations.find((v) => v.evidence.includes(`"${name}"`));
}

describe("scanLockfile (pnpm v9 key format)", () => {
  test("detects an unscoped forbidden package under packages:", () => {
    const dir = makeTmpRepo({
      "pnpm-lock.yaml": makeLockfile(["  openai@4.0.0:\n    resolution: {integrity: sha512-x}"], {
        "package.json": "{}",
      }),
    });
    try {
      const violations = scanLockfile(join(dir, "pnpm-lock.yaml"));
      const v = violationByName(violations, "openai");
      assert.ok(v, `expected an openai violation, got ${JSON.stringify(violations)}`);
      assert.equal(v.line, 15, `expected the violation at the openai key line, got ${v.line}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects a scoped forbidden package under packages:", () => {
    const dir = makeTmpRepo({
      "pnpm-lock.yaml": makeLockfile([
        '  "@pinecone-database/pinecone@1.2.3":\n    resolution: {integrity: sha512-x}',
      ]),
    });
    try {
      const violations = scanLockfile(join(dir, "pnpm-lock.yaml"));
      const v = violationByName(violations, "@pinecone-database/pinecone");
      assert.ok(v, `expected a pinecone violation, got ${JSON.stringify(violations)}`);
      assert.equal(v.line, 15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects a scoped wildcard family member under packages:", () => {
    // The wildcard entry `@pinecone-database/*` should match every
    // package in that scope. Use a sibling that is NOT in the
    // FORBIDDEN_PACKAGES list to confirm the wildcard expansion.
    const dir = makeTmpRepo({
      "pnpm-lock.yaml": makeLockfile([
        '  "@pinecone-database/pinecone-client@2.0.0":\n    resolution: {integrity: sha512-x}',
      ]),
    });
    try {
      const violations = scanLockfile(join(dir, "pnpm-lock.yaml"));
      const v = violationByName(violations, "@pinecone-database/*");
      assert.ok(v, `expected a wildcard violation, got ${JSON.stringify(violations)}`);
      assert.equal(v.line, 15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects a forbidden package declared in an importer (importer section)", () => {
    // pnpm v9 quotes scoped package names (`"@scope/name":`) but
    // leaves unscoped package names unquoted (`name:`). This fixture
    // exercises the unscoped branch and asserts the line number
    // pin to the importer key line so a regression in the
    // section-anchor logic surfaces immediately.
    const dir = makeTmpRepo({
      "pnpm-lock.yaml":
        'lockfileVersion: "9.0"\n\nimporters:\n  .:\n    devDependencies:\n      openai:\n        specifier: ^4.0.0\n        version: 4.0.0\n\npackages:\n\n',
    });
    try {
      const violations = scanLockfile(join(dir, "pnpm-lock.yaml"));
      const v = violationByName(violations, "openai");
      assert.ok(v, `expected an openai violation, got ${JSON.stringify(violations)}`);
      // The key line is at index 5 (0-based) which is line 6 (1-based).
      // Fixture: 1=lockfileVersion, 2=blank, 3=importers:, 4=.:,
      // 5=devDependencies:, 6=openai:.
      assert.equal(v.line, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT match a leading-slash (lockfile v6-style) key", () => {
    // The old matcher was anchored on `/${name}@`. A v6-style key
    // would have produced a false positive under that matcher; this
    // test pins that the v9 matcher ignores that legacy shape so
    // the scan stays scoped to the current pnpm format.
    const dir = makeTmpRepo({
      "pnpm-lock.yaml":
        'lockfileVersion: "9.0"\n\npackages:\n\n  /openai@4.0.0:\n    resolution: {integrity: sha512-x}\n',
    });
    try {
      const violations = scanLockfile(join(dir, "pnpm-lock.yaml"));
      const v = violationByName(violations, "openai");
      assert.equal(
        v,
        undefined,
        `v9 matcher must ignore legacy leading-slash keys; got ${JSON.stringify(v)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns no violations for a clean fixture", () => {
    const dir = makeTmpRepo({
      "pnpm-lock.yaml": makeLockfile([
        "  lodash@4.17.21:\n    resolution: {integrity: sha512-x}",
        '  "@types/node@20.0.0":\n    resolution: {integrity: sha512-x}',
      ]),
    });
    try {
      const violations = scanLockfile(join(dir, "pnpm-lock.yaml"));
      assert.deepEqual(violations, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns no violations when the lockfile is missing", () => {
    const dir = makeTmpRepo({});
    try {
      const violations = scanLockfile(join(dir, "pnpm-lock.yaml"));
      assert.deepEqual(violations, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scanPackageJsonFiles", () => {
  test("detects a forbidden dependency declared in package.json", () => {
    const dir = makeTmpRepo({
      "package.json": JSON.stringify({
        dependencies: { openai: "^4.0.0" },
      }),
    });
    try {
      const violations = scanPackageJsonFiles([join(dir, "package.json")]);
      const v = violationByName(violations, "openai");
      assert.ok(v, `expected an openai violation, got ${JSON.stringify(violations)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects a forbidden dependency under devDependencies", () => {
    const dir = makeTmpRepo({
      "package.json": JSON.stringify({
        devDependencies: { ethers: "^6.0.0" },
      }),
    });
    try {
      const violations = scanPackageJsonFiles([join(dir, "package.json")]);
      const v = violationByName(violations, "ethers");
      assert.ok(v, `expected an ethers violation, got ${JSON.stringify(violations)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects a wildcard family member declared in package.json", () => {
    const dir = makeTmpRepo({
      "package.json": JSON.stringify({
        dependencies: { "@polkadot/api": "^1.0.0" },
      }),
    });
    try {
      const violations = scanPackageJsonFiles([join(dir, "package.json")]);
      const v = violationByName(violations, "@polkadot/api");
      assert.ok(v);
      const wild = violationByName(violations, "@polkadot/*");
      assert.ok(wild, `expected a wildcard violation too, got ${JSON.stringify(violations)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns no violations for a clean package.json", () => {
    const dir = makeTmpRepo({
      "package.json": JSON.stringify({
        dependencies: { zod: "^3.23.0" },
        devDependencies: { typescript: "^5.6.0" },
      }),
    });
    try {
      const violations = scanPackageJsonFiles([join(dir, "package.json")]);
      assert.deepEqual(violations, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scanSourceFiles", () => {
  test("detects a forbidden import specifier", () => {
    const dir = makeTmpRepo({
      "src/index.ts": `import OpenAI from "openai";\n`,
    });
    try {
      const violations = scanSourceFiles(dir, [join(dir, "src")]);
      const v = violationByName(violations, "openai");
      assert.ok(v, `expected an openai violation, got ${JSON.stringify(violations)}`);
      assert.equal(v.line, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects a forbidden scoped import specifier", () => {
    const dir = makeTmpRepo({
      "src/index.ts": `import { Pinecone } from "@pinecone-database/pinecone";\n`,
    });
    try {
      const violations = scanSourceFiles(dir, [join(dir, "src")]);
      const v = violationByName(violations, "@pinecone-database/pinecone");
      assert.ok(v, `expected a pinecone violation, got ${JSON.stringify(violations)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns no violations for a clean source file", () => {
    const dir = makeTmpRepo({
      "src/index.ts": `import { z } from "zod";\nimport express from "express";\n`,
    });
    try {
      const violations = scanSourceFiles(dir, [join(dir, "src")]);
      assert.deepEqual(violations, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Suppress unused-variable lint by binding the helper.
void before;
void after;
