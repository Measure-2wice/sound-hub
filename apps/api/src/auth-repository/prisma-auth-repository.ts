// Prisma adapter for the AuthRepository contract.
//
// Background: this module is the only place the auth boundary touches
// Prisma. Higher layers depend on `AuthRepository`; tests can swap in
// the in-memory adapter without changing the route or service code.
//
// ADR 0004: the (provider, subject) → UserAccount mapping is canonical
// here. The legacy `Workspace.ownerUserId` column is intentionally not
// read by the authorization path (see `WorkspaceAuthorizationService`)
// — it remains in the schema for M1.1 backward compatibility but
// grants no authority in any Golden Slice command.

import type { PrismaClient } from "@soundhub/db";
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

const BG1_PROVIDER_KEYS: ReadonlySet<Bg1IdentityProviderV1> = new Set([
  "managed-magic-link",
  "deterministic",
]);

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findUserByIdentity(input: {
    readonly provider: Bg1IdentityProviderV1;
    readonly subject: string;
  }): Promise<UserIdentityMapping | null> {
    assertBg1Provider(input.provider);
    const row = await this.prisma.identityProvider.findUnique({
      where: { provider_subject: { provider: input.provider, subject: input.subject } },
    });
    if (!row) return null;
    return {
      provider: input.provider,
      subject: input.subject,
      providerEmail: row.providerEmail,
      userAccountId: row.userAccountId,
    };
  }

  async createUserForIdentity(input: {
    readonly provider: Bg1IdentityProviderV1;
    readonly subject: string;
    readonly providerEmail: string | null;
  }): Promise<UserIdentityMapping> {
    assertBg1Provider(input.provider);
    // The (provider, subject) tuple is unique; if a concurrent request
    // already created the mapping, we surface the existing row rather
    // than racing a duplicate insert. This is the durable lookup-or-
    // create semantics the BG1 ticket requires.
    const existing = await this.findUserByIdentity(input);
    if (existing) return existing;

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.userAccount.create({
        data: {
          // The primary email column is nullable since BG1; we only
          // populate it when the provider surfaces one. The
          // @unique constraint still enforces single SoundHub email
          // when present.
          email: input.providerEmail,
        },
      });
      await tx.identityProvider.create({
        data: {
          provider: input.provider,
          subject: input.subject,
          providerEmail: input.providerEmail,
          userAccountId: user.id,
        },
      });
      return {
        provider: input.provider,
        subject: input.subject,
        providerEmail: input.providerEmail,
        userAccountId: user.id,
      };
    });
  }

  async getPublicUser(userAccountId: string): Promise<PublicUserView | null> {
    const user = await this.prisma.userAccount.findUnique({
      where: { id: userAccountId },
      include: {
        identityProviders: { orderBy: { createdAt: "asc" } },
        memberships: {
          include: {
            workspace: {
              include: { capabilities: { orderBy: { capability: "asc" } } },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!user) return null;
    // Per BG1 contract, we surface the first (provider, subject)
    // mapping as the canonical identity. Multiple providers may
    // map to one UserAccount (e.g. a deterministic dev mapping +
    // a managed production mapping for the same human), but the
    // session is bound to one provider at a time so the contract
    // surfaces only that mapping.
    const identity = user.identityProviders[0];
    if (!identity) {
      // A UserAccount without an identity provider mapping cannot
      // exist via the supported flows; surface the user as null so
      // the route produces the same 404 envelope rather than
      // leaking the inconsistency.
      return null;
    }
    if (!isBg1Provider(identity.provider)) {
      // Migrations or hand-edited rows could leave a non-BG1
      // provider key behind; reject rather than leak it.
      return null;
    }
    return {
      userAccountId: user.id,
      email: user.email,
      displayName: null,
      identityProvider: identity.provider,
      identitySubject: identity.subject,
      workspaces: user.memberships.map((membership) => ({
        workspaceId: membership.workspace.id,
        slug: membership.workspace.slug,
        name: membership.workspace.name,
        workspaceType: membership.workspace.type,
        workspaceStatus: membership.workspace.status,
        capabilities: membership.workspace.capabilities.map((c) => c.capability),
        role: membership.role,
        joinedAt: membership.createdAt,
      })),
    };
  }

  async getActiveSession(sessionId: string): Promise<SessionRecord | null> {
    const row = await this.prisma.authSession.findUnique({ where: { id: sessionId } });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return {
      sessionId: row.id,
      userAccountId: row.userAccountId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async createSession(input: { userAccountId: string; expiresAt: Date }): Promise<SessionRecord> {
    const row = await this.prisma.authSession.create({
      data: {
        userAccountId: input.userAccountId,
        expiresAt: input.expiresAt,
      },
    });
    return {
      sessionId: row.id,
      userAccountId: row.userAccountId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async revokeSession(sessionId: string): Promise<boolean> {
    const result = await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }

  async findCurrentMembership(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
  }): Promise<WorkspaceMembershipView | null> {
    const row = await this.prisma.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId: input.userAccountId,
          workspaceId: input.workspaceId,
        },
      },
      include: {
        workspace: {
          include: { capabilities: { orderBy: { capability: "asc" } } },
        },
      },
    });
    if (!row) return null;
    return {
      workspaceId: row.workspace.id,
      slug: row.workspace.slug,
      name: row.workspace.name,
      workspaceType: row.workspace.type,
      workspaceStatus: row.workspace.status,
      capabilities: row.workspace.capabilities.map((c) => c.capability),
      role: row.role,
      joinedAt: row.createdAt,
    };
  }
}

function assertBg1Provider(provider: string): asserts provider is Bg1IdentityProviderV1 {
  if (!isBg1Provider(provider)) {
    throw new Error(
      `Identity provider "${provider}" is not declared in the BG1 contract; refusing to persist`,
    );
  }
}

function isBg1Provider(provider: string): provider is Bg1IdentityProviderV1 {
  return BG1_PROVIDER_KEYS.has(provider as Bg1IdentityProviderV1);
}

// Type-only re-exports for higher layers that want to consume the
// specific view types without re-importing them. Keeps the file
// self-contained without forcing callers to know the path layout.
export type {
  PublicUserView,
  SessionRecord,
  UserIdentityMapping,
  WorkspaceMembershipView,
  MarketplaceCapabilityV1,
  WorkspaceMembershipRoleV1,
  WorkspaceStatusV1,
  WorkspaceTypeV1,
};
