// Personal Workspace slug helper.
//
// Background: M2 #82 establishes the opaque slug strategy for Personal
// Workspaces. The slug is derived from the Workspace's primary
// identifier, so the two are intrinsically linked — same value, same
// generation moment, same lifetime. The slug exposes neither email nor
// provider identity and never contains the UserAccount's display name.
//
// This helper is server-only and pure. It is imported by the
// AuthRepository's `createInitialPersonalWorkspace` primitive, which
// is the single owner of slug generation. The convergence service does
// not compute slugs; it only receives them from the repository. This
// keeps the persistence layer authoritative and prevents the service
// layer from leaking slug-shape assumptions back into persistence.
//
// The slug format is `personal-{workspaceId}`. The `personal-` prefix
// distinguishes Personal Workspace slugs from Organization Workspace
// slugs in any logging or future routing layer. The slug is treated as
// an opaque routing identifier by all callers — the human-readable
// display name is the fixed literal "My Workspace", surfaced via the
// public Workspace DTO.

export function buildPersonalWorkspaceSlug(workspaceId: string): string {
  return `personal-${workspaceId}`;
}
