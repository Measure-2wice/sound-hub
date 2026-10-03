// Shared per-Workspace seller-profile advisory lock helper.
//
// M2 (#86, slice 86B Codex re-review): the Reactivate transaction
// must read `sellerProfile.status` under the same lock that
// SellerProfile write paths use, or a concurrent suspension can
// commit between Reactivate's read and Reactivate's commit, leaving
// a newly-Active offering associated with a now-Suspended profile.
//
// Both the SellerProfile repository's `saveDraft` / `writePublication`
// and the ServiceOffering repository's `reactivate` call this —
// keeping the SQL in one place prevents drift between the two
// callers and guarantees the lock key is identical in both places.
//
// The lock class is the single-int `pg_advisory_xact_lock(int4)` form
// with `hashtext(namespace::text)` for the key — this matches the
// SellerProfile repository's previous private helper at
// `prisma-seller-profile.repository.ts:62-66` byte-for-byte so no
// existing lock-acquisition behavior changes.

import { Prisma } from "@soundhub/db";

/**
 * Stable per-Workspace lock key for `pg_advisory_xact_lock`. The
 * Postgres `hashtext` function returns int4, which fits the
 * `pg_advisory_xact_lock(int4)` signature without a JS-side 64-bit
 * overflow risk.
 *
 * The lock-namespace string is `seller-profile:<workspaceId>` so it
 * is collision-free against the other advisory-lock namespaces
 * (`service-offering:*`, `service-offering-create:*`, `intent:*`,
 * `audio-sample`).
 */
export function sellerProfileWorkspaceLockSql(workspaceId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtext(${`seller-profile:${workspaceId}`}::text))
  `;
}
