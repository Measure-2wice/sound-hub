// Auth repository contract.
//
// Background: BG1 requires a persistence boundary for identity
// (UserAccount + IdentityProvider) and session (AuthSession) records
// that lives below adapters and services. The contract here is the
// only surface those layers depend on; the Prisma adapter
// implements it and is the only module that touches the database
// directly.
//
// Per ADR 0004 the repository is the single owner of the
// (provider, subject) → UserAccount mapping. Identity adapters return
// only the (provider, subject) tuple; the repository is responsible
// for the durable lookup-or-create semantics.

import type {
  Bg1IdentityProviderV1,
  MarketplaceCapabilityV1,
  WorkspaceMembershipRoleV1,
  WorkspaceStatusV1,
  WorkspaceTypeV1,
} from "@soundhub/types";
import type { ConvergenceKind } from "../services/personal-workspace-convergence.service.js";

export interface UserIdentityMapping {
  readonly provider: Bg1IdentityProviderV1;
  readonly subject: string;
  readonly providerEmail: string | null;
  readonly userAccountId: string;
}

export interface WorkspaceMembershipView {
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly workspaceType: WorkspaceTypeV1;
  readonly workspaceStatus: WorkspaceStatusV1;
  readonly capabilities: readonly MarketplaceCapabilityV1[];
  readonly role: WorkspaceMembershipRoleV1;
  readonly joinedAt: Date;
}

export interface PublicUserView {
  readonly userAccountId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly identityProvider: Bg1IdentityProviderV1;
  readonly identitySubject: string;
  readonly workspaces: readonly WorkspaceMembershipView[];
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly userAccountId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface AuthRepository {
  /**
   * Resolve the (provider, subject) tuple to the durable UserAccount.
   * Returns `null` when no mapping exists yet (first sign-in for
   * this provider subject).
   */
  findUserByIdentity(input: {
    readonly provider: Bg1IdentityProviderV1;
    readonly subject: string;
  }): Promise<UserIdentityMapping | null>;

  /**
   * First-sign-in path. Creates a UserAccount (no email if the
   * provider does not surface one) and an IdentityProvider row. The
   * (provider, subject) tuple is unique; a concurrent call cannot
   * create a duplicate.
   */
  createUserForIdentity(input: {
    readonly provider: Bg1IdentityProviderV1;
    readonly subject: string;
    readonly providerEmail: string | null;
  }): Promise<UserIdentityMapping>;

  /**
   * Load the full public user view (UserAccount + workspaces +
   * capabilities + membership role) for `GET /api/auth/me`. Returns
   * `null` when the UserAccount was deleted (race with the cascade
   * delete on a session-revoke edge).
   */
  getPublicUser(userAccountId: string): Promise<PublicUserView | null>;

  /**
   * Look up a single current (non-revoked, non-expired) session.
   * Returns `null` for unknown, revoked, or expired session ids.
   */
  getActiveSession(sessionId: string): Promise<SessionRecord | null>;

  /**
   * Issue a new server-side session for the user. The returned
   * `sessionId` is opaque and only the API knows how to resolve it.
   */
  createSession(input: {
    readonly userAccountId: string;
    readonly expiresAt: Date;
  }): Promise<SessionRecord>;

  /**
   * Revoke an existing session. Idempotent: revoking an already-
   * revoked session is a no-op. Returns whether the row was found.
   */
  revokeSession(sessionId: string): Promise<boolean>;

  /**
   * Look up the current WorkspaceMembership for a (user, workspace)
   * pair. Returns `null` when no membership exists. This is the only
   * authority read the WorkspaceAuthorizationService uses — the
   * legacy `Workspace.ownerUserId` is intentionally not consulted.
   */
  findCurrentMembership(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
  }): Promise<WorkspaceMembershipView | null>;

  // ---------- M2 #82: Personal Workspace convergence primitives ----------

  /**
   * First-auth path: atomically create a Personal Workspace + Owner
   * `WorkspaceMembership` for the given UserAccount and link it via
   * the compare-and-set UPDATE on `UserAccount.personalWorkspaceId`.
   *
   * Returns the new Workspace id and slug. Throws
   * `ConvergenceRaceError` (defined in
   * `personal-workspace-convergence.service.ts`) when the CAS loses
   * to a concurrent transaction; the caller is expected to retry by
   * re-reading via `findPersonalWorkspaceConvergence`.
   *
   * The slug is generated from the Workspace's primary identifier
   * (server-only pure helper) so it is opaque, unique, and contains
   * neither email nor provider subject.
   *
   * Pre-condition: `personalWorkspaceId` is NULL on the UserAccount
   * (the repository does not re-check this; the caller — the
   * convergence service — classifies first via
   * `findPersonalWorkspaceConvergence`).
   */
  createInitialPersonalWorkspace(input: {
    readonly userAccountId: string;
  }): Promise<{ readonly workspaceId: string; readonly slug: string }>;

  /**
   * Backfill-gap path: link an existing Personal Workspace + Owner
   * membership to the UserAccount via compare-and-set. Used when the
   * migration left `personalWorkspaceId` NULL because the row had no
   * candidate OR (defensively) when the migration failed mid-flight.
   *
   * Throws `ConvergenceRaceError` when the CAS loses.
   *
   * Pre-condition: the (userAccountId, workspaceId) pair has an
   * existing Owner Personal Workspace membership; `personalWorkspaceId`
   * is NULL.
   */
  attachExistingPersonalWorkspace(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
  }): Promise<void>;

  /**
   * Classify the Personal Workspace state for the given UserAccount.
   * Returns one of four `ConvergenceKind` variants (defined in
   * `personal-workspace-convergence.service.ts`):
   *   - `converged`: pointer is set and the Owner membership resolves.
   *   - `none`: pointer is NULL and zero Owner Personal memberships.
   *   - `attachable`: pointer is NULL and exactly one Owner Personal
   *     membership exists (migration gap).
   *   - `recovery`: any of the six broken states (see service doc).
   *
   * Pure read — does not write.
   */
  findPersonalWorkspaceConvergence(input: {
    readonly userAccountId: string;
  }): Promise<ConvergenceKind>;

  /**
   * Read the slug for a single Workspace by id. Used by the
   * convergence service's CAS-loss retry path to surface the
   * winner's slug. Returns null when the Workspace is unknown.
   */
  findWorkspaceSlugById(workspaceId: string): Promise<string | null>;
}
