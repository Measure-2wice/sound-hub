// In-memory AuthRepository for unit tests.
//
// Background: the auth service and authorization service tests run
// without a database. The in-memory adapter mirrors the Prisma
// adapter's contract surface so tests can substitute it without
// changing the higher layers. It is intentionally simple — the
// Prisma adapter is the canonical implementation and the
// authorization behaviour under test lives in
// `WorkspaceAuthorizationService`, not here.

import { randomUUID } from "node:crypto";
import type {
  Bg1IdentityProviderV1,
  MarketplaceCapabilityV1,
  WorkspaceMembershipRoleV1,
  WorkspaceStatusV1,
  WorkspaceTypeV1,
} from "@soundhub/types";
import type {
  AuthRepository,
  PublicUserView,
  SessionRecord,
  UserIdentityMapping,
  WorkspaceMembershipView,
} from "./auth-repository.js";

export interface InMemoryMembershipSeed {
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly workspaceType: WorkspaceTypeV1;
  readonly workspaceStatus: WorkspaceStatusV1;
  readonly role: WorkspaceMembershipRoleV1;
  readonly capabilities: readonly MarketplaceCapabilityV1[];
}

export interface InMemoryUserSeed {
  readonly userAccountId: string;
  readonly email?: string | null;
  readonly displayName?: string | null;
  readonly identityProvider: Bg1IdentityProviderV1;
  readonly identitySubject: string;
  readonly memberships: readonly InMemoryMembershipSeed[];
}

export class InMemoryAuthRepository implements AuthRepository {
  private readonly usersByIdentity = new Map<string, UserIdentityMapping>();
  private readonly usersById = new Map<string, PublicUserView>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly membershipsByUserWorkspace = new Map<string, WorkspaceMembershipView>();
  private readonly nowFn: () => number;

  constructor(seeds: readonly InMemoryUserSeed[] = [], now: () => number = () => Date.now()) {
    this.nowFn = now;
    for (const seed of seeds) {
      const mapping: UserIdentityMapping = {
        provider: seed.identityProvider,
        subject: seed.identitySubject,
        providerEmail: seed.email ?? null,
        userAccountId: seed.userAccountId,
      };
      this.usersByIdentity.set(`${seed.identityProvider}|${seed.identitySubject}`, mapping);
      this.usersById.set(seed.userAccountId, {
        userAccountId: seed.userAccountId,
        email: seed.email ?? null,
        displayName: seed.displayName ?? null,
        identityProvider: seed.identityProvider,
        identitySubject: seed.identitySubject,
        workspaces: seed.memberships.map((m) => this.toMembershipView(m)),
      });
      for (const m of seed.memberships) {
        this.membershipsByUserWorkspace.set(
          `${seed.userAccountId}|${m.workspaceId}`,
          this.toMembershipView(m),
        );
      }
    }
  }

  async findUserByIdentity(input: {
    provider: Bg1IdentityProviderV1;
    subject: string;
  }): Promise<UserIdentityMapping | null> {
    return Promise.resolve(this.usersByIdentity.get(`${input.provider}|${input.subject}`) ?? null);
  }

  async createUserForIdentity(input: {
    provider: Bg1IdentityProviderV1;
    subject: string;
    providerEmail: string | null;
  }): Promise<UserIdentityMapping> {
    const existing = await this.findUserByIdentity(input);
    if (existing) return existing;
    const userAccountId = randomUUID();
    const mapping: UserIdentityMapping = {
      provider: input.provider,
      subject: input.subject,
      providerEmail: input.providerEmail,
      userAccountId,
    };
    this.usersByIdentity.set(`${input.provider}|${input.subject}`, mapping);
    this.usersById.set(userAccountId, {
      userAccountId,
      email: input.providerEmail,
      displayName: null,
      identityProvider: input.provider,
      identitySubject: input.subject,
      workspaces: [],
    });
    return mapping;
  }

  async getPublicUser(userAccountId: string): Promise<PublicUserView | null> {
    return Promise.resolve(this.usersById.get(userAccountId) ?? null);
  }

  async getActiveSession(sessionId: string): Promise<SessionRecord | null> {
    const row = this.sessions.get(sessionId);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= this.nowFn()) return null;
    return Promise.resolve(row);
  }

  async createSession(input: { userAccountId: string; expiresAt: Date }): Promise<SessionRecord> {
    const id = randomUUID();
    const row: SessionRecord = {
      sessionId: id,
      userAccountId: input.userAccountId,
      createdAt: new Date(this.nowFn()),
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.set(id, row);
    return Promise.resolve(row);
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const row = this.sessions.get(sessionId);
    if (!row) return false;
    if (row.revokedAt) return false;
    this.sessions.set(sessionId, { ...row, revokedAt: new Date(this.nowFn()) });
    return Promise.resolve(true);
  }

  async findCurrentMembership(input: {
    userAccountId: string;
    workspaceId: string;
  }): Promise<WorkspaceMembershipView | null> {
    return Promise.resolve(
      this.membershipsByUserWorkspace.get(`${input.userAccountId}|${input.workspaceId}`) ?? null,
    );
  }

  private toMembershipView(m: InMemoryMembershipSeed): WorkspaceMembershipView {
    return {
      workspaceId: m.workspaceId,
      slug: m.slug,
      name: m.name,
      workspaceType: m.workspaceType,
      workspaceStatus: m.workspaceStatus,
      capabilities: [...m.capabilities],
      role: m.role,
      joinedAt: new Date(this.nowFn()),
    };
  }
}
