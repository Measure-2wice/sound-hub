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
// Repository contract:
//   - INSERT Workspace with a placeholder slug.
//   - Prisma's `@default(cuid())` emits the genuine Workspace id.
//   - UPDATE Workspace to set the canonical slug = personal-<id>.
//   - Both operations run in a single `$transaction` so the
//     placeholder-slug INSERT is rolled back on CAS race loss.
//
// Authoritative contract for the slug suffix:
//   * Opaque — no email, no provider subject, no display name.
//   * Unique — `workspaces.slug` carries a UNIQUE constraint.
//   * Stable — once a Personal Workspace exists, the slug never
//     changes; the convergence service's CAS-on-`personalWorkspaceId`
//     guarantees that retries converge on the persisted Workspace.
//   * The slug matches `^personal-c[a-z0-9]+$` because Prisma's
//     cuid is `c` + lowercase alphanumeric.
//
// This helper is server-only and pure. It is imported by the
// `AuthRepository`'s `createInitialPersonalWorkspace` primitive
// (both Prisma and in-memory adapters), which is the single owner
// of Personal Workspace slug generation. The convergence service
// does not compute slugs; it only receives them from the repository.

/**
 * Format the opaque slug for a Personal Workspace. The repository
 * passes the SAME id Prisma emitted (via `@default(cuid())`) for
 * the Workspace row so `slug === "personal-" + workspace.id` holds.
 */
export function buildPersonalWorkspaceSlug(workspaceId: string): string {
  return `personal-${workspaceId}`;
}
