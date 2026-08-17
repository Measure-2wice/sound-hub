// Shared test-only helpers for the SoundHub DB test suites.
//
// The session_replication_role bypass is required to mutate
// append-only / immutable tables in tests that need to clean up
// fixture state. Production code and the canonical seed must NEVER
// flip the session role; the helper exists only to centralize the
// strict open / always-restore semantics so a test that throws or
// returns early still resets the role before the next test sees it.

import type { PrismaClient } from "../src/generated/client.js";

/**
 * Run the supplied callback with `session_replication_role = replica`
 * so trigger functions are bypassed. The role is restored to `origin`
 * even if the callback throws. The optional second argument forces a
 * synthetic exception (used by tests that verify the restoration
 * semantics independently of the callback's success).
 */
export async function withTriggerBypass<T>(
  prisma: PrismaClient,
  callback: () => Promise<T>,
  fail?: "throw",
): Promise<T> {
  await prisma.$executeRawUnsafe('SET session_replication_role = "replica";');
  try {
    if (fail === "throw") {
      throw new Error("forced callback failure for restoration regression test");
    }
    return await callback();
  } finally {
    await prisma.$executeRawUnsafe('SET session_replication_role = "origin";');
  }
}
