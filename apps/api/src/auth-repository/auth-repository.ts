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
}
