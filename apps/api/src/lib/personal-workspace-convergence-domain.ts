// Personal Workspace convergence domain types.
//
// Background: M2 #82 introduces the Personal Workspace convergence
// service and the AuthRepository's persistence primitives. The
// approved architecture is one-directional:
//
//   Authentication service  →  Convergence service  →  Auth repository
//
// To avoid a circular import between the repository and the service
// (the repository must throw `ConvergenceRaceError` and return
// `ConvergenceKind`, but the service classifies `ConvergenceKind`),
// the domain types live below BOTH layers in this module. Both
// modules import from here; neither module imports the other.
//
// This module exports PURE TYPES and the `ConvergenceRaceError`
// value class. It owns no behavior.

/**
 * Server-internal classification of the Personal Workspace state for a
 * UserAccount. `recovery` carries a `reason` so ops can debug, but
 * the reason is NEVER surfaced in the public DTO — the recovery
 * surface only ever sees `setupState: "recovery"`.
 */
export type ConvergenceKind =
  | { kind: "converged"; workspaceId: string; membershipId: string }
  | { kind: "none"; userAccountId: string }
  | { kind: "attachable"; userAccountId: string; workspaceId: string }
  | {
      kind: "recovery";
      userAccountId: string;
      reason:
        | "pointer-workspace-missing"
        | "pointer-not-personal"
        | "owner-membership-missing"
        | "membership-not-owner"
        | "contradictory-personal-relationships"
        | "multiple-personal-workspaces"
        | "co-owned-personal-workspace";
    };

/**
 * Error thrown by the repository's compare-and-set UPDATE when a
 * concurrent transaction has already linked a Personal Workspace to
 * the same UserAccount. The convergence service catches this and
 * retries by re-reading the winner's records. This error is the
 * repository's atomic serialization boundary surfaced to the service.
 */
export class ConvergenceRaceError extends Error {
  constructor(message = "Personal Workspace convergence race lost") {
    super(message);
    this.name = "ConvergenceRaceError";
  }
}
