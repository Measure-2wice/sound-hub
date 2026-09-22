// Intent selection service (M2 #83).
//
// Background: a freshly-converged Personal Workspace has no
// marketplace capability. The human must explicitly choose
// `Hire talent`, `Offer services`, or `Both` to provision Buyer /
// Seller capability. The intent service is the single owner of
// that provision:
//
//   - `Hire`   → Buyer capability (no attestation).
//   - `Offer`  → Seller capability + versioned Seller participation
//                acceptance evidence.
//   - `Both`   → Buyer capability + Seller capability + Seller
//                participation acceptance evidence, all in ONE
//                atomic transaction.
//
// Authorization invariants:
//
//   - Intent self-service is Personal-Workspace ONLY. The acting
//     human MUST be a current member of a `Personal` Workspace;
//     a valid Organization membership is rejected via
//     `requirePersonalActingMembership` (which throws
//     `INTENT_NOT_PERSONAL`, translated to `INTENT_FORBIDDEN`).
//   - Any current Owner/Admin/Member role on the Personal
//     Workspace passes (the route is NOT Owner-only per ticket #82).
//   - Buyer capability requires no attestation.
//   - Seller capability requires the registered Seller
//     participation terms (`getCurrentSellerParticipationTerms`).
//   - `DealApprover` is NEVER created by this service.
//
// TODO(legal-blocker): Offer/Both acceptance requires the
// registered Seller participation terms. #83 keeps the seam
// (`apps/api/src/lib/seller-participation-terms.ts`). #83 cannot
// mark Offer/Both production-complete until product/legal calls
// `registerSellerParticipationTerms({ version, content })` from an
// approved admin bootstrap. Until that call lands, Offer/Both
// return `INTENT_LEGAL_BLOCKED`. Owner: Product + Legal.
//
// Atomicity invariants (Codex CHANGES_REQUESTED P0):
//
//   - `Hire`, `Offer`, and `Both` route through
//     `AuthRepository.provisionIntentAtomically`, which wraps the
//     capability upserts and the acceptance insert in a single
//     Prisma `$transaction`. Either ALL writes commit, or the
//     transaction rolls back to zero rows.
//   - The natural unique indexes provide idempotency. The
//     transaction is the single source of atomicity; if a write
//     inside the transaction throws (e.g., a real FK constraint
//     violation), Prisma rolls back every write the transaction
//     issued, including the capability upserts.
//   - The application does NOT rely on find-then-insert pre-checks
//     for race correctness.
//
// `setupState` is read-only on this path. The route derives it
// via `PersonalWorkspaceConvergenceService.resolveConvergence` and
// passes the classification into `submitIntent`. The intent service
// never re-classifies recovery — recovery is already surfaced via
// the user payload's existing `setupState` field; the dashboard
// renders it. The intent navigation contract does NOT carry
// `setupState` (see `apps/web/src/app/lib/navigate-after-intent.ts`).

import type {
  Bg1PublicUserV1,
  Bg1SetupStateV1,
  IntentKindV1,
  IntentRequestV1,
  IntentResponseV1,
  MarketplaceCapabilityV1,
  sellerParticipationAcceptanceV1Schema,
} from "@soundhub/types";
import { toPublicUser } from "../dto/public-mappers.js";
import type { AuthRepository, PublicUserView } from "../auth-repository/auth-repository.js";
import {
  AuthorizationError,
  PersonalActingMembershipError,
  type WorkspaceAuthorizationService,
} from "./workspace-authorization.service.js";
import { getCurrentSellerParticipationTerms } from "../lib/seller-participation-terms.js";

export class IntentServiceError extends Error {
  constructor(
    message: string,
    public readonly code: "INTENT_INVALID" | "INTENT_FORBIDDEN" | "INTENT_LEGAL_BLOCKED",
  ) {
    super(message);
    this.name = "IntentServiceError";
  }
}

/**
 * Translate a `WorkspaceAuthorizationService` `AuthorizationError`
 * OR a `PersonalActingMembershipError` into the intent service's
 * stable code set. The route layer applies the safe-envelope
 * mapping; this translation keeps the service's contract
 * readable at the call site.
 *
 * Coverage: `AuthorizationError` (generic non-membership /
 * ineligible / capability gates) AND `PersonalActingMembershipError`
 * (the Personal-Workspace boundary — see #83 remediation §2).
 * Both surface to the customer as `INTENT_FORBIDDEN` so the route
 * layer renders a single safe-envelope copy.
 */
export function translateAuthorizationError(err: unknown): IntentServiceError | null {
  if (err instanceof AuthorizationError || err instanceof PersonalActingMembershipError) {
    return new IntentServiceError(err.message, "INTENT_FORBIDDEN");
  }
  return null;
}

export interface IntentServiceDeps {
  readonly authRepository: AuthRepository;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
}

export interface SubmitIntentInput {
  readonly userAccountId: string;
  readonly workspaceId: string;
  readonly setupState: Bg1SetupStateV1;
  readonly intent: IntentRequestV1;
}

export interface SubmitIntentResult {
  readonly user: Bg1PublicUserV1;
  /**
   * The validated `returnTo` carried by the request body. Null
   * when no value was supplied or the route rejected an invalid
   * value. The browser routes to this value via
   * `navigateAfterIntent`; the value was already validated server
   * side, so the browser must NOT re-read raw query parameters.
   */
  readonly returnTo: string | null;
}

