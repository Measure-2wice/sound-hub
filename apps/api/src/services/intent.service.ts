// Intent selection service (M2 #83).
//
// Background: a freshly-converged Personal Workspace has no
// marketplace capability. The human must explicitly choose
// `Hire talent`, `Offer services`, or `Both` to provision Buyer /
// Seller capability. The intent service is the single owner of
// that provision:
//
//   - `Hire`   → Buyer capability only.
//   - `Offer`  → Seller capability only.
//   - `Both`   → Buyer + Seller atomically in ONE transaction.
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
//   - Neither Buyer nor Seller capability requires a generic
//     participation/terms acceptance at capability-provisioning
//     time. Context-specific confirmations are owned by their
//     later boundaries (SellerProfile publication, media use,
//     ServiceOffering activation, Deal approval authority /
//     approval).
//   - `DealApprover` is NEVER created by this service.
//
// Atomicity invariants:
//
//   - `Hire`, `Offer`, and `Both` route through
//     `AuthRepository.provisionIntentAtomically`, which wraps
//     the capability upserts in a single Prisma `$transaction`.
//     Either ALL writes commit, or the transaction rolls back
//     to zero rows.
//   - The natural unique indexes provide idempotency. The
//     transaction is the single source of atomicity; if a write
//     inside the transaction throws (e.g., a real FK constraint
//     violation), Prisma rolls back every write the transaction
//     issued.
//   - The application does NOT rely on find-then-insert pre-checks
//     for race correctness.
//
// `setupState` is read-only on this path. The route derives it
// via `PersonalWorkspaceConvergenceService.resolveConvergence` and
// passes the classification into `submitIntent`. The intent service
// refuses ANY mutation when convergence classifies the user as
// recovery. The intent navigation contract does NOT carry
// `setupState` (see `apps/web/src/app/lib/navigate-after-intent.ts`).

import type {
  Bg1PublicUserV1,
  Bg1SetupStateV1,
  IntentKindV1,
  IntentRequestV1,
  IntentResponseV1,
  MarketplaceCapabilityV1,
} from "@soundhub/types";
import { toPublicUser } from "../dto/public-mappers.js";
import type { AuthRepository, PublicUserView } from "../auth-repository/auth-repository.js";
import { IntentConflictError } from "../auth-repository/auth-repository.js";
import type { ConvergenceKind } from "../lib/personal-workspace-convergence-domain.js";
import {
  AuthorizationError,
  PersonalActingMembershipError,
  type WorkspaceAuthorizationService,
} from "./workspace-authorization.service.js";

export class IntentServiceError extends Error {
  constructor(
    message: string,
    public readonly code: "INTENT_INVALID" | "INTENT_FORBIDDEN",
  ) {
    super(message);
    this.name = "IntentServiceError";
  }
}

/**
 * Translate a `WorkspaceAuthorizationService` `AuthorizationError`,
 * a `PersonalActingMembershipError`, OR an `IntentConflictError`
 * into the intent service's stable code set. The route layer
 * applies the safe-envelope mapping; this translation keeps the
 * service's contract readable at the call site.
 *
 * Coverage:
 *   - `AuthorizationError` (generic non-membership / ineligible /
 *     capability gates).
 *   - `PersonalActingMembershipError` (the Personal-Workspace
 *     boundary — see #83 remediation §2).
 *   - `IntentConflictError` (a conflicting intent retry would
 *     silently merge the existing capability rows with the
 *     requested ones into a wider set than the customer
 *     originally asked for). The atomic primitive has already
 *     rolled back; the service translates the signal into a
 *     single safe-envelope `INTENT_FORBIDDEN` so the customer
 *     sees actionable recovery rather than the implementation-
 *     internal `existing` / `requested` arrays.
 *
 * All three surface to the customer as `INTENT_FORBIDDEN` so the
 * route layer renders a single safe-envelope copy.
 */
