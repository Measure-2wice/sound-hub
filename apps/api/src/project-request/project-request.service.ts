// ProjectRequest service (BG4).
//
// Background: ticket #62 requires a single application boundary that
// owns the buyer-side ProjectRequest creation, the seller-side
// accept/decline, and the eligibility revalidation that protects
// against stale selections (GS 16). The service threads:
//   - authenticated human + acting Workspace authorization
//   - persisted ProjectBrief ownership / current membership
//   - eligibility revalidation of the selected ServiceOffering
//     (workspace active + Seller capability + SellerProfile Published
//     + ServiceOffering Active + ownership — i.e. the offering
//     belongs to the seller Workspace the buyer is addressing)
//   - repository persistence with natural uniqueness + guarded
//     state transitions
//   - atomic Deal creation on accept
//
// The service is the only layer that knows the domain rules. The
// route layer translates the typed errors into the safe envelope;
// the repository layer owns the SQL boundary.

import type { PrismaClient } from "@soundhub/db";
import type {
  CreateProjectRequestRequestV1,
  ProjectRequestPublicV1,
  DealPublicV1,
} from "@soundhub/types";
import type {
  ProjectBriefRepository,
  PersistedBrief,
} from "../matchmaker/project-brief.repository.js";
import {
  type ActingMembership,
  type WorkspaceAuthorizationService,
} from "../services/workspace-authorization.service.js";
import type {
  ProjectRequestRepository,
  PersistedProjectRequest,
  PersistedDeal,
} from "./project-request.repository.js";
import { PendingDuplicateError } from "./prisma-project-request.repository.js";

export class ProjectRequestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PROJECT_REQUEST_INVALID"
      | "PROJECT_REQUEST_BRIEF_NOT_FOUND"
      | "PROJECT_REQUEST_BRIEF_FORBIDDEN"
      | "PROJECT_REQUEST_OFFERING_INELIGIBLE"
      | "PROJECT_REQUEST_NOT_FOUND"
      | "PROJECT_REQUEST_FORBIDDEN"
      | "PROJECT_REQUEST_ALREADY_PENDING"
      | "PROJECT_REQUEST_ALREADY_RESPONDED",
  ) {
    super(message);
    this.name = "ProjectRequestError";
  }
}

export interface ProjectRequestServiceDeps {
  readonly projectRequestRepository: ProjectRequestRepository;
  readonly projectBriefRepository: ProjectBriefRepository;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  /**
   * Prisma is passed only so the eligibility-revalidation step can
   * look up current Workspace / SellerProfile / ServiceOffering rows
   * in a single transaction. The service never exposes Prisma models
   * to the route layer.
   */
  readonly prisma: PrismaClient;
  /**
   * Optional clock injection for tests. Defaults to `new Date()`.
   */
  readonly now?: () => Date;
}

export interface CreateProjectRequestInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly projectBriefId: string;
  readonly serviceOfferingId: string;
}

export interface AcceptProjectRequestInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly projectRequestId: string;
}

export interface DeclineProjectRequestInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly projectRequestId: string;
}

export interface GetProjectRequestInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly projectRequestId: string;
}

export interface ListProjectRequestsInput {
  readonly userAccountId: string;
  readonly actingWorkspaceId: string;
  readonly statusFilter?: "Pending" | "Accepted" | "Declined";
}

export class ProjectRequestService {
  private readonly repository: ProjectRequestRepository;
  private readonly briefs: ProjectBriefRepository;
  private readonly authz: WorkspaceAuthorizationService;
  private readonly prisma: PrismaClient;
  private readonly now: () => Date;

