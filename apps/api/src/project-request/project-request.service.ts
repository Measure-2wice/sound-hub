// ProjectRequest service (BG4).
//
// Background: ticket #62 requires a single application boundary that
// owns the buyer-side ProjectRequest creation, the seller-side
// accept/decline, and the eligibility revalidation that protects
// against stale selections (GS 16). The service composes:
//
//   - the application-owned policy evaluators in
//     `./project-request-authorization-policy.ts` (buyer authority,
//     complete seller / offering eligibility, brief recommendation
//     boundary, seller authority), and
//   - the transaction-scoped repository methods in
//     `./project-request.repository.ts` (one PostgreSQL transaction
//     per command, FOR UPDATE-locked fact reads, guarded persistence).
//
// For each consequential command the service supplies a pure use-case
// closure that consumes the snapshot the repository loads inside its
// transaction and returns either a `persist` verdict or a `reject`
// verdict. The repository never decides whether the facts authorize
// the command; the service owns that decision.
//
// The repository remains the only layer that touches Prisma. The
// service has no Prisma dependency.

import type {
  CreateProjectRequestRequestV1,
  ProjectRequestPublicV1,
  DealPublicV1,
} from "@soundhub/types";
import type { PersistedBrief } from "../matchmaker/project-brief.repository.js";
import { type WorkspaceAuthorizationService } from "../services/workspace-authorization.service.js";
import type {
  AcceptProjectRequestResult,
  CreateProjectRequestFailureReason,
  CreateProjectRequestResult,
  CreateProjectRequestUseCase,
  CreateProjectRequestUseCaseContext,
  CreateProjectRequestUseCaseTools,
  CreateUseCaseOutcome,
  DecideFailureReason,
  DecideResult,
  PersistedDeal,
  PersistedProjectRequest,
  ProjectRequestRepository,
  RespondProjectRequestUseCase,
  RespondProjectRequestUseCaseContext,
  RespondProjectRequestUseCaseTools,
  RespondUseCaseOutcome,
} from "./project-request.repository.js";
import {
  evaluateBriefRecommendationBoundary,
  evaluateBuyerAuthority,
  evaluateSellerAuthority,
  evaluateSellerEligibility,
} from "./project-request-authorization-policy.js";

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
  /**
   * Used by the read commands (getProjectRequest /
   * listProjectRequests) to revalidate that the authenticated
   * UserAccount holds a current WorkspaceMembership in the
   * explicitly acting Workspace before any private ProjectRequest
   * DTO is returned. The application owns this policy decision;
   * the repository never inspects WorkspaceMembership.
   */
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
   * The service supplies a use-case callback. The repository opens
   * one transaction, FOR UPDATE-locks the buyer Workspace /
   * membership / capability, the seller Workspace / membership /
   * capability, the seller Profile, the ServiceOffering, and the
   * ProjectBrief + BriefSearchResult rows, then hands the
   * snapshots to the use case. The use case evaluates the
   * application-owned policy and returns either `persist` (with the
   * sellerWorkspaceId the snapshot surfaced) or `reject`. The
   * repository persists only when the use case persists.
   */
  async createProjectRequest(input: CreateProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    const useCase: CreateProjectRequestUseCase = (
      ctx: CreateProjectRequestUseCaseContext,
      tools: CreateProjectRequestUseCaseTools,
    ): CreateUseCaseOutcome => evaluateCreateUseCase(ctx, tools, input);

    const result = await this.repository.createProjectRequestInTransaction(
      {
        userAccountId: input.userAccountId,
        buyerWorkspaceId: input.actingWorkspaceId,
        projectBriefId: input.projectBriefId,
        serviceOfferingId: input.serviceOfferingId,
      },
      useCase,
    );

    if (!result.ok) {
      throw this.createFailureToServiceError(result.reason);
    }
    return { projectRequest: toPublicProjectRequest(result.value) };
  }

  /**
   * Accept a Pending ProjectRequest as the seller. Atomically
   * transitions Pending → Accepted AND creates exactly one
   * Negotiating Deal (ticket #62 acceptance criteria + GS 18 +
   * GS 26).
   */
  async acceptProjectRequest(input: AcceptProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
    readonly deal: DealPublicV1;
  }> {
    const useCase: RespondProjectRequestUseCase = (
      ctx: RespondProjectRequestUseCaseContext,
      tools: RespondProjectRequestUseCaseTools,
    ): RespondUseCaseOutcome => {
      const verdict = evaluateSellerAuthority(ctx.sellerAuthority);
      if (!verdict.ok) {
        return tools.reject("SELLER_NOT_AUTHORIZED");
      }
      return tools.accept({
        projectRequestId: ctx.projectRequest.id,
        sellerDecisionByUserId: input.userAccountId,
        now: this.now(),
      });
    };

    const result = await this.repository.respondToProjectRequestInTransaction(
      {
        projectRequestId: input.projectRequestId,
        actingWorkspaceId: input.actingWorkspaceId,
        userAccountId: input.userAccountId,
        now: this.now(),
      },
      useCase,
    );
    if (!result.ok) {
      throw this.decideErrorToServiceError(result.reason);
    }
    const accepted = result.value as AcceptProjectRequestResult;
    return {
      projectRequest: toPublicProjectRequest(accepted.projectRequest),
      deal: toPublicDeal(accepted.deal),
    };
  }

  /**
   * Decline a Pending ProjectRequest as the seller. Terminal;
   * creates no Deal (GS 18).
   */
  async declineProjectRequest(input: DeclineProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    const useCase: RespondProjectRequestUseCase = (
      ctx: RespondProjectRequestUseCaseContext,
      tools: RespondProjectRequestUseCaseTools,
    ): RespondUseCaseOutcome => {
      const verdict = evaluateSellerAuthority(ctx.sellerAuthority);
      if (!verdict.ok) {
        return tools.reject("SELLER_NOT_AUTHORIZED");
      }
      return tools.decline({
        projectRequestId: ctx.projectRequest.id,
        sellerDecisionByUserId: input.userAccountId,
        now: this.now(),
      });
    };

    const result = await this.repository.respondToProjectRequestInTransaction(
      {
        projectRequestId: input.projectRequestId,
        actingWorkspaceId: input.actingWorkspaceId,
        userAccountId: input.userAccountId,
        now: this.now(),
      },
      useCase,
    );
    if (!result.ok) {
      throw this.decideErrorToServiceError(result.reason);
    }
    const declined = result.value as PersistedProjectRequest;
    return { projectRequest: toPublicProjectRequest(declined) };
  }

  /**
   * Fetch one ProjectRequest. Either side (buyer or seller
   * Workspace) may view it, but the application requires the
   * authenticated UserAccount to hold a current WorkspaceMembership
   * in the explicitly acting Workspace. A revoked former member
   * loses read access immediately; a non-member using a real
   * request id receives the same safe PROJECT_REQUEST_NOT_FOUND
   * envelope so the response contract never reveals whether the
   * record exists.
   */
  async getProjectRequest(input: GetProjectRequestInput): Promise<{
    readonly projectRequest: ProjectRequestPublicV1;
  }> {
    try {
      await this.authz.requireActingMembership({
        userAccountId: input.userAccountId,
        workspaceId: input.actingWorkspaceId,
      });
    } catch (err) {
      // Reads collapse all authorization failures to the same
      // PROJECT_REQUEST_NOT_FOUND envelope so the response
      // contract never reveals whether the record exists.
      void err;
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
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
    return { projectRequest: toPublicProjectRequest(existing) };
  }

  /**
   * List ProjectRequests for an acting Workspace (both sides). The
   * application requires the authenticated UserAccount to hold a
   * current WorkspaceMembership in the explicitly acting
   * Workspace. A revoked former member loses list access immediately;
   * a non-member using a real Workspace id receives the same
   * PROJECT_REQUEST_NOT_FOUND envelope so the response contract
   * never reveals whether the request set exists. The route can
   * pass `statusFilter` to scope the inbox to Pending requests
   * only.
   */
  async listProjectRequests(input: ListProjectRequestsInput): Promise<{
    readonly projectRequests: readonly ProjectRequestPublicV1[];
  }> {
    try {
      await this.authz.requireActingMembership({
        userAccountId: input.userAccountId,
        workspaceId: input.actingWorkspaceId,
      });
    } catch (err) {
      // Same collapse as getProjectRequest so the safe envelope
      // does not leak the existence of the Workspace's records.
      void err;
      throw new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
    }
    const rows = await this.repository.listProjectRequests({
      workspaceId: input.actingWorkspaceId,
      ...(input.statusFilter ? { statusFilter: input.statusFilter } : {}),
    });
    return {
      projectRequests: rows.map(toPublicProjectRequest),
    };
  }

  private createFailureToServiceError(
    reason: CreateProjectRequestFailureReason,
  ): ProjectRequestError {
    switch (reason) {
      case "BUYER_NOT_AUTHORIZED":
        return new ProjectRequestError(
          "You are not authorized to create a ProjectRequest.",
          "PROJECT_REQUEST_FORBIDDEN",
        );
      case "SELLER_INELIGIBLE":
        return new ProjectRequestError(
          "The selected ServiceOffering is no longer eligible.",
          "PROJECT_REQUEST_OFFERING_INELIGIBLE",
        );
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
        return new ProjectRequestError(
          "The selected ServiceOffering was not surfaced for this ProjectBrief.",
          "PROJECT_REQUEST_OFFERING_INELIGIBLE",
        );
      case "ALREADY_PENDING":
        return new ProjectRequestError(
          "A Pending ProjectRequest already exists for this selection.",
          "PROJECT_REQUEST_ALREADY_PENDING",
        );
      case "CONCURRENCY_RETRY_EXHAUSTED":
        return new ProjectRequestError(
          "The marketplace is busy; please retry.",
          "PROJECT_REQUEST_OFFERING_INELIGIBLE",
        );
    }
  }

  private decideErrorToServiceError(reason: DecideFailureReason): ProjectRequestError {
    switch (reason) {
      case "NOT_FOUND":
        return new ProjectRequestError("ProjectRequest not found.", "PROJECT_REQUEST_NOT_FOUND");
      case "SELLER_NOT_AUTHORIZED":
        return new ProjectRequestError(
          "You are not authorized to respond to this ProjectRequest.",
          "PROJECT_REQUEST_FORBIDDEN",
        );
      case "ALREADY_RESPONDED":
        return new ProjectRequestError(
          "This ProjectRequest has already been responded to.",
          "PROJECT_REQUEST_ALREADY_RESPONDED",
        );
      case "CONCURRENCY_RETRY_EXHAUSTED":
        return new ProjectRequestError(
          "The marketplace is busy; please retry.",
          "PROJECT_REQUEST_ALREADY_RESPONDED",
        );
    }
  }
}