export function translateAuthorizationError(err: unknown): IntentServiceError | null {
  if (
    err instanceof AuthorizationError ||
    err instanceof PersonalActingMembershipError ||
    err instanceof IntentConflictError
  ) {
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
  /**
   * Full Personal Workspace convergence classification. The intent
   * service uses the canonical Personal Workspace id (when present)
   * to require exact equality with `workspaceId` before any
   * mutation. Without this check, a non-canonical accessible
   * Personal Workspace could receive capability writes even though
   * it is not the user's converged Personal pointer.
   */
  readonly convergence: ConvergenceKind;
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
    // Step 0: canonical Personal Workspace enforcement.
    // Convergence is the authoritative pointer to the user's
    // Personal Workspace. Only the canonical Workspace — never
    // merely an accessible alternative — may receive capability
    // provisioning.
    //
    //   - `recovery`: no canonical Personal Workspace exists. Fail
    //     closed. Even an accessible Personal Workspace path id is
    //     not authoritative when convergence is in recovery.
    //   - `none`: no Personal Workspace state has been established.
    //     The auth surface has not converged this account; intent
    //     self-service is not yet available.
    //   - `attachable` / `converged`: the canonical Personal
    //     Workspace id MUST equal the path `workspaceId` exactly.
    //     A non-canonical accessible Personal Workspace is rejected
    //     with INTENT_FORBIDDEN — zero capability writes.
    if (input.convergence.kind === "recovery") {
      throw new IntentServiceError(
        "Personal Workspace is in recovery; intent self-service is unavailable.",
        "INTENT_FORBIDDEN",
      );
    }
    if (input.convergence.kind === "none") {
      throw new IntentServiceError(
        "Personal Workspace is not yet established; intent self-service is unavailable.",
        "INTENT_FORBIDDEN",
      );
    }
    const canonicalPersonalWorkspaceId = input.convergence.workspaceId;
    if (input.workspaceId !== canonicalPersonalWorkspaceId) {
      // Non-canonical accessible Personal Workspace. Collapse to
      // INTENT_FORBIDDEN — the canonical pointer is the only
      // authority. Zero mutation has occurred at this point.
      throw new IntentServiceError(
        "Intent can only target the canonical Personal Workspace.",
        "INTENT_FORBIDDEN",
      );
    }

    // Step 1: revalidate current membership on the canonical
    // Personal Workspace. A valid Organization membership is
    // rejected here (`INTENT_NOT_PERSONAL` translated to
    // `INTENT_FORBIDDEN`), before any capability write. The
    // resolved membership is intentionally unused at this step —
    // Step 2 derives the canonical capability payload from the
    // validated intent body, and the atomic repository primitive
    // re-validates the Workspace id. The membership lookup is the
    // authorization authority; the resolved membership is the
    // proof it ran cleanly.
    try {
      await this.deps.workspaceAuthorizationService.requirePersonalActingMembership({
        userAccountId: input.userAccountId,
        workspaceId: canonicalPersonalWorkspaceId,
      });
    } catch (err) {
      const translated = translateAuthorizationError(err);
      if (translated) throw translated;
      throw err;
    }

    // Step 2: derive the canonical capability payload. The route
    // already validated the request body via the shared
    // `intentRequestV1Schema`; this service re-reads the parsed
    // intent for capability routing. No Seller participation
    // acceptance field is carried on the intent surface.
    const intent = input.intent.intent;
    const requestedReturn = input.intent.returnTo ?? null;

    const capabilities: readonly MarketplaceCapabilityV1[] =
      intent === "Hire" ? ["Buyer"] : intent === "Offer" ? ["Seller"] : ["Buyer", "Seller"];

    // Step 3: single atomic repository call. Either every capability
    // write commits, or the transaction rolls back to zero rows. A
    // real FK violation inside the transaction (e.g., an FK on
    // `WorkspaceCapability`) triggers a Prisma error — the
    // atomicity test exercises this path to prove the rollback.
    //
    // Conflicting intent retries (where the existing capability
    // set would silently merge or widen into a different set
    // than the customer originally requested) surface as
    // `IntentConflictError` from inside the transaction; the
    // service translates that to `INTENT_FORBIDDEN` so the
    // customer receives a single safe-envelope copy. The
    // dedicated "add the other capability" command (a later
    // boundary) is the explicit path to a wider capability set.
    try {
      await this.deps.authRepository.provisionIntentAtomically({
        workspaceId: canonicalPersonalWorkspaceId,
        userAccountId: input.userAccountId,
        capabilities,
      });
    } catch (err) {
      const translated = translateAuthorizationError(err);
      if (translated) throw translated;
      throw err;
    }

    return {
      user: await this.loadPublicUser(input.userAccountId, "converged"),
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
