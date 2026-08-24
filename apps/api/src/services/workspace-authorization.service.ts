// Workspace authorization service.
//
// Background: BG1 requires a reusable current-membership
// authorization service for every consequential command. Per the
// ticket:
//
//   GS 4 — every Golden Slice command names an acting Workspace
//          and rejects a human without current qualifying membership.
//   GS 5 — a matching legacy `Workspace.ownerUserId` grants no
//          authority without current membership.
//   GS 6 — buyer/seller Workspaces, capabilities, and memberships
//          are persisted (identity/authority foundation only; BG5
//          owns the DealApprover portion).
//
// This service is the single owner of those rules. The route
// handlers call `requireActingMembership(...)` for every
// consequential command and propagate the error code through the
// safe envelope; the legacy `Workspace.ownerUserId` column is
// intentionally never consulted.

import type {
  Bg1PublicWorkspaceV1,
  MarketplaceCapabilityV1,
  WorkspaceMembershipRoleV1,
  WorkspaceStatusV1,
} from "@soundhub/types";
import type {
  AuthRepository,
  WorkspaceMembershipView,
} from "../auth-repository/auth-repository.js";

export class AuthorizationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "WORKSPACE_NOT_FOUND"
      | "WORKSPACE_INELIGIBLE"
      | "NOT_A_MEMBER"
      | "MISSING_CAPABILITY",
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface ActingMembership {
  readonly workspace: Bg1PublicWorkspaceV1;
  readonly role: WorkspaceMembershipRoleV1;
  readonly capabilities: readonly MarketplaceCapabilityV1[];
  readonly joinedAt: Date;
}

export interface WorkspaceAuthorizationServiceDeps {
  readonly authRepository: AuthRepository;
}

export class WorkspaceAuthorizationService {
  constructor(private readonly deps: WorkspaceAuthorizationServiceDeps) {}

  /**
   * Look up the (user, workspace) current WorkspaceMembership. Throws
   * an `AuthorizationError` whose `code` matches the GS 4 / GS 5
   * contract. The legacy `Workspace.ownerUserId` is never read; a
   * matching legacy owner without a current membership fails this
   * call with `NOT_A_MEMBER`, proving the GS 5 invariant.
   */
  async requireActingMembership(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
  }): Promise<ActingMembership> {
    const membership = await this.deps.authRepository.findCurrentMembership({
      userAccountId: input.userAccountId,
      workspaceId: input.workspaceId,
    });
    if (!membership) {
      // The user has no current membership row. This branch covers
      // both the GS 4 case (no membership ever existed) and the
      // GS 5 case (legacy ownerUserId without current membership).
      throw new AuthorizationError(
        "You are not a current member of this Workspace.",
        "NOT_A_MEMBER",
      );
    }
    if (membership.workspaceStatus !== ("Active" as WorkspaceStatusV1)) {
      throw new AuthorizationError(
        "This Workspace is not eligible to act in the marketplace.",
        "WORKSPACE_INELIGIBLE",
      );
    }
    return {
      workspace: toPublicWorkspace(membership),
      role: membership.role,
      capabilities: membership.capabilities,
      joinedAt: membership.joinedAt,
    };
  }

  /**
   * Convenience for routes that need both a current membership and
   * a specific capability. The membership lookup is performed once;
   * the capability check is a pure predicate on the result so a
   * revoked membership still fails with `NOT_A_MEMBER` (not
   * `MISSING_CAPABILITY`), matching the documented GS 4 priority.
   */
  async requireCapability(input: {
    readonly userAccountId: string;
    readonly workspaceId: string;
    readonly requiredCapability: MarketplaceCapabilityV1;
  }): Promise<ActingMembership> {
    const membership = await this.requireActingMembership(input);
    if (!membership.capabilities.includes(input.requiredCapability)) {
      throw new AuthorizationError(
        `This Workspace does not have the ${input.requiredCapability} capability.`,
        "MISSING_CAPABILITY",
      );
    }
    return membership;
  }
}

function toPublicWorkspace(view: WorkspaceMembershipView): Bg1PublicWorkspaceV1 {
  return {
    workspaceId: view.workspaceId,
    slug: view.slug,
    name: view.name,
    workspaceType: view.workspaceType,
    workspaceStatus: view.workspaceStatus,
    capabilities: [...view.capabilities],
  };
}
