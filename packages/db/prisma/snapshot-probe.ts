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
// Exit code: 0 on assertion pass, 1 on assertion failure (with
// the error message printed to stderr).

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

try {
  const snapshot = await captureCanonicalSnapshot();
  assertCanonicalSnapshotCorrect(snapshot);
  await disconnectPrisma();
  console.log("OK");
  process.exit(0);
} catch (err) {
  console.error("ASSERTION_FAILED:", err instanceof Error ? err.message : String(err));
  try {
    await disconnectPrisma();
  } catch {
    /* ignore */
  }
  process.exit(1);
}
