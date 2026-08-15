// M1.7 forbidden-dependency check.
//
// The Milestone 1 spec and plan require the completed slice to run
// without OpenAI, Pinecone, Redis, storage, wallet, or blockchain
// credentials. This script makes that constraint ENFORCEABLE: it
// scans the workspace for forbidden package declarations (in any
// `package.json` or `pnpm-lock.yaml` resolved dependency) and for
// forbidden import specifiers in TypeScript/JavaScript source.
//
// It is fail-closed: any forbidden occurrence prints a concrete
// file:line evidence line and exits non-zero, so a developer (or CI)
// who adds one of these dependencies is stopped before merge.
//
// Scope:
//   - Every workspace `package.json` (root, apps/*, packages/*).
//   - `pnpm-lock.yaml` resolved dependency declarations.
//   - TypeScript and JavaScript source files under apps/*/src,
//     packages/*/src, packages/*/prisma/, and scripts/.
//
// Out of scope:
//   - Files in `node_modules/`, `dist/`, `.next/`, `.next-dev/`,
//     `test-results/`, and `playwright-report/` (build artefacts).
//   - Generated Prisma client output (`packages/db/src/generated/`).
//   - Files explicitly allow-listed via the SOURCE_ALLOWLIST set
//     below (used only for tests of this script).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

const FORBIDDEN_PACKAGES = [
  // OpenAI / Anthropic / Google ADK / LangChain (no AI in M1).
  { name: "openai", reason: "OpenAI client is not part of the M1 slice" },
  { name: "@anthropic-ai/sdk", reason: "Anthropic SDK is not part of the M1 slice" },
  { name: "langchain", reason: "LangChain is not part of the M1 slice" },
  { name: "@langchain/core", reason: "LangChain is not part of the M1 slice" },
  { name: "google-generativeai", reason: "Google Generative AI is not part of the M1 slice" },
  { name: "@google-cloud/vertexai", reason: "Vertex AI is not part of the M1 slice" },
  { name: "@google/adk", reason: "Google ADK is not part of the M1 slice" },
  { name: "@google/genai", reason: "Google GenAI is not part of the M1 slice" },
  // Pinecone (no vector retrieval in M1).
  { name: "@pinecone-database/pinecone", reason: "Pinecone is not part of the M1 slice" },
  { name: "@pinecone-database/*", reason: "Pinecone is not part of the M1 slice" },
  // Redis (no caching in M1).
  { name: "redis", reason: "Redis client is not part of the M1 slice" },
  { name: "ioredis", reason: "Redis client is not part of the M1 slice" },
  { name: "@redis/client", reason: "Redis client is not part of the M1 slice" },
  // Object storage (no uploads in M1).
  { name: "@aws-sdk/client-s3", reason: "S3 client is not part of the M1 slice" },
  { name: "@aws-sdk/lib-storage", reason: "S3 client is not part of the M1 slice" },
  { name: "@aws-sdk/s3-request-presigner", reason: "S3 client is not part of the M1 slice" },
  { name: "aws-sdk", reason: "AWS SDK v2 is not part of the M1 slice" },
  { name: "@google-cloud/storage", reason: "GCS client is not part of the M1 slice" },
  { name: "@supabase/storage-js", reason: "Supabase storage is not part of the M1 slice" },
  { name: "pinata", reason: "Pinata is not part of the M1 slice" },
  { name: "@pinata/sdk", reason: "Pinata is not part of the M1 slice" },
  // Wallet and blockchain (no payments in M1).
  { name: "ethers", reason: "Ethers is not part of the M1 slice" },
  { name: "wagmi", reason: "Wagmi is not part of the M1 slice" },
  { name: "viem", reason: "Viem is not part of the M1 slice" },
  { name: "web3", reason: "Web3.js is not part of the M1 slice" },
  { name: "@walletconnect/web3-provider", reason: "WalletConnect is not part of the M1 slice" },
  { name: "@polkadot/api", reason: "Polkadot is not part of the M1 slice" },
  { name: "@polkadot/*", reason: "Polkadot is not part of the M1 slice" },
  { name: "@substrate/*", reason: "Substrate is not part of the M1 slice" },
  { name: "@solana/web3.js", reason: "Solana is not part of the M1 slice" },
  { name: "@solana/*", reason: "Solana is not part of the M1 slice" },
  { name: "near-api-js", reason: "NEAR is not part of the M1 slice" },
];

