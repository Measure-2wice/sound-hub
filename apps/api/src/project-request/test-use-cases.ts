// Shared application-owned ProjectRequest test use cases.
//
// Background: ticket #62 acceptance criteria require the BG4
// production repository to acquire FOR UPDATE-locked authority /
// eligibility rows and then hand the snapshot to an
// application-owned use case that evaluates the pure policy
// helpers in `./project-request-authorization-policy.ts`.
//
// The disposable-PostgreSQL repository, interleaving, concurrency,
// and retry tests all exercise the same canonical buyer /
// seller-policy use cases. Sharing one definition here keeps the
// four suites from drifting — every suite invokes the exact same
// production policy sequence and outcome construction, so a
// change to the production policy surfaces uniformly in every
// suite.

import type {
  CreateProjectRequestUseCase,
  CreateProjectRequestUseCaseContext,
  CreateProjectRequestUseCaseTools,
  RespondProjectRequestUseCase,
  RespondProjectRequestUseCaseContext,
  RespondProjectRequestUseCaseTools,
} from "./project-request.repository.js";
import {
  evaluateBriefRecommendationBoundary,
  evaluateBuyerAuthority,
  evaluateSellerAuthority,
  evaluateSellerEligibility,
} from "./project-request-authorization-policy.js";

/**
 * Canonical buyer-side use case. Evaluates the brief
 * recommendation boundary, the buyer authority snapshot, and the
 * complete seller / offering eligibility snapshot. Persists only
 * when every check is satisfied.
 */
export const buyerOkUseCase: CreateProjectRequestUseCase = (
  ctx: CreateProjectRequestUseCaseContext,
  tools: CreateProjectRequestUseCaseTools,
) => {
  const briefVerdict = evaluateBriefRecommendationBoundary(
    ctx.briefRecommendations,
    ctx.sellerEligibility.serviceOfferingId,
    ctx.buyerAuthority.buyerWorkspaceId,
  );
  if (!briefVerdict.ok) {
    if (briefVerdict.reason === "BRIEF_NOT_FOUND") return tools.reject("BRIEF_NOT_FOUND");
    if (briefVerdict.reason === "BRIEF_FORBIDDEN") return tools.reject("BRIEF_FORBIDDEN");
    return tools.reject("OFFERING_NOT_IN_BRIEF");
  }
  const buyerVerdict = evaluateBuyerAuthority(ctx.buyerAuthority);
  if (!buyerVerdict.ok) return tools.reject("BUYER_NOT_AUTHORIZED");
  const sellerVerdict = evaluateSellerEligibility(ctx.sellerEligibility);
  if (!sellerVerdict.ok) return tools.reject("SELLER_INELIGIBLE");
  return tools.persist({
    userAccountId: ctx.buyerAuthority.userAccountId,
    buyerWorkspaceId: ctx.buyerAuthority.buyerWorkspaceId,
    sellerWorkspaceId: sellerVerdict.sellerWorkspaceId,
    projectBriefId: ctx.briefRecommendations.projectBriefId,
    serviceOfferingId: ctx.sellerEligibility.serviceOfferingId,
  });
};

/**
 * Canonical accept use case. Evaluates the seller authority
 * snapshot and returns the accept transition.
 */
export function buildAcceptUseCase(now: Date): RespondProjectRequestUseCase {
  return (ctx: RespondProjectRequestUseCaseContext, tools: RespondProjectRequestUseCaseTools) => {
    const verdict = evaluateSellerAuthority(ctx.sellerAuthority);
    if (!verdict.ok) return tools.reject("SELLER_NOT_AUTHORIZED");
    return tools.accept({
      projectRequestId: ctx.projectRequest.id,
      sellerDecisionByUserId: ctx.sellerAuthority.userAccountId,
      now,
    });
  };
}

/**
 * Canonical decline use case. Evaluates the seller authority
 * snapshot and returns the decline transition.
 */
export function buildDeclineUseCase(now: Date): RespondProjectRequestUseCase {
  return (ctx: RespondProjectRequestUseCaseContext, tools: RespondProjectRequestUseCaseTools) => {
    const verdict = evaluateSellerAuthority(ctx.sellerAuthority);
    if (!verdict.ok) return tools.reject("SELLER_NOT_AUTHORIZED");
    return tools.decline({
      projectRequestId: ctx.projectRequest.id,
      sellerDecisionByUserId: ctx.sellerAuthority.userAccountId,
      now,
    });
  };
}