// ---------- application-owned use-case evaluators ----------

function evaluateCreateUseCase(
  ctx: CreateProjectRequestUseCaseContext,
  tools: CreateProjectRequestUseCaseTools,
  input: CreateProjectRequestInput,
): CreateUseCaseOutcome {
  // Step 1: brief recommendation boundary. Existence + ownership
  // + Matchmaker provenance must all hold before we evaluate
  // authority (matches the documented priority so a buyer cannot
  // probe authority against a brief they do not own).
  const briefVerdict = evaluateBriefRecommendationBoundary(
    ctx.briefRecommendations,
    input.serviceOfferingId,
    input.actingWorkspaceId,
  );
  if (!briefVerdict.ok) {
    if (briefVerdict.reason === "BRIEF_NOT_FOUND") {
      return tools.reject("BRIEF_NOT_FOUND");
    }
    if (briefVerdict.reason === "BRIEF_FORBIDDEN") {
      return tools.reject("BRIEF_FORBIDDEN");
    }
    return tools.reject("OFFERING_NOT_IN_BRIEF");
  }

  // Step 2: buyer authority. The repository already loaded +
  // locked the buyer Workspace / membership / capability rows.
  const buyerVerdict = evaluateBuyerAuthority(ctx.buyerAuthority);
  if (!buyerVerdict.ok) {
    return tools.reject("BUYER_NOT_AUTHORIZED");
  }

  // Step 3: complete seller / offering eligibility. The repository
  // already loaded + locked the seller Workspace / membership /
  // capability rows, the SellerProfile, and the ServiceOffering.
  const sellerVerdict = evaluateSellerEligibility(ctx.sellerEligibility);
  if (!sellerVerdict.ok) {
    return tools.reject("SELLER_INELIGIBLE");
  }

  // All checks pass. Persist the Pending ProjectRequest with the
  // seller Workspace id the snapshot surfaced (no second read
  // required).
  return tools.persist({
    userAccountId: input.userAccountId,
    buyerWorkspaceId: input.actingWorkspaceId,
    sellerWorkspaceId: sellerVerdict.sellerWorkspaceId,
    projectBriefId: input.projectBriefId,
    serviceOfferingId: input.serviceOfferingId,
  });
}

