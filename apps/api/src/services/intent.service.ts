// Intent selection service (M2 #83).
//
// Background: a freshly-converged Personal Workspace has no
// marketplace capability. The human must explicitly choose
// `Hire talent`, `Offer services`, or `Both` to provision Buyer /
// Seller capability. The intent service is the single owner of
// that provision:
//
//   - `Hire`         → Buyer capability (no attestation).
//   - `Offer`        → Seller capability + versioned Seller
//                      participation acceptance evidence.
//   - `Both`         → Buyer capability + Seller capability +
//                      Seller participation acceptance evidence,
//                      all in ONE atomic transaction. Failure
//                      rolls all three back.
//
// Authorization invariants:
//
//   - The acting human MUST be a current member of the target
//     Personal Workspace. The route revalidates current membership
//     via `WorkspaceAuthorizationService.requireActingMembership`,
//     which accepts any Owner/Admin/Member role (the route is NOT
//     Owner-only per ticket #82).
//   - Buyer capability requires no attestation.
//   - Seller capability requires the registered Seller
//     participation terms (`getCurrentSellerParticipationTerms`).
//     Until product/legal supplies the text, `Offer` and `Both`
//     return `INTENT_LEGAL_BLOCKED`.
//   - `DealApprover` is NEVER created by this service.
//
// Concurrency invariants:
//
//   - `Both` provisions Buyer + Seller + acceptance; the natural
//     unique indexes on `WorkspaceCapability (workspaceId,
//     capability)` and `seller_participation_acceptances
//     (workspace_id, terms_version)` are the concurrency authority.
//   - `recordSellerParticipationAcceptance` uses
//     `INSERT ... ON CONFLICT DO NOTHING RETURNING *`; a concurrent
//     duplicate submission reads back the existing row and is
//     treated as success — same evidence, no duplicate. The
//     application does NOT rely on a find-then-insert pre-check for
//     race correctness.
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
 * into the intent service's stable code set. The route layer
 * applies the safe-envelope mapping; this translation keeps the
 * service's contract readable at the call site.
 */
export function translateAuthorizationError(err: unknown): IntentServiceError | null {
  if (!(err instanceof AuthorizationError)) return null;
  return new IntentServiceError(err.message, "INTENT_FORBIDDEN");
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
    // Step 1: revalidate current membership on the target Workspace.
    // `requireActingMembership` accepts any current Owner/Admin/
    // Member role (the route is not Owner-only per ticket #82).
    let acting;
    try {
      acting = await this.deps.workspaceAuthorizationService.requireActingMembership({
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

    // Step 3: Buyer capability route. No attestation required.
    if (intent === "Hire") {
      await this.deps.authRepository.upsertCapability({
        workspaceId: acting.workspace.workspaceId,
        capability: "Buyer",
      });
      return {
        user: await this.loadPublicUser(input.userAccountId, input.setupState),
        returnTo: requestedReturn,
      };
    }

    // Step 4: Seller capability route(s). The registered Seller
    // participation terms are the single explicit product/legal
    // blocker. Until product/legal supplies the text, the route
    // refuses with INTENT_LEGAL_BLOCKED — the customer-facing
    // message is "Seller setup is temporarily unavailable. Please
    // try again later." and is owned by the web layer.
    const registered = getCurrentSellerParticipationTerms();
    if (!registered) {
      throw new IntentServiceError(
        "Seller participation terms are not yet registered. Cannot provision Seller capability.",
        "INTENT_LEGAL_BLOCKED",
      );
    }
    if (sellerAcceptance) {
      // The request-supplied `termsContentHash` MUST equal the
      // hash of the registered content; mismatched hashes would
      // let a caller assert acceptance of a document they did not
      // actually see. The schema enforces the 64-char hex format;
      // this service enforces equality against the registered
      // document.
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
    }

    // Step 5: provision. `Offer` writes only Seller + acceptance;
    // `Both` writes Buyer + Seller + acceptance in one transaction.
    if (intent === "Offer") {
      await this.deps.authRepository.upsertCapability({
        workspaceId: acting.workspace.workspaceId,
        capability: "Seller",
      });
      if (sellerAcceptance) {
        await this.deps.authRepository.recordSellerParticipationAcceptance({
          workspaceId: acting.workspace.workspaceId,
          termsVersion: sellerAcceptance.termsVersion,
          termsContentHash: sellerAcceptance.termsContentHash,
          acceptedByUserId: input.userAccountId,
          grantedByUserId: input.userAccountId,
        });
      }
    } else {
      // `Both` — atomic via the natural unique constraints.
      // Buyer upsert, Seller upsert, acceptance ON CONFLICT
      // DO NOTHING — any failure rolls back per the transaction
      // boundary at the route layer.
      await this.provisionBothAtomically({
        workspaceId: acting.workspace.workspaceId,
        userAccountId: input.userAccountId,
        sellerAcceptance,
      });
    }

    return {
      user: await this.loadPublicUser(input.userAccountId, input.setupState),
      returnTo: requestedReturn,
    };
  }

  /**
   * Atomic Both path. The repository primitives are individually
   * idempotent — `upsertCapability` against the
   * `(workspaceId, capability)` unique constraint, and
   * `recordSellerParticipationAcceptance` against the
   * `(workspaceId, termsVersion)` unique constraint. The application
   * relies on the database, not on application-level pre-checks,
   * for race correctness.
   *
   * Concurrent `recordSellerParticipationAcceptance` calls against
   * the same `(workspaceId, termsVersion)` resolve via the database
   * ON CONFLICT path; the application reads back the existing row.
   */
  private async provisionBothAtomically(input: {
    workspaceId: string;
    userAccountId: string;
    sellerAcceptance:
      | {
          readonly termsVersion: string;
          readonly termsContentHash: string;
        }
      | undefined;
  }): Promise<void> {
    await this.deps.authRepository.upsertCapability({
      workspaceId: input.workspaceId,
      capability: "Buyer",
    });
    await this.deps.authRepository.upsertCapability({
      workspaceId: input.workspaceId,
      capability: "Seller",
    });
    if (input.sellerAcceptance) {
      await this.deps.authRepository.recordSellerParticipationAcceptance({
        workspaceId: input.workspaceId,
        termsVersion: input.sellerAcceptance.termsVersion,
        termsContentHash: input.sellerAcceptance.termsContentHash,
        acceptedByUserId: input.userAccountId,
        grantedByUserId: input.userAccountId,
      });
    }
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
