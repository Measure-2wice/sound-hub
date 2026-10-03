// Shared per-offering service-offering advisory lock helper.
//
// M2 (#86, slice 86D): the audio sample repository's
// `removeFinalSamplePendingCleanup` operation must acquire the same
// per-offering advisory lock that the service-offering repository's
// write paths acquire. Without a shared helper, the lock key
// formulas would drift between repositories. The lock-namespace
// string is `service-offering:<offeringId>` — collision-free
// against the other advisory-lock namespaces
// (`seller-profile:*`, `intent:*`, `audio-sample`).
//
// Postgres's built-in `hashtext` returns int4, which fits the
// `pg_advisory_xact_lock(int4)` single-argument signature without
// the signed-64-bit overflow risk a JS-side FNV-1a would carry.

import { Prisma } from "@soundhub/db";

/**
 * Stable per-offering lock key for `pg_advisory_xact_lock`.
 * Acquired at the top of every write transaction in the
 * service-offering repository's activate / pause / reactivate /
 * updateActive / removeFinalSamplePendingCleanup paths.
 */
export function offeringLockSql(offeringId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`service-offering:${offeringId}`}::text))
  `;
}