  constructor(deps: ProjectRequestServiceDeps) {
    this.repository = deps.projectRequestRepository;
    this.briefs = deps.projectBriefRepository;
    this.authz = deps.workspaceAuthorizationService;
    this.prisma = deps.prisma;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Create a Pending ProjectRequest owned by the acting Buyer
   * Workspace.
   *
   * Sequence (ticket #62 acceptance criteria):
   *   1. Revalidate the acting Workspace has current Buyer-capable
   *      membership (GS 4 / GS 5 / GS 6).
   *   2. Load the persisted ProjectBrief; revalidate the buyer
   *      Workspace owns it (i.e. the brief was created by a current
   *      member of the same Workspace).
   *   3. Revalidate the selected ServiceOffering against current
   *      eligibility (Workspace active + Seller capability +
   *      SellerProfile Published + ServiceOffering Active +
   *      offering-owned-by-seller-Workspace).
   *   4. Persist a Pending ProjectRequest; the partial unique
   *      index catches inappropriate retries.
   *   5. Return the public DTO.
   */
  async createProjectRequest(input: CreateProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    // Step 1: Buyer-side authorization.
    const membership = await this.authz.requireCapability({
      userAccountId: input.userAccountId,
      workspaceId: input.actingWorkspaceId,
      requiredCapability: "Buyer",
    });

    // Step 2: Brief ownership and current Buyer-membership
    // revalidation (membership was already revalidated in
    // requireCapability; we still need to prove the brief belongs
    // to the buyer Workspace so a buyer cannot address another
    // Workspace's brief).
    const brief = await this.briefs.findBriefById(input.projectBriefId);
    if (!brief) {
      throw new ProjectRequestError("ProjectBrief not found.", "PROJECT_REQUEST_BRIEF_NOT_FOUND");
    }
    if (brief.buyerWorkspaceId !== membership.workspace.workspaceId) {
      throw new ProjectRequestError(
        "ProjectBrief does not belong to this Workspace.",
        "PROJECT_REQUEST_BRIEF_FORBIDDEN",
      );
    }

    // Step 3: Eligibility revalidation of the selected offering.
    const offering = await this.loadOfferingEligibility(input.serviceOfferingId);
    if (!offering) {
      // Either the offering no longer exists OR it is not Active.
      // Both surface as OFFERING_INELIGIBLE so the buyer is told
      // the selection is stale without leaking whether the row
      // exists.
      throw new ProjectRequestError(
        "The selected ServiceOffering is no longer eligible.",
        "PROJECT_REQUEST_OFFERING_INELIGIBLE",
      );
    }

    // Cross-check: the buyer is addressing the seller Workspace
    // that owns the offering. A buyer cannot address an offering
    // owned by a different Workspace even if all other eligibility
    // conditions hold. This is already implicit in the
    // loadOfferingEligibility lookup (we resolve the offering's
    // owning workspace from the database row), so this block is a
    // no-op gate today; the comment documents intent so future
    // revalidation logic does not introduce a regression.
    void offering;

    // Step 4: Persist.
    let persisted: PersistedProjectRequest;
    try {
      persisted = await this.repository.createProjectRequest({
        buyerWorkspaceId: membership.workspace.workspaceId,
        sellerWorkspaceId: offering.sellerWorkspaceId,
        serviceOfferingId: offering.id,
        projectBriefId: brief.id,
        createdByUserId: input.userAccountId,
      });
    } catch (err) {
      if (err instanceof PendingDuplicateError) {
        throw new ProjectRequestError(
          "A Pending ProjectRequest already exists for this selection.",
          "PROJECT_REQUEST_ALREADY_PENDING",
        );
      }
      throw err;
    }

    return { projectRequest: toPublicProjectRequest(persisted) };
  }

  /**
   * Accept a Pending ProjectRequest as the seller. Atomically
   * transitions Pending→Accepted AND creates exactly one
   * Negotiating Deal (ticket #62 acceptance criteria + GS 18 +
   * GS 26).
   */
  async acceptProjectRequest(input: AcceptProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
    readonly deal: DealPublicV1;
  }> {
    const existing = await this.repository.findProjectRequestById(input.projectRequestId);
    if (!existing) {
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    // Membership revalidation against the seller Workspace (GS 17 —
    // only an authorized seller member may accept).
    const sellerMembership = await this.requireSellerMembership(input, existing);

    const result = await this.repository.acceptProjectRequest({
      projectRequestId: existing.id,
      sellerDecisionByUserId: sellerMembership.userAccountId,
      now: this.now(),
    });
    if (!result.ok) {
      throw this.decideErrorToServiceError(result.reason);
    }
    return {
      projectRequest: toPublicProjectRequest(result.value.projectRequest),
      deal: toPublicDeal(result.value.deal),
    };
  }

  /**
   * Decline a Pending ProjectRequest as the seller. Terminal;
   * creates no Deal (GS 18).
   */
  async declineProjectRequest(input: DeclineProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    const existing = await this.repository.findProjectRequestById(input.projectRequestId);
    if (!existing) {
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    const sellerMembership = await this.requireSellerMembership(input, existing);

    const result = await this.repository.declineProjectRequest({
      projectRequestId: existing.id,
      sellerDecisionByUserId: sellerMembership.userAccountId,
      now: this.now(),
    });
    if (!result.ok) {
      throw this.decideErrorToServiceError(result.reason);
    }
    return { projectRequest: toPublicProjectRequest(result.value) };
  }

  /**
   * Fetch one ProjectRequest. Either side (buyer or seller
   * Workspace) may view it; the route revalidates membership via
   * the service so a revoked member loses access immediately.
   */
  async getProjectRequest(input: GetProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    const existing = await this.repository.findProjectRequestById(input.projectRequestId);
    if (!existing) {
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    if (
      existing.buyerWorkspaceId !== input.actingWorkspaceId &&
      existing.sellerWorkspaceId !== input.actingWorkspaceId
    ) {
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    await this.authz.requireActingMembership({
      userAccountId: input.userAccountId,
      workspaceId: input.actingWorkspaceId,
    });
    return { projectRequest: toPublicProjectRequest(existing) };
  }

  /**
   * List ProjectRequests for an acting Workspace (both sides). The
   * route can pass `statusFilter` to scope the inbox to Pending
   * requests only.
   */
  async listProjectRequests(input: ListProjectRequestsInput): Promise<{
    readonly projectRequests: readonly ProjectRequestPublicV1[];
  }> {
    await this.authz.requireActingMembership({
      userAccountId: input.userAccountId,
      workspaceId: input.actingWorkspaceId,
    });
    const rows = await this.repository.listProjectRequests({
      workspaceId: input.actingWorkspaceId,
      ...(input.statusFilter ? { statusFilter: input.statusFilter } : {}),
    });
    return {
      projectRequests: rows.map(toPublicProjectRequest),
    };
  }

  /**
   * Revalidate that the calling user is a current member of the
   * seller Workspace. WS ownerUserId and any non-membership paths
   * fail closed with NOT_A_MEMBER; the route maps that to
   * PROJECT_REQUEST_FORBIDDEN.
   */
  private async requireSellerMembership(
    input: AcceptProjectRequestInput | DeclineProjectRequestInput,
    existing: PersistedProjectRequest,
  ): Promise<{ readonly membership: ActingMembership; readonly userAccountId: string }> {
    if (existing.sellerWorkspaceId !== input.actingWorkspaceId) {
      // The actor claimed a different acting Workspace. Reject
      // before touching the row.
      throw new ProjectRequestError(
        "You are not authorized to respond to this ProjectRequest.",
        "PROJECT_REQUEST_FORBIDDEN",
      );
    }
    const membership = await this.authz.requireActingMembership({
      userAccountId: input.userAccountId,
      workspaceId: input.actingWorkspaceId,
    });
    return { membership, userAccountId: input.userAccountId };
  }

  /**
   * Single-row eligibility revalidation. The service loads the
   * Workspace, SellerProfile, and ServiceOffering in one round-trip
   * and applies the M1 eligibility filter (Active workspace +
   * Seller capability + Published profile + Active offering).
   */
  private async loadOfferingEligibility(serviceOfferingId: string): Promise<{
    readonly id: string;
    readonly status: string;
    readonly sellerWorkspaceId: string;
    readonly workspaceStatus: string;
    readonly workspaceHasSellerCapability: boolean;
    readonly profileStatus: string;
  } | null> {
    const row = await this.prisma.serviceOffering.findUnique({
      where: { id: serviceOfferingId },
      include: {
        sellerProfile: {
          include: {
            workspace: {
              include: { capabilities: true },
            },
          },
        },
      },
    });
    if (!row) return null;
    if (row.status !== "Active") return null;
    if (row.sellerProfile.status !== "Published") return null;
    if (row.sellerProfile.workspace.status !== "Active") return null;
    const hasSeller = row.sellerProfile.workspace.capabilities.some(
      (c) => c.capability === "Seller",
    );
    if (!hasSeller) return null;
    return {
      id: row.id,
      status: row.status,
      sellerWorkspaceId: row.sellerProfile.workspace.id,
      workspaceStatus: row.sellerProfile.workspace.status,
      workspaceHasSellerCapability: hasSeller,
      profileStatus: row.sellerProfile.status,
    };
  }

  private decideErrorToServiceError(
    reason: "NOT_FOUND" | "ALREADY_RESPONDED",
  ): ProjectRequestError {
    if (reason === "NOT_FOUND") {
      return new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    return new ProjectRequestError(
      "This ProjectRequest has already been responded to.",
      "PROJECT_REQUEST_ALREADY_RESPONDED",
    );
  }
}

// ---------- DTO mapping ----------

export function toPublicProjectRequest(persisted: PersistedProjectRequest): ProjectRequestPublicV1 {
  return {
    projectRequestId: persisted.id,
    buyerWorkspaceId: persisted.buyerWorkspaceId,
    sellerWorkspaceId: persisted.sellerWorkspaceId,
    serviceOfferingId: persisted.serviceOfferingId,
    projectBriefId: persisted.projectBriefId,
    createdByUserId: persisted.createdByUserId,
    status: persisted.status,
    sellerDecisionAt: persisted.sellerDecisionAt ? persisted.sellerDecisionAt.toISOString() : null,
    sellerDecisionByUserId: persisted.sellerDecisionByUserId,
    sellerConsentAt: persisted.sellerConsentAt ? persisted.sellerConsentAt.toISOString() : null,
    createdAt: persisted.createdAt.toISOString(),
  };
}

export function toPublicDeal(persisted: PersistedDeal): DealPublicV1 {
  return {
    dealId: persisted.id,
    buyerWorkspaceId: persisted.buyerWorkspaceId,
    sellerWorkspaceId: persisted.sellerWorkspaceId,
    serviceOfferingId: persisted.serviceOfferingId,
    projectBriefId: persisted.projectBriefId,
    projectRequestId: persisted.projectRequestId,
    status: persisted.status,
    activatedAt: persisted.activatedAt ? persisted.activatedAt.toISOString() : null,
    createdAt: persisted.createdAt.toISOString(),
  };
}

// Re-export the AuthorizationError so the route layer can
// distinguish between ProjectRequestError and an upstream
// authorization failure without re-importing it.
// Allow the route to consume the request type directly so the
// import graph stays small.
export type { CreateProjectRequestRequestV1 };
// Allow the ProjectBriefRepository type to be re-imported from this
// module so the route file does not need to know its path.
export type { PersistedBrief };
