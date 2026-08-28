// ProjectRequest service (BG4).
//
// Background: ticket #62 requires a single application boundary that
// owns the buyer-side ProjectRequest creation, the seller-side
// accept/decline, and the eligibility revalidation that protects
// against stale selections (GS 16). The service threads:
//   - authenticated human + acting Workspace authorization
//     (the policy decision — the application owns authorization)
//   - eligibility revalidation of the selected ServiceOffering
//     (workspace active + Seller capability + SellerProfile Published
//     + ServiceOffering Active + ownership — i.e. the offering
//     belongs to the seller Workspace the buyer is addressing)
//   - repository persistence with natural uniqueness + guarded
//     state transitions
//   - atomic Deal creation on accept
//
// The service is the only layer that knows the domain rules. The
// route layer translates the typed errors into the safe envelope.
// The repository layer owns persistence + transactions only — the
// service makes the authorization policy decision BEFORE calling
// the repository. The repository's transaction is the atomic guard
// for the brief-ownership, brief-recommendation, and offering
// eligibility facts, and the natural uniqueness constraint plus
// guarded state transitions provide the retry-safety contract
// required by ticket #62 (GS 26).

import type {
  CreateProjectRequestRequestV1,
  ProjectRequestPublicV1,
  DealPublicV1,
} from "@soundhub/types";
import type { PersistedBrief } from "../matchmaker/project-brief.repository.js";
import { type WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import type {
  ProjectRequestRepository,
  CreateProjectRequestFailureReason,
  PersistedProjectRequest,
  PersistedDeal,
} from "./project-request.repository.js";

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
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
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
  private readonly authz: WorkspaceAuthorizationService;
  private readonly now: () => Date;

  constructor(deps: ProjectRequestServiceDeps) {
    this.repository = deps.projectRequestRepository;
    this.authz = deps.workspaceAuthorizationService;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Create a Pending ProjectRequest owned by the acting Buyer
   * Workspace.
   *
   * Sequence (ticket #62 acceptance criteria):
   *   1. Revalidate the acting Workspace has current Buyer-capable
   *      membership (GS 4 / GS 5 / GS 6).
   *   2. Delegate the brief-ownership / brief-recommendation (P1-001)
   *      / offering-eligibility revalidation AND the INSERT to the
   *      repository, which runs the entire operation inside one
   *      `$transaction` (P1-002). The service has no Prisma
   *      dependency (P1-003).
   *   3. Map the repository's discriminated-union failure reasons to
   *      typed ProjectRequestError values so the route layer can map
   *      them to the buyer-safe envelope.
   *   4. Return the public DTO.
   */
  async createProjectRequest(input: CreateProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    // The application owns the authorization policy. The service
    // makes the upfront decision by calling the existing
    // WorkspaceAuthorizationService, which the repository will
    // re-check inside its atomic transaction as a second-layer
    // guard. Both layers read the same source of truth so the
    // policy decision is identical.
    await this.authz.requireCapability({
      userAccountId: input.userAccountId,
      workspaceId: input.actingWorkspaceId,
      requiredCapability: "Buyer",
    });

    const result = await this.repository.createProjectRequestWithRevalidation({
      userAccountId: input.userAccountId,
      buyerWorkspaceId: input.actingWorkspaceId,
      projectBriefId: input.projectBriefId,
      serviceOfferingId: input.serviceOfferingId,
    });
    if (!result.ok) {
      throw this.createFailureToServiceError(result.reason);
    }
    return { projectRequest: toPublicProjectRequest(result.value) };
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
    // GS 17 — only the seller Workspace owning this request may
    // accept. The acting Workspace MUST match the persisted
    // sellerWorkspaceId; if it does not, fail closed before touching
    // the row. The application then revalidates current seller
    // membership via WorkspaceAuthorizationService before the
    // repository runs its atomic guarded transition.
    if (existing.sellerWorkspaceId !== input.actingWorkspaceId) {
      throw new ProjectRequestError(
        "You are not authorized to respond to this ProjectRequest.",
        "PROJECT_REQUEST_FORBIDDEN",
      );
    }
    await this.authz.requireActingMembership({
      userAccountId: input.userAccountId,
      workspaceId: input.actingWorkspaceId,
    });

    const result = await this.repository.acceptProjectRequest({
      projectRequestId: existing.id,
      sellerDecisionByUserId: input.userAccountId,
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
    if (existing.sellerWorkspaceId !== input.actingWorkspaceId) {
      throw new ProjectRequestError(
        "You are not authorized to respond to this ProjectRequest.",
        "PROJECT_REQUEST_FORBIDDEN",
      );
    }
    await this.authz.requireActingMembership({
      userAccountId: input.userAccountId,
      workspaceId: input.actingWorkspaceId,
    });

    const result = await this.repository.declineProjectRequest({
      projectRequestId: existing.id,
      sellerDecisionByUserId: input.userAccountId,
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
  private createFailureToServiceError(
    reason: CreateProjectRequestFailureReason,
  ): ProjectRequestError {
    switch (reason) {
      case "BRIEF_NOT_FOUND":
        return new ProjectRequestError(
          "ProjectBrief not found.",
          "PROJECT_REQUEST_BRIEF_NOT_FOUND",
        );
      case "BRIEF_FORBIDDEN":
        return new ProjectRequestError(
          "ProjectBrief does not belong to this Workspace.",
          "PROJECT_REQUEST_BRIEF_FORBIDDEN",
        );
      case "OFFERING_NOT_IN_BRIEF":
      case "OFFERING_INELIGIBLE":
        return new ProjectRequestError(
          "The selected ServiceOffering is no longer eligible.",
          "PROJECT_REQUEST_OFFERING_INELIGIBLE",
        );
      case "ALREADY_PENDING":
        return new ProjectRequestError(
          "A Pending ProjectRequest already exists for this selection.",
          "PROJECT_REQUEST_ALREADY_PENDING",
        );
    }
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
  // Private human-actor identifiers are intentionally omitted from the
  // counterparty-visible surface. The persisted columns remain in
  // PostgreSQL as audit evidence (and are available to internal /
  // separately-authorized audit presentations), but they MUST NOT
  // cross this public DTO. See projectRequestPublicV1Schema for the
  // allow-list contract.
  return {
    projectRequestId: persisted.id,
    buyerWorkspaceId: persisted.buyerWorkspaceId,
    sellerWorkspaceId: persisted.sellerWorkspaceId,
    serviceOfferingId: persisted.serviceOfferingId,
    projectBriefId: persisted.projectBriefId,
    status: persisted.status,
    sellerDecisionAt: persisted.sellerDecisionAt ? persisted.sellerDecisionAt.toISOString() : null,
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
