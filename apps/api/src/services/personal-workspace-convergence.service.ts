// Personal Workspace Convergence service (M2 #82).
//
// Background: M2 ticket #82 requires that the first successful
// authentication of any human converges that human onto exactly one
// safe Personal Workspace and exactly one current Owner
// `WorkspaceMembership`, atomically. Returning users reuse the same
// records. Conflicting legacy rows enter an explicit recovery state
// without an acting-Workspace selector being fabricated.
//
// Layering (revised):
//
//   Auth service  →  Convergence service  →  Auth repository (primitives)
//
// - The convergence service decides the kind (`converged | none |
//   attachable | recovery`) and orchestrates the create/attach
//   transactions by calling repository primitives.
// - The repository exposes `createInitialPersonalWorkspace` and
//   `attachExistingPersonalWorkspace` as persistence primitives; it
//   does not decide the kind.
// - The repository does NOT depend on this service. This service does
//   NOT own persistence. The slug helper lives in a separate server-
//   only module (`apps/api/src/lib/personal-workspace-slug.ts`) and
//   is imported only by the repository.
//
// Concurrency invariant:
//
//   The repository's compare-and-set UPDATE on UserAccount.personal-
//   WorkspaceId is the atomic serialization point. The losing
//   transaction throws `ConvergenceRaceError`; the caller retries by
//   re-reading. The `Workspace.slug` UNIQUE constraint is the second
//   defense for the (impossible) cuid collision. The `UserAccount.
//   personalWorkspaceId` UNIQUE constraint is the third defense.
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

import type { AuthRepository } from "../auth-repository/auth-repository.js";

export class ConvergenceRaceError extends Error {
  constructor(message = "Personal Workspace convergence race lost") {
    super(message);
    this.name = "ConvergenceRaceError";
  }
}

/**
 * Server-internal classification of the Personal Workspace state for a
 * UserAccount. `recovery` carries a `reason` so ops can debug, but
 * the reason is NEVER surfaced in the public DTO.
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
        | "multiple-personal-workspaces";
    };

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
   */
  async resolveConvergence(input: { userAccountId: string }): Promise<ConvergenceKind> {
    return this.deps.authRepository.findPersonalWorkspaceConvergence({
      userAccountId: input.userAccountId,
    });
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