export class IntentService {
  constructor(private readonly deps: IntentServiceDeps) {}

  async submitIntent(input: SubmitIntentInput): Promise<SubmitIntentResult> {
    // Step 0: recovery-state failure-closed guard. When the
    // convergence service classifies the user as `recovery`, no
    // Personal Workspace can be authoritative. The intent service
    // refuses ANY mutation — capability provisioning, acceptance
    // recording — without an authoritative canonical Personal
    // Workspace. Ambiguous or contradictory Personal Workspace
    // authority must remain in recovery and must never be guessed.
    //
    // This is a fail-closed guard that runs BEFORE every other
    // validation; even an accessible Personal Workspace path id is
    // not authoritative when convergence is in recovery.
    if (input.setupState === "recovery") {
      throw new IntentServiceError(
        "Personal Workspace is in recovery; intent self-service is unavailable.",
        "INTENT_FORBIDDEN",
      );
    }

    // Step 1: revalidate current membership on the target Personal
    // Workspace. A valid Organization membership is rejected here
    // (`INTENT_NOT_PERSONAL` translated to `INTENT_FORBIDDEN`),
    // before any capability write.
    let acting;
    try {
      acting = await this.deps.workspaceAuthorizationService.requirePersonalActingMembership({
        userAccountId: input.userAccountId,
        workspaceId: input.workspaceId,
      });
    } catch (err) {
      const translated = translateAuthorizationError(err);
      if (translated) throw translated;
      throw err;
    }

    // Step 2: shape validation. The route already validated the
    // request body via the shared `intentRequestV1Schema`; this
    // service re-reads the parsed value for capability routing.
    const intent = input.intent.intent;
    const sellerAcceptance = input.intent.sellerAcceptance;
    const requestedReturn = input.intent.returnTo ?? null;

    if ((intent === "Offer" || intent === "Both") && !sellerAcceptance) {
      // Defense in depth — the schema's `.superRefine` rejects
      // this case at parse time, but a code path that bypasses
      // schema validation must not silently proceed.
      throw new IntentServiceError(
        "sellerAcceptance is required when intent is Offer or Both.",
        "INTENT_INVALID",
      );
    }

    // Step 3: build the canonical capability + acceptance payload.
    // For Seller/Both, verify the registered terms first. The
    // service NEVER invents legal copy; the registered-terms seam
    // is the single explicit product/legal blocker.
    const capabilities: readonly MarketplaceCapabilityV1[] =
      intent === "Hire" ? ["Buyer"] : intent === "Offer" ? ["Seller"] : ["Buyer", "Seller"];

    let acceptance: {
      readonly termsVersion: string;
      readonly termsContentHash: string;
      readonly grantedByUserId: string;
    } | null = null;

    if (intent === "Offer" || intent === "Both") {
      const registered = getCurrentSellerParticipationTerms();
      if (!registered) {
        throw new IntentServiceError(
          "Seller participation terms are not yet registered. Cannot provision Seller capability.",
          "INTENT_LEGAL_BLOCKED",
        );
      }
      if (sellerAcceptance) {
        if (sellerAcceptance.termsVersion !== registered.version) {
          throw new IntentServiceError(
            `sellerAcceptance.termsVersion does not match the registered version (got ${sellerAcceptance.termsVersion}, expected ${registered.version}).`,
            "INTENT_INVALID",
          );
        }
        if (sellerAcceptance.termsContentHash !== registered.contentHash) {
          throw new IntentServiceError(
            "sellerAcceptance.termsContentHash does not match the registered content hash.",
            "INTENT_INVALID",
          );
        }
        acceptance = {
          termsVersion: sellerAcceptance.termsVersion,
          termsContentHash: sellerAcceptance.termsContentHash,
          grantedByUserId: input.userAccountId,
        };
      }
    }

    // Step 4: single atomic repository call. Either every write
    // commits, or the transaction rolls back to zero rows. A real
    // FK violation inside the transaction (e.g., acceptance's
    // grantedByUserId references a deleted UserAccount) triggers a
    // Prisma P2003 — the atomicity test exercises this path to
    // prove the rollback.
    await this.deps.authRepository.provisionIntentAtomically({
      workspaceId: acting.workspace.workspaceId,
      userAccountId: input.userAccountId,
      capabilities,
      acceptance,
    });

    return {
      user: await this.loadPublicUser(input.userAccountId, input.setupState),
      returnTo: requestedReturn,
    };
  }

  private async loadPublicUser(
    userAccountId: string,
    setupState: Bg1SetupStateV1,
  ): Promise<Bg1PublicUserV1> {
    const view = await this.deps.authRepository.getPublicUser(userAccountId);
    if (!view) {
      throw new IntentServiceError(
        "User account is not available for intent provisioning.",
        "INTENT_FORBIDDEN",
      );
    }
    return toPublicUser(view, setupState);
  }
}

// ---------- Type-only re-exports ----------

export type {
  IntentKindV1,
  IntentRequestV1,
  IntentResponseV1,
  MarketplaceCapabilityV1,
  PublicUserView,
};

export { sellerParticipationAcceptanceV1Schema };
