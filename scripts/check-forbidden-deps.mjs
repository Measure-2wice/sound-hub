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
//   - TypeScript and JavaScript source files under apps/*/src and
//     packages/*/src.
//
// Out of scope:
//   - Files in `node_modules/`, `dist/`, `.next/`, `.next-dev/`,
//     `test-results/`, and `playwright-report/` (build artefacts).
//   - Generated Prisma client output (`packages/db/src/generated/`).
//   - Files explicitly allow-listed via the FORBIDDEN_DEPS_ALLOWLIST
//     env var (comma-separated file paths, used only for tests of
//     this script).

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
  // self-violation. The allow-list is a forward-looking hook for any
  // future test fixture that legitimately exercises the scanner.
  "scripts/check-forbidden-deps.mjs",
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

function reportPackageJsonViolations() {
  const violations = [];
  for (const pkgPath of listJsonFiles(REPO_ROOT)) {
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
          violations.push({
            file: relative(REPO_ROOT, pkgPath),
            line: 0,
            evidence: `forbidden dependency "${depName}" declared in ${forbidden.section ?? "dependencies"}: ${forbidden.reason}`,
          });
        }
      }
    }
  }
  return violations;
}

function reportLockfileViolations() {
  const lockPath = join(REPO_ROOT, "pnpm-lock.yaml");
  const violations = [];
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return violations;
    throw err;
  }
  const lines = raw.split(/\r?\n/);
  // Resolve the `importers.<pkg>:` block to scope the check to
  // workspace packages only. The lockfile also records transitive
  // resolutions under `packages:`; the M1.7 contract requires the
  // workspace dependency graph to contain none of the forbidden
  // packages at any depth, so both lists must be free of violations.
  let block = "";
  let inImporters = false;
  let inPackages = false;
  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) {
      inImporters = true;
      block += `${line}\n`;
      continue;
    }
    if (/^packages:\s*$/.test(line)) {
      inImporters = false;
      inPackages = true;
      block += `${line}\n`;
      continue;
    }
    if (inImporters && /^[a-zA-Z]/.test(line) && !/^\s/.test(line)) {
      inImporters = false;
    }
    if (inPackages && /^[a-zA-Z]/.test(line) && !/^\s/.test(line)) {
      inPackages = false;
    }
    if (inImporters || inPackages) block += `${line}\n`;
  }
  // Scan both blocks for forbidden package keys like `/openai@1.2.3`
  // or `/@pinecone-database/pinecone@1.2.3`. The leading slash + the
  // `@`-separated name is the canonical pnpm key format.
  for (const forbidden of FORBIDDEN_PACKAGES) {
    const prefix = forbidden.name.startsWith("@")
      ? `/${forbidden.name.replace(/\*/g, ".*")}@`
      : `/${forbidden.name.replace(/\*/g, ".*")}@`;
    const regex = new RegExp(prefix, "m");
    const match = regex.exec(block);
    if (match) {
      const idx = block.indexOf(match[0]);
      const lineNumber = block.slice(0, idx).split(/\r?\n/).length - 1;
      violations.push({
        file: "pnpm-lock.yaml",
        line: lineNumber,
        evidence: `forbidden dependency "${forbidden.name}" appears in the resolved lockfile: ${forbidden.reason}`,
      });
    }
  }
  return violations;
}

function reportSourceViolations() {
  const violations = [];
  const sourceRoots = [];
  // Scan apps/*/src and packages/*/src.
  for (const entry of readdirSync(join(REPO_ROOT, "apps"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const src = join(REPO_ROOT, "apps", entry.name, "src");
      try {
        if (statSync(src).isDirectory()) sourceRoots.push(src);
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
    }
  }
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const src = join(REPO_ROOT, "packages", entry.name, "src");
      try {
        if (statSync(src).isDirectory()) sourceRoots.push(src);
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
    }
  }
  // Also scan scripts/ (used for the operational scripts that drive
  // the disposable test database and the acceptance gate).
  sourceRoots.push(join(REPO_ROOT, "scripts"));

  for (const root of sourceRoots) {
    for (const file of listSourceFiles(root)) {
      const rel = relative(REPO_ROOT, file);
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

function main() {
  const violations = [
    ...reportPackageJsonViolations(),
    ...reportLockfileViolations(),
    ...reportSourceViolations(),
  ];
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

main();