// Source-code specifiers that would imply an unauthorized dependency
// even when no top-level package declaration exists. These are the
// canonical import specifiers for the forbidden packages above plus
// a few common internal references that should never appear.
const FORBIDDEN_IMPORT_SPECIFIERS = [
  /^openai\//,
  /^@anthropic-ai\//,
  /^@pinecone-database\//,
  /^langchain\//,
  /^@langchain\//,
  /^@google-cloud\/storage/,
  /^@aws-sdk\//,
  /^@google\/adk/,
  /^@google\/genai/,
  /^@polkadot\//,
  /^@solana\//,
];

const SCANNED_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Directories excluded from the source-code scan. Build artefacts,
// generated Prisma clients, and node_modules must not be scanned
// (they are produced from already-vetted inputs).
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".next-dev",
  "test-results",
  "playwright-report",
  "generated",
  ".git",
  ".turbo",
  "coverage",
]);

// Allow-list: package.json files that intentionally mention a
// forbidden dependency. None exist today; this is a forward-looking
// hook for tests of this script and for a documented exception if
// the integration owner ever approves one (per AGENTS.md).
const PACKAGE_JSON_ALLOWLIST = new Set([
  // Intentionally empty. Future additions require an ADR.
]);

const SOURCE_ALLOWLIST = new Set([
  // The check itself enumerates the forbidden tokens as data, so it
  // must not be scanned against its own literal identifiers. Without
  // this entry, the scanner would report every forbidden name in the
  // FORBIDDEN_PACKAGES / FORBIDDEN_IMPORT_SPECIFIERS constants as a
  // self-violation. The regression-test suite deliberately writes
  // `import openai from "openai"` style fixtures into tmp files to
  // prove the scanner detects them; the test runner is allowed to
  // mention those literal identifiers in source comments and
  // strings so the fixtures can be human-readable. Both entries
  // are forward-looking hooks for any future test fixture that
  // legitimately exercises the scanner.
  "scripts/check-forbidden-deps.mjs",
  "scripts/check-forbidden-deps.test.mjs",
]);

function listJsonFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (entry.name === "package.json") out.push(full);
    }
  }
  return out;
}

function listSourceFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (entry.isFile() && SCANNED_SOURCE_EXTENSIONS.has(extname(entry.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

function readPackageJson(path) {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function collectDependencyNames(pkg) {
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const names = new Set();
  for (const section of sections) {
    const block = pkg[section];
    if (!block || typeof block !== "object") continue;
    for (const name of Object.keys(block)) names.add(name);
  }
  return names;
}

function packageMatchesForbidden(name, forbidden) {
  if (forbidden.name === name) return true;
  if (forbidden.name.endsWith("/*")) {
    const prefix = forbidden.name.slice(0, -1);
    return name.startsWith(prefix);
  }
  return false;
}

// Pnpm lockfile v9 records a package entry as a YAML map key whose
// value is a string of the form `<name>@<version>` (scoped packages
// look like `@scope/name@<version>`, with the `@scope/` prefix
// preserved). The key line is indented at least two spaces under
// `packages:`. There is no leading slash; the leading-slash format
// used by lockfile v6+ was removed in v9.
//
// The `importers:` block records direct dependencies with the bare
// package name as the key (the resolved version sits on a child
// `version:` line), optionally quoted for scoped packages. Both
// shapes must be recognized so the scanner catches direct
// declarations AND transitive resolutions.
//
// The matcher therefore uses two patterns: one for the
// `name@version:` shape used in `packages:`, and one for the
// bare-name shape used in `importers:`. Wildcard families
// (`@pinecone-database/*`) translate to a wildcard segment that
// matches any unscoped name in the family.
function pnpmV9KeyPatterns(forbidden) {
  const patterns = [];
  if (forbidden.name.startsWith("@")) {
    const slash = forbidden.name.indexOf("/");
    if (slash < 0) throw new Error(`malformed scoped forbidden name: ${forbidden.name}`);
    const scope = forbidden.name.slice(0, slash + 1); // "@scope/"
    const leaf = forbidden.name.slice(slash + 1); // "name" or "*"
    const leafPattern = leaf === "*" ? "[^@:/\\s]+" : escapeRegex(leaf);
    // packages: block — key is `"@scope/name@version":` (scoped
    // names are quoted in the pnpm v9 packages section).
    patterns.push(new RegExp(`^([ \t]+)"?${escapeRegex(scope)}${leafPattern}@[^:\\s]+"?:$`, "m"));
    // importers: block — key is `"@scope/name":` (quoted).
    patterns.push(new RegExp(`^([ \t]+)"${escapeRegex(scope)}${leafPattern}":$`, "m"));
  } else {
    patterns.push(new RegExp(`^([ \t]+)${escapeRegex(forbidden.name)}@[^:\\s]+:`, "m"));
    patterns.push(new RegExp(`^([ \t]+)${escapeRegex(forbidden.name)}:$`, "m"));
  }
  return patterns;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Scan a pnpm-lock.yaml buffer for forbidden package keys under
// `importers:` and `packages:`. Returns violations with the actual
// 1-based line number in the file so the diagnostic points to the
// key line a developer would see in their editor.
//
// The earlier implementation assumed a leading-slash key format that
// pnpm v9 dropped; that matcher could not detect any resolved or
// transitive forbidden package, and the green gate did not prove
// AC#5. The v9 anchors (`^(indent)<name>@<version>:` in the
// `packages:` block, `^(indent)<name>:` or
// `^(indent)"<name>":` in the `importers:` block) and the
// non-version-character class are the load-bearing fix.
export function scanLockfile(lockfilePath) {
  const violations = [];
  let raw;
  try {
    raw = readFileSync(lockfilePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return violations;
    throw err;
  }
  const lines = raw.split(/\r?\n/);
  for (const forbidden of FORBIDDEN_PACKAGES) {
    const patterns = pnpmV9KeyPatterns(forbidden);
    let reported = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^[ \t]+/.test(lines[i])) continue; // not a YAML map entry
      for (const pattern of patterns) {
        if (pattern.test(lines[i])) {
          violations.push({
            file: relative(REPO_ROOT, lockfilePath),
            line: i + 1,
            evidence: `forbidden dependency "${forbidden.name}" appears in the resolved lockfile: ${forbidden.reason}`,
          });
          reported = true;
          break;
        }
      }
      if (reported) break;
    }
  }
  return violations;
}

export function scanPackageJsonFiles(jsonPaths) {
  const violations = [];
  for (const pkgPath of jsonPaths) {
    if (PACKAGE_JSON_ALLOWLIST.has(relative(REPO_ROOT, pkgPath))) continue;
    let pkg;
    try {
      pkg = readPackageJson(pkgPath);
    } catch (err) {
      violations.push({
        file: relative(REPO_ROOT, pkgPath),
        line: 0,
        evidence: `package.json could not be parsed: ${err.message}`,
      });
      continue;
    }
    const names = collectDependencyNames(pkg);
    for (const forbidden of FORBIDDEN_PACKAGES) {
      for (const depName of names) {
        if (packageMatchesForbidden(depName, forbidden)) {
          // When a wildcard pattern matches (e.g. `@polkadot/*`
          // matches `@polkadot/api`), include the matched pattern
          // in the evidence so the developer can distinguish the
          // exact-match case from the family case.
          const patternNote = forbidden.name === depName ? "" : ` (matched by "${forbidden.name}")`;
          violations.push({
            file: relative(REPO_ROOT, pkgPath),
            line: 0,
            evidence: `forbidden dependency "${depName}" declared in ${forbidden.section ?? "dependencies"}: ${forbidden.reason}${patternNote}`,
          });
        }
      }
    }
  }
  return violations;
}

function scanSourceFilesImpl(repoRoot, sourceRoots) {
  const violations = [];

  for (const root of sourceRoots) {
    for (const file of listSourceFiles(root)) {
      const rel = relative(repoRoot, file);
      if (SOURCE_ALLOWLIST.has(rel)) continue;
      const raw = readFileSync(file, "utf8");
      const lines = raw.split(/\r?\n/);
      lines.forEach((text, idx) => {
        // Strip trailing line numbers; the scanner must match
        // specifiers regardless of how the line is wrapped.
        const stripped = text;
        const importMatches = [
          ...stripped.matchAll(/from\s+["']([^"']+)["']/g),
          ...stripped.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
          ...stripped.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
          ...stripped.matchAll(/import\s+["']([^"']+)["']/g),
        ];
        for (const match of importMatches) {
          const specifier = match[1];
          if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
          for (const forbidden of FORBIDDEN_IMPORT_SPECIFIERS) {
            if (forbidden.test(specifier)) {
              violations.push({
                file: rel,
                line: idx + 1,
                evidence: `forbidden import specifier "${specifier}" matches ${forbidden}`,
              });
            }
          }
        }
        // Also catch literal forbidden package identifiers (e.g.
        // an inline `import openai from "openai"` would be caught
        // by the import scan above, but a stray identifier in a
        // string literal or comment still warrants flagging).
        for (const forbidden of FORBIDDEN_PACKAGES) {
          if (forbidden.name === "*") continue;
          const escaped = forbidden.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const idRegex = new RegExp(`\\b${escaped}\\b`);
          if (idRegex.test(stripped)) {
            violations.push({
              file: rel,
              line: idx + 1,
              evidence: `forbidden identifier "${forbidden.name}" mentioned in source: ${forbidden.reason}`,
            });
          }
        }
      });
    }
  }
  return violations;
}

// Compute the standard source roots for a workspace: every
// `apps/*/src`, every `packages/*/src`, every `packages/*/prisma`,
// and the top-level `scripts/`. Exposed so the regression suite
// can compare the workspace roots against a synthetic fixture.
export function workspaceSourceRoots(repoRoot) {
  const roots = [];
  for (const entry of readdirSync(join(repoRoot, "apps"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const src = join(repoRoot, "apps", entry.name, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
    }
  }
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const src = join(repoRoot, "packages", entry.name, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
      // The Prisma seed lives at `packages/db/prisma/seed.ts`
      // rather than under `src/`. Without an explicit entry
      // here, a forbidden import added to the seed would evade
      // the scanner entirely. The `generated/` subdirectory is
      // already excluded via EXCLUDED_DIRS so the generated
      // Prisma client is not scanned.
      const prismaDir = join(repoRoot, "packages", entry.name, "prisma");
      try {
        if (statSync(prismaDir).isDirectory()) roots.push(prismaDir);
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
    }
  }
  roots.push(join(repoRoot, "scripts"));
  return roots;
}

// Run the full workspace scan. Returns every violation found
// across package.json files, the lockfile, and source files.
export function scanSourceFiles(repoRoot, sourceRoots) {
  if (sourceRoots === undefined) {
    return scanSourceFilesImpl(repoRoot, workspaceSourceRoots(repoRoot));
  }
  return scanSourceFilesImpl(repoRoot, sourceRoots);
}

export function runWorkspaceScan(repoRoot = REPO_ROOT) {
  return [
    ...scanPackageJsonFiles(listJsonFiles(repoRoot)),
    ...scanLockfile(join(repoRoot, "pnpm-lock.yaml")),
    ...scanSourceFilesImpl(repoRoot, workspaceSourceRoots(repoRoot)),
  ];
}

// Only run the script's main() when this file is invoked directly,
// not when it is imported by another module (e.g. the
// regression-test suite). The seed.ts pattern is the same: check
// whether the entry script ends with this file's basename.
const isDirectInvocation = (() => {
  if (typeof process === "undefined") return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("/check-forbidden-deps.mjs") || entry.endsWith("/check-forbidden-deps.js");
})();

function main() {
  const violations = runWorkspaceScan();
  if (violations.length === 0) {
    console.log(
      "✅ Forbidden-dependency check passed: no OpenAI, Pinecone, Redis, storage, wallet, or blockchain references in the M1.7 slice.",
    );
    return;
  }
  console.error("❌ Forbidden-dependency check failed:");
  for (const v of violations) {
    const location = v.line === 0 ? v.file : `${v.file}:${v.line}`;
    console.error(`   ${location}: ${v.evidence}`);
  }
  console.error(
    "\nThe M1 slice must not depend on OpenAI, Pinecone, Redis, storage, wallet, or blockchain libraries. Remove the dependency and re-run `pnpm check:forbidden-deps`.",
  );
  process.exit(1);
}

if (isDirectInvocation) {
  main();
}
