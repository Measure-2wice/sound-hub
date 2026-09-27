// Shared per-offering audio-sample advisory lock helper.
//
// M2 (#85) PR-review feedback (round 2): the activation
// transaction in `prisma-service-offering.repository.activate`
// acquires BOTH the `service-offering:<id>` lock AND this
// audio-sample lock so a concurrent sample remove (which also
// acquires this audio-sample lock) cannot commit between the
// activation's eligibility count and the activation's commit.
//
// The lock class is `AUDIO_SAMPLE_LOCK_CLASS` ("AUDI"). The
// per-offering key is a stable FNV-1a hash of the offeringId;
// collisions only cause unrelated offerings to serialize
// unnecessarily, never a correctness gap.

import { Prisma } from "@soundhub/db";

export const AUDIO_SAMPLE_LOCK_CLASS = 0x4155_4449; // 'AUDI'

/**
 * Stable per-offering key for `pg_advisory_xact_lock(int, int)`.
 * FNV-1a 32-bit; the result is forced into signed 32-bit range so
 * it satisfies the two-int form's signature.
 */
export function audioSampleLockKey(offeringId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < offeringId.length; i += 1) {
    hash ^= offeringId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * The SQL fragment that acquires the per-offering audio-sample
 * advisory lock for the lifetime of the current transaction.
 * Both the audio-sample repository and the service-offering
 * activation transaction call this — keeping the SQL in one
 * place prevents drift between the two callers.
 */
export function acquireAudioSampleLockTx(
  tx: { $executeRaw: (sql: Prisma.Sql) => Promise<unknown> },
  offeringId: string,
): Promise<unknown> {
  const lockKey = audioSampleLockKey(offeringId);
  return tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(${AUDIO_SAMPLE_LOCK_CLASS}::int, ${lockKey}::int)`,
  );
}
