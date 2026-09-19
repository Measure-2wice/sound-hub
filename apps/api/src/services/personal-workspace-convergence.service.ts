// Personal Workspace Convergence service (M2 #82).
//
// Background: M2 ticket #82 requires that the first successful
// authentication of any human converges that human onto exactly one
// safe Personal Workspace and exactly one current Owner
// `WorkspaceMembership`, atomically. Returning users reuse the same
// records. Conflicting legacy rows enter an explicit recovery state
// without an acting-Workspace selector being fabricated.
//
// Layering:
//
//   Auth service  →  Convergence service  →  Auth repository (primitives)
//
// - The convergence service classifies the raw state read from the
//   repository into a `ConvergenceKind` and orchestrates the
//   create / attach transactions by calling repository primitives.
// - The repository exposes `createInitialPersonalWorkspace` and
//   `attachExistingPersonalWorkspace` as persistence primitives; it
//   does NOT decide the kind. The repository's `findPersonalWorkspaceState`
//   returns raw state — no classification — so the architecture stays
//   one-directional.
// - The repository does NOT depend on this service. This service does
//   NOT own persistence. The slug helper lives in a separate server-
//   only module (`apps/api/src/lib/personal-workspace-slug.ts`) and
//   is imported only by the repository.
//
// Concurrency invariant:
//
//   The repository's compare-and-set UPDATE on UserAccount.personal-
//   WorkspaceId is the atomic serialization point. The losing
//   transaction throws `ConvergenceRaceError`; the service catches it
//   and retries by re-reading. The `Workspace.slug` UNIQUE constraint
//   is the second defense for the (impossible) slug collision. The
//   `UserAccount.personalWorkspaceId` UNIQUE constraint is the third
//   defense.
//
//   At the REPOSITORY level: exactly one CAS winner per race; the
//   losing raw repository operation MAY throw `ConvergenceRaceError`
//   and roll back; after settlement there is exactly one Personal
//   Workspace, exactly one Owner membership, one linkage, zero
//   orphan rows.
//
//   At the SERVICE level: the service catches race loss, retries,
//   and re-reads. All callers ultimately observe the same canonical
//   Workspace (or, in the rare case the retry budget is exhausted,
//   the surface surfaces `ConvergenceRaceError` and the auth route
//   fails closed).
//
// Recovery reasons (server-internal, never exposed in the public DTO):
//
//   pointer-workspace-missing
//   pointer-not-personal
//   owner-membership-missing
//   membership-not-owner
//   contradictory-personal-relationships
//   multiple-personal-workspaces
//
// Recovery is not a 403 envelope from /verify-token — the auth route
// always issues a session, and the public DTO carries
// `setupState: "recovery"`. The internal reason is logged server-side
// for ops but never crosses the HTTP boundary.

import type { AuthRepository, PersonalWorkspaceState } from "../auth-repository/auth-repository.js";
import { ConvergenceRaceError } from "../lib/personal-workspace-convergence-domain.js";
import type { ConvergenceKind } from "../lib/personal-workspace-convergence-domain.js";

// Re-export for callers (tests, the authentication service) that
// imported these symbols from this module before they moved to the
// shared domain module. The internal implementation now lives below
// both layers so the repository and the service never import from
// each other.
export { ConvergenceRaceError };
export type { ConvergenceKind };

export interface PersonalWorkspaceConvergenceServiceDeps {
  readonly authRepository: AuthRepository;
}

/** Bounded retry budget for CAS race resolution at the service layer. */
const SERVICE_RETRY_BUDGET = 5;

export class PersonalWorkspaceConvergenceService {
  constructor(private readonly deps: PersonalWorkspaceConvergenceServiceDeps) {}

  /**
   * Read the current Personal Workspace state for the given
   * UserAccount. Returns one of the four `ConvergenceKind` variants.
   * The classification happens here, NOT in the repository; the
   * repository returns raw state via `findPersonalWorkspaceState`.
   */
  async resolveConvergence(input: { userAccountId: string }): Promise<ConvergenceKind> {
    const state = await this.deps.authRepository.findPersonalWorkspaceState({
      userAccountId: input.userAccountId,
    });
    return classifyPersonalWorkspaceState(state, input.userAccountId);
  }

