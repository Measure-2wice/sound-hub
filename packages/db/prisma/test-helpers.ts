// Shared test-only helpers for the SoundHub DB test suites.
//
// The session_replication_role bypass is required to mutate
// append-only / immutable tables in tests that need to clean up
// fixture state. Production code and the canonical seed must NEVER
// flip the session role; the helper exists only to centralize the
// strict open / always-restore semantics so a test that throws or
// returns early still resets the role before the next test sees it.
//
// Connection affinity: each prisma.X call may pick a different
// pooled connection. Without pinning, the opening SET replica,
// arbitrary callback work, and the closing SET origin can run on
// three different connections — leaving some connections stuck in
// `replica` mode and others (which run the actual mutations) in
// `origin` mode where triggers fire. The helper pins the SET, the
// callback, and the implicit restoration onto a single
// prisma.$transaction so every query runs on the same backend
// connection. SET LOCAL is scoped to the transaction and reverts on
// COMMIT/ROLLBACK, so the connection is automatically restored to
// `origin` even if the callback throws.

import type { Prisma, PrismaClient } from "../src/generated/client.js";

/**
 * Run the supplied callback with `session_replication_role = replica`
 * so trigger functions are bypassed. The role is restored to `origin`
 * by the surrounding transaction on COMMIT/ROLLBACK, even when the
 * callback throws. The callback receives the pinned transaction
 * client; callers MUST issue mutations on `tx` (not the outer
 * `prisma`) so the operations share the same backend connection as
 * the SET LOCAL. The optional `fail` argument forces a synthetic
 * exception so the restoration path can be exercised independently
 * of the callback's normal control flow.
 */
export async function withTriggerBypass<T>(
  prisma: PrismaClient,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = "replica";');
    return await callback(tx);
  });
}
