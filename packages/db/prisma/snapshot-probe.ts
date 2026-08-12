// Probe script used by the seed.test.ts regression suite.
//
// This script runs ONLY the canonical snapshot capture and the
// canonical assertion — it does NOT run applySeed(). It is used
// to prove that the snapshot observes the actual IncludedService
// relation from PostgreSQL: if a stale IncludedService row has
// been inserted and the cleanup in applySeed() is bypassed, the
// assertion must throw.
//
// Usage: tsx prisma/snapshot-probe.ts <DATABASE_URL>
//
// Exit code: 0 on assertion pass, 1 on either invariant or
// infrastructure failure (with the error message and a distinct
// marker printed to stderr):
//   - `INVARIANT_FAILED: <message>` — the canonical assertion
//     itself threw (the regression test relies on this exact
//     marker to prove the IncludedService drift was observed).
//   - `PROBE_ERROR: <message>` — an infrastructure or runtime
//     failure (database connection, query, module load,
//     disconnect). The assertion never ran, so this MUST NOT be
//     interpreted as a successful invariant detection.

const connectionString = process.argv[2];
if (!connectionString) {
  console.error("Usage: snapshot-probe.ts <DATABASE_URL>");
  process.exit(2);
}

// Set DATABASE_URL before importing the seed module, because
// the seed constructs its PrismaClient at module load time.
process.env.DATABASE_URL = connectionString;
process.env.TEST_DATABASE_URL = connectionString;

const { captureCanonicalSnapshot, assertCanonicalSnapshotCorrect, disconnectPrisma } = await import(
  "./seed.js"
);

async function disconnectPrismaSafely(): Promise<void> {
  try {
    await disconnectPrisma();
  } catch {
    /* ignore */
  }
}

try {
  const snapshot = await captureCanonicalSnapshot();
  try {
    assertCanonicalSnapshotCorrect(snapshot);
  } catch (err) {
    // Canonical invariant failure. The parent regression test
    // looks for this exact marker plus the specific drift
    // message to prove the canonical assertion itself fired.
    // Without this dedicated marker, any infrastructure or
    // runtime failure would be mislabeled as the assertion
    // error and the regression could pass for the wrong reason.
    console.error("INVARIANT_FAILED:", err instanceof Error ? err.message : String(err));
    await disconnectPrismaSafely();
    process.exit(1);
  }
  await disconnectPrisma();
  console.log("OK");
  process.exit(0);
} catch (err) {
  // Infrastructure or runtime failure: captureCanonicalSnapshot,
  // PrismaClient construction, or a module-load error. The
  // assertion never ran, so emit a distinct marker so the
  // regression test cannot mistake this for a successful
  // invariant detection.
  console.error("PROBE_ERROR:", err instanceof Error ? err.message : String(err));
  await disconnectPrismaSafely();
  process.exit(1);
}