  /**
   * First-auth path: the UserAccount exists but has no Personal
   * Workspace. Create one atomically with an Owner membership and link
   * it via compare-and-set. Retries on `ConvergenceRaceError` so a
   * losing transaction re-reads the winner's records.
   */
  async createInitialConvergence(input: {
    userAccountId: string;
  }): Promise<{ workspaceId: string; slug: string }> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < SERVICE_RETRY_BUDGET; attempt++) {
      try {
        const result = await this.deps.authRepository.createInitialPersonalWorkspace({
          userAccountId: input.userAccountId,
        });
        return result;
      } catch (err) {
        if (!(err instanceof ConvergenceRaceError)) throw err;
        lastError = err;
        // The losing transaction re-reads the winner's records. The
        // service returns the winner's workspace id + slug rather than
        // throwing to the caller.
        const resolved = await this.resolveConvergence({
          userAccountId: input.userAccountId,
        });
        if (resolved.kind === "converged") {
          // The winner already attached a workspace; surface it.
          const slug = await this.lookupSlug(resolved.workspaceId);
          if (slug !== null) {
            return { workspaceId: resolved.workspaceId, slug };
          }
          // Fall through if we can't read the slug for any reason;
          // the bounded retry budget will eventually fail closed.
        }
      }
    }
    if (lastError) throw lastError;
    throw new ConvergenceRaceError();
  }

  /**
   * Backfill gap path: the UserAccount has exactly one Owner Personal
   * membership but `personalWorkspaceId` is NULL (migration could not
   * link it). Link the existing workspace via compare-and-set.
   * Retries on `ConvergenceRaceError` similarly.
   */
  async attachExistingConvergence(input: {
    userAccountId: string;
    workspaceId: string;
  }): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < SERVICE_RETRY_BUDGET; attempt++) {
      try {
        await this.deps.authRepository.attachExistingPersonalWorkspace(input);
        return;
      } catch (err) {
        if (!(err instanceof ConvergenceRaceError)) throw err;
        lastError = err;
        // Re-read on race loss; if the winner already linked the
        // pointer, the next iteration will succeed (idempotent).
        const resolved = await this.resolveConvergence({
          userAccountId: input.userAccountId,
        });
        if (resolved.kind === "converged" && resolved.workspaceId === input.workspaceId) {
          return;
        }
        // If the state changed (e.g., a recovery transition), bail
        // out — the caller needs to re-classify.
        if (resolved.kind !== "attachable") {
          return;
        }
      }
    }
    if (lastError) throw lastError;
    throw new ConvergenceRaceError();
  }

  private async lookupSlug(workspaceId: string): Promise<string | null> {
    return this.deps.authRepository.findWorkspaceSlugById(workspaceId);
  }
}

/**
 * Classify a raw Personal Workspace state read from the repository
 * into a `ConvergenceKind`. This function is the single owner of
 * classification — the repository does NOT classify, and no other
 * module re-implements this logic. Each recovery trigger is a
 * named branch so any future addition is a deliberate, named change.
 *
 * The decision tree mirrors the M2 spec:
 *
 *   1. The user has multiple Owner Personal memberships → recovery
 *      ("multiple-personal-workspaces").
 *   2. The pointer is NULL:
 *      - zero Owner Personal memberships → none
 *      - exactly one Owner Personal membership → attachable
 *   3. The pointer is set but no Owner Personal membership resolves
 *      on it → recovery (sub-reason depends on the pointed Workspace
 *      and whether any non-Owner membership exists).
 *   4. The pointer is set and an Owner Personal membership resolves
 *      on it → converged.
 */
export function classifyPersonalWorkspaceState(
  state: PersonalWorkspaceState,
  userAccountId: string,
): ConvergenceKind {
  if (!state.userExists) {
    // Defensive: a missing UserAccount is a programmer error; the
    // auth service must have called createUserForIdentity first.
    // Surface as `none` so the convergence service can re-create.
    return { kind: "none", userAccountId };
  }

  const ownerPersonalMemberships = state.ownerPersonalMemberships;

  // Recovery: multiple Owner Personal memberships.
  if (ownerPersonalMemberships.length > 1) {
    return {
      kind: "recovery",
      userAccountId,
      reason: "multiple-personal-workspaces",
    };
  }

  const pointerId = state.personalWorkspaceId;

  if (pointerId === null) {
    if (ownerPersonalMemberships.length === 0) {
      return { kind: "none", userAccountId };
    }
    // Exactly one Owner Personal membership; the migration left
    // personalWorkspaceId NULL (migration backfill gap, or the row
    // was created after the migration but before the auth service
    // attached it). The convergence service can link it.
    const target = ownerPersonalMemberships[0]!;
    return {
      kind: "attachable",
      userAccountId,
      workspaceId: target.workspaceId,
    };
  }

  // pointerId is set. Locate the matching Owner membership.
  const ownerMembership = ownerPersonalMemberships.find((m) => m.workspaceId === pointerId);

  if (!ownerMembership) {
    const pointed = state.pointedWorkspace;
    if (!pointed) {
      return {
        kind: "recovery",
        userAccountId,
        reason: "pointer-workspace-missing",
      };
    }
    if (pointed.type !== "Personal") {
      return {
        kind: "recovery",
        userAccountId,
        reason: "pointer-not-personal",
      };
    }
    // Pointer exists, is Personal, but the Owner membership is
    // absent. Distinguish membership-with-different-role from
    // owner-membership-missing using the membership-on-pointed read.
    const membershipOnPointed = state.membershipOnPointedWorkspace;
    if (membershipOnPointed && membershipOnPointed.role !== "Owner") {
      return {
        kind: "recovery",
        userAccountId,
        reason: "membership-not-owner",
      };
    }
    return {
      kind: "recovery",
      userAccountId,
      reason: "owner-membership-missing",
    };
  }

  // The user has an Owner membership on the pointed Personal
  // Workspace. Converged.
  return {
    kind: "converged",
    workspaceId: ownerMembership.workspaceId,
    membershipId: ownerMembership.membershipId,
  };
}
