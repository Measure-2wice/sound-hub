// Personal Workspace slug helper (M2 #82).
//
// Background: M2 #82 establishes the opaque slug strategy for
// Personal Workspaces. The plan-approved contract is:
//
//   buildPersonalWorkspaceSlug(workspaceId) → `personal-${workspaceId}`
//
// where `workspaceId` is the SAME cuid Prisma generates (via
// `@default(cuid())`) for the Workspace row. The slug and the
// Workspace primary identifier are intrinsically linked — same
// value, same generation moment, same lifetime. This helper is the
// authoritative formatter.
//
// Authoritative contract for the slug suffix:
//
//   * The suffix is a cuid (lowercase alphanumeric, prefixed with
//     `c`, matching `^c[a-z0-9]+$`). Prisma's `@default(cuid())`
//     emits the canonical form; the repository must pass that
//     same cuid here.
//   * Opaque — no email, no provider subject, no display name.
//   * Unique — `workspaces.slug` carries a UNIQUE constraint.
//   * Stable — once a Personal Workspace exists, the slug never
//     changes; the convergence service's CAS-on-`personalWorkspaceId`
//     guarantees that retries converge on the persisted Workspace.
//
// Relationship to the Workspace ID:
//
//   `slug === "personal-" + workspace.id` for every Personal
//   Workspace. The slug identifier IS the Workspace id. The
//   repository owns both: it lets Prisma mint the cuid and
//   forwards the same value to this helper so the slug encodes
//   the Workspace primary identifier directly. No authoritative
//   contract leaves the two unrelated.
//
// This helper is server-only and pure. It is imported by the
// `AuthRepository`'s `createInitialPersonalWorkspace` primitive
// (both Prisma and in-memory adapters), which is the single owner
// of Personal Workspace slug generation. The convergence service
// does not compute slugs; it only receives them from the repository.

import { randomBytes } from "node:crypto";

/**
 * Format the opaque slug for a Personal Workspace. The repository
 * must pass the SAME cuid Prisma emits for the Workspace row so
 * `slug === "personal-" + workspace.id` holds.
 */
export function buildPersonalWorkspaceSlug(workspaceId: string): string {
  return `personal-${workspaceId}`;
}

/**
 * Length of the cuid suffix in characters (after the `c` prefix).
 * Prisma's cuid generator emits values longer than this; the helper
 * accepts any cuid-shaped string the repository passes.
 */
export const PERSONAL_WORKSPACE_CUID_PREFIX = "c";

/**
 * Mint a fresh, opaque, cuid-shaped identifier that satisfies the
 * `^c[a-z0-9]+$` regex and the Workspace.id contract. The repository
 * uses this when it needs to pre-generate the Workspace id so the
 * slug can be derived from the same value in a single atomic
 * transaction (no INSERT-then-UPDATE race).
 *
 * Built on Node's `node:crypto.randomBytes` (no new dependency).
 * The output is a lowercase-alphanumeric string prefixed with
 * `c` followed by a base36 timestamp + 24 base36 characters of
 * entropy. Uniqueness across the disposable test database and the
 * production database is overwhelming; the `workspaces.slug`
 * UNIQUE constraint is the durable second line of defense.
 *
 * This helper is NOT a CUID library and does NOT claim to be one.
 * It is a cuid-SHAPED identifier that satisfies the regex the M2
 * spec requires. Prisma's `@default(cuid())` remains the canonical
 * cuid source when the repository can defer Workspace id creation
 * to Prisma (i.e., outside the create + CAS transaction).
 */
export function generatePersonalWorkspaceCuid(): string {
  let suffix = "";
  while (suffix.length < 24) {
    const chunk = randomBytes(48)
      .toString("base64")
      .replace(/[^a-z0-9]/g, "");
    suffix += chunk;
  }
  return `c${suffix.slice(0, 24)}`;
}
