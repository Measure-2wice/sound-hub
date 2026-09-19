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
//
// Per the approved M2 #82 architecture the repository owns
// persistence only — it does NOT classify Personal Workspace state.
// The classification lives in `PersonalWorkspaceConvergenceService`,
// which reads raw state via `findPersonalWorkspaceState` and returns
// the resulting `ConvergenceKind` to higher layers. The repository
// and the convergence service never import from each other; both
// import the shared domain types from
// `apps/api/src/lib/personal-workspace-convergence-domain.ts`.

import type {
  Bg1IdentityProviderV1,
  MarketplaceCapabilityV1,
  WorkspaceMembershipRoleV1,
  WorkspaceStatusV1,
  WorkspaceTypeV1,
} from "@soundhub/types";

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

/**
 * Raw Personal Workspace state for a UserAccount. Returned by
 * `AuthRepository.findPersonalWorkspaceState`. The convergence
 * service classifies this payload into a `ConvergenceKind`; the
 * repository does not classify.
 *
 * Shape:
 *   - `userExists`: false when the UserAccount row is missing (the
 *     caller invariant says this should not happen after identity
 *     resolution, but the repository is defensive).
 *   - `personalWorkspaceId`: the UserAccount's pointer column
 *     (NULL when no linkage is established).
 *   - `ownerPersonalMemberships`: every WorkspaceMembership on this
 *     user where `role === "Owner"` AND the Workspace `type ===`
 *     "Personal". A normal user has at most one entry; zero
 *     entries → "none"; one entry → either "attachable" (if the
 *     pointer is NULL) or "converged" (if the pointer matches).
 *     Multiple entries is a recovery trigger.
 *   - `pointedWorkspace`: the Workspace row pointed at by
 *     `personalWorkspaceId`, or `null` when the pointer is NULL OR
 *     the pointed row is missing. Used by the service to detect
 *     `pointer-workspace-missing` and `pointer-not-personal`.
 *   - `membershipOnPointedWorkspace`: the (id, role) of any
 *     membership this user holds on the pointed Workspace, or
 *     `null`. Used by the service to distinguish
 *     `membership-not-owner` from `owner-membership-missing`.
 */
export interface PersonalWorkspaceState {
  readonly userExists: boolean;
  readonly personalWorkspaceId: string | null;
  readonly ownerPersonalMemberships: ReadonlyArray<{
    readonly membershipId: string;
    readonly workspaceId: string;
  }>;
  readonly pointedWorkspace: { readonly id: string; readonly type: WorkspaceTypeV1 } | null;
  readonly membershipOnPointedWorkspace: {
    readonly id: string;
    readonly role: WorkspaceMembershipRoleV1;
  } | null;
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
   * `ConvergenceRaceError` when the CAS loses to a concurrent
   * transaction; the caller is expected to retry by re-reading via
   * `findPersonalWorkspaceState`.
   *
   * The slug is generated by the server-only pure helper
   * `buildPersonalWorkspaceSlug()` so it is opaque, unique, and
   * contains neither email nor provider subject. The slug identifier
   * is generated independently of the Workspace primary identifier
   * — no authoritative contract requires
   * `slug === "personal-" + workspace.id`.
   *
   * Pre-condition: `personalWorkspaceId` is NULL on the UserAccount
   * (the repository does not re-check this; the caller — the
   * convergence service — classifies first via
   * `findPersonalWorkspaceState`).
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
   * Read the raw Personal Workspace state for the given UserAccount.
   * Returns the data needed to classify the state — the
   * classification itself (and the `ConvergenceKind` decision) lives
   * in the convergence service, NOT the repository. This is a
   * pure read; does not write.
   *
   * The repository owns persistence, not classification. Returning
   * raw state keeps the architecture one-directional (auth service
   * → convergence service → repository primitives) and lets the
   * service re-classify after every CAS retry without reading the
   * database a second time.
   */
  findPersonalWorkspaceState(input: {
    readonly userAccountId: string;
  }): Promise<PersonalWorkspaceState>;

  /**
   * Read the slug for a single Workspace by id. Used by the
   * convergence service's CAS-loss retry path to surface the
   * winner's slug. Returns null when the Workspace is unknown.
   */
  findWorkspaceSlugById(workspaceId: string): Promise<string | null>;
}
