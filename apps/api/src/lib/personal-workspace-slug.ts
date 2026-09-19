// Personal Workspace slug helper (M2 #82).
//
// Background: M2 #82 establishes the opaque slug strategy for Personal
// Workspaces. The slug is generated server-side at Personal Workspace
// creation time and stored in `workspaces.slug` (which is `@unique` in
// the schema, per `packages/db/prisma/schema.prisma`).
//
// Authoritative contract:
//
//   * Format: `personal-c[a-z0-9]+` (matches the regex used by the
//     browser and repository regression tests).
//   * Opaque — no email, no provider subject, no display name, no
//     Workspace primary identifier in the slug suffix.
//   * Unique — `workspaces.slug` carries a UNIQUE constraint; the
//     generator uses sufficient entropy that the helper never
//     round-trips the database.
//   * Stable — once a Personal Workspace exists, the slug never
//     changes. The helper only generates once per Workspace creation;
//     the convergence service's CAS-on-`personalWorkspaceId`
//     guarantees that retries converge on the persisted Workspace.
//
// Relationship to the Workspace ID:
//
//   The slug suffix is generated INDEPENDENTLY of the Workspace
//   primary identifier. The Workspace `id` is canonically owned by
//   Prisma's `@default(cuid())` (see `Workspace.id` in the schema);
//   the slug suffix is generated here using Node's built-in
//   `crypto` and is NOT claimed to be a CUID — only to satisfy the
//   opaque, unique, stable, alphanumeric shape and the
//   `^personal-c[a-z0-9]+$` regex.
//
// This helper is server-only and pure. It is imported by the
// `AuthRepository`'s `createInitialPersonalWorkspace` primitive
// (both Prisma and in-memory adapters), which is the single owner
// of Personal Workspace slug generation. The convergence service
// does not compute slugs; it only receives them from the repository.

import { randomBytes } from "node:crypto";

/**
 * Length of the opaque slug suffix in characters (after the
 * `personal-c` prefix). 24 base36 characters drawn from
 * `crypto.randomBytes` provides ~128 bits of entropy, which is
 * more than sufficient for collision-resistance in the local
 * test database and the production database at expected scale.
 *
 * Exposed for test introspection only; production callers should
 * treat the value as opaque.
 */
export const PERSONAL_WORKSPACE_SLUG_SUFFIX_LENGTH = 24;

export function buildPersonalWorkspaceSlug(): string {
  // Sample cryptographic randomness and reduce it to the lowercase-
  // alphanumeric alphabet required by the regex. 24 characters of
  // base36 ≈ 128 bits of entropy; the slug UNIQUE constraint on
  // `workspaces.slug` catches any collision.
  let suffix = "";
  while (suffix.length < PERSONAL_WORKSPACE_SLUG_SUFFIX_LENGTH) {
    const chunk = randomBytes(PERSONAL_WORKSPACE_SLUG_SUFFIX_LENGTH * 2)
      .toString("base64")
      .replace(/[^a-z0-9]/g, "");
    suffix += chunk;
  }
  return `personal-c${suffix.slice(0, PERSONAL_WORKSPACE_SLUG_SUFFIX_LENGTH)}`;
}