// ---------- DTO mapping ----------

export function toPublicProjectRequest(persisted: PersistedProjectRequest): ProjectRequestPublicV1 {
  // Private human-actor identifiers are intentionally omitted from
  // the counterparty-visible surface. The persisted columns remain
  // in PostgreSQL as audit evidence (and are available to internal
  // / separately-authorized audit presentations), but they MUST
  // NOT cross this public DTO. See projectRequestPublicV1Schema
  // for the allow-list contract.
  //
  // Display-only context (buyer Workspace name, seller Workspace
  // name, ServiceOffering title, brief excerpt) is included so the
  // seller inbox (and the symmetric buyer audit view) can render
  // human-readable context instead of raw internal ids. These
  // fields are populated by the repository's read paths; the
  // transactional create / accept / decline paths leave them null
  // because the UI immediately re-lists and re-renders.
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
    buyerWorkspaceName: persisted.buyerWorkspaceName,
    sellerWorkspaceName: persisted.sellerWorkspaceName,
    serviceOfferingTitle: persisted.serviceOfferingTitle,
    briefExcerpt: persisted.briefExcerpt,
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

// Allow the route to consume the request type directly so the
// import graph stays small.
export type { CreateProjectRequestRequestV1 };
// Allow the ProjectBriefRepository type to be re-imported from
// this module so the route file does not need to know its path.
export type { PersistedBrief };
export type {
  CreateProjectRequestResult,
  CreateProjectRequestFailureReason,
  DecideResult,
  DecideFailureReason,
};
