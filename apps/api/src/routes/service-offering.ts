// ServiceOffering route (M2 #85).
//
// Background: the M2 seller-onboarding slice exposes the
// ServiceOffering lifecycle for a Seller-capable Personal Workspace.
// Five commands hang off this route family:
//
//   - PUT  /api/workspaces/:workspaceId/service-offerings/:offeringId/draft
//     Lazy first-save / resume / update-draft. The same-attempt
//     retry identity is enforced via the application-layer compare-
//     and-set UPDATE; a deliberate second-offering creation is a
//     SEPARATE POST (owned by a different ticket — not in #85 scope).
//
//   - POST /api/workspaces/:workspaceId/service-offerings/:offeringId/activate
//     Atomic Draft → Active transition with immutable evidence
//     row insertion. The client supplies `idempotencyKey` (UUID)
//     to converge transport retries on the already-persisted
//     outcome.
//
//   - GET  /api/workspaces/:workspaceId/service-offerings
//     Editor listing on-mount read of the OwnerView list.
//
//   - GET  /api/workspaces/:workspaceId/service-offerings/:offeringId
//     Editor on-mount read of the OwnerView shape (includes Draft
//     rows for the owner; never exposed publicly).
//
// Authorization contract:
//   - The route authenticates the session via
//     `AuthenticationService.resolveSessionWithSetupState`.
//   - The service layer revalidates current membership on the
//     target Personal Workspace + the Seller capability
//     precondition (Personal-Workspace-only AND Seller-capable).
//   - Organization seller-offering administration is OUT OF SCOPE
//     for #85; a Seller-capable Organization actor receives
//     `SERVICE_OFFERING_FORBIDDEN` regardless of capability.
//
// Body contract (request schemas in @soundhub/types):
//   - The draft write carries the full RELAXED field set
//     (every field is optional; a partial first-save does not
//     silently fabricate a value the seller never chose).
//   - The activate write carries the full STRICT field set plus
//     `confirmationVersion` (the immutable document identifier)
//     and `idempotencyKey` (UUID generated client-side at the
//     start of a new activation attempt; retained across uncertain
//     transport outcomes and explicit Retry actions; cleared only
//     on definitive success or user-initiated payload change).
//   - `returnTo` is optional and revalidated via the existing
//     `resolvePostCommandReturnDestination` helper.

import { Router, type Request, type Response } from "express";
import {
  serviceOfferingActivateRequestV1Schema,
  serviceOfferingActivationResponseV1Schema,
  serviceOfferingDraftRequestV1Schema,
  serviceOfferingDraftResponseV1Schema,
  serviceOfferingGetResponseV1Schema,
  serviceOfferingOwnerListResponseV1Schema,
  type Bg1PublicUserV1,
} from "@soundhub/types";
import type { AuthenticationService } from "../services/authentication.service.js";
import { toPublicUser } from "../dto/public-mappers.js";
import { buildSafeError, generateRequestId, writeSafeError } from "../lib/errors.js";
import {
  resolvePostCommandReturnDestination,
  SafeReturnToFallback,
} from "../lib/post-command-return-destination.js";
import { getRequestId } from "../lib/request-id.js";
import type { ServiceOfferingService } from "../services/service-offering.service.js";
import { ServiceOfferingServiceError } from "../services/service-offering.service.js";

const SERVICE_OFFERING_REQUEST_BODY_LIMIT = 32 * 1024;

export interface ServiceOfferingRouteDeps {
  readonly service: ServiceOfferingService;
  readonly authenticationService: AuthenticationService;
  readonly allowedReturnOrigin: string;
}

export function createServiceOfferingRouter(deps: ServiceOfferingRouteDeps): Router {
  const router = Router({ mergeParams: true });
  // The router is mounted at `/api/workspaces`, so the URL path
  // remaining in the router is `/:workspaceId/service-offerings/...`.
  // The intent router at `apps/api/src/routes/intent.ts:99` uses the
  // same shape (`/:workspaceId/intent`); mirror it here so the
  // `:workspaceId` param is available to the handlers.
  router.put("/:workspaceId/service-offerings/:offeringId/draft", (req, res) => {
    void handleDraft(req, res, deps);
  });
  router.post("/:workspaceId/service-offerings/:offeringId/activate", (req, res) => {
    void handleActivate(req, res, deps);
  });
  router.get("/:workspaceId/service-offerings", (req, res) => {
    void handleList(req, res, deps);
  });
  router.get("/:workspaceId/service-offerings/:offeringId", (req, res) => {
    void handleGet(req, res, deps);
  });
  return router;
}

function readSessionCookie(req: Request): string | undefined {
  // Mirror the seller-profile route / intent route patterns. The
  // cookie name is the same as every other route in the application.
  const raw = req.headers.cookie;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.startsWith("soundhub_session=")) {
      return trimmed.slice("soundhub_session=".length);
    }
  }
  return undefined;
}

async function readBody(req: Request): Promise<unknown> {
  const existing: unknown = req.body;
  if (existing !== undefined && existing !== null) {
    return existing;
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    received += buffer.length;
    if (received > SERVICE_OFFERING_REQUEST_BODY_LIMIT) {
      throw new ServiceOfferingServiceError(
        "Request body exceeds the maximum allowed size",
        "SERVICE_OFFERING_INVALID",
      );
    }
    chunks.push(buffer);
  }
  if (received === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function resolveActor(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<{ userAccountId: string; workspaceId: string; freshUser: Bg1PublicUserV1 } | null> {
  const workspaceId = (req.params.workspaceId ?? "").trim();
  if (!workspaceId) {
    writeSafeError(
      res,
      buildSafeError(
        "SERVICE_OFFERING_INVALID",
        "Missing workspaceId",
        undefined,
        getRequestId(req as Request & { requestId?: string }),
      ),
    );
    return null;
  }
  const sessionId = readSessionCookie(req);
  const resolved = await deps.authenticationService.resolveSessionWithSetupState(sessionId);
  if (!resolved) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Authentication required.",
        undefined,
        getRequestId(req as Request & { requestId?: string }),
      ),
    );
    return null;
  }
  const freshUser: Bg1PublicUserV1 = toPublicUser(resolved.user, resolved.setupState);
  return { userAccountId: freshUser.userAccountId, workspaceId, freshUser };
}

function readOfferingId(req: Request): string | null {
  const raw = req.params["offeringId"];
  return typeof raw === "string" && raw.length > 0 && raw.length <= 128 ? raw : null;
}

async function handleDraft(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  const offeringId = readOfferingId(req);
  if (!offeringId) {
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Missing serviceOfferingId", undefined, requestId),
    );
    return;
  }
  let rawBody: unknown;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    if (err instanceof ServiceOfferingServiceError) {
      writeTranslatedError(res, err.code, err.message, err.fieldErrors, requestId);
      return;
    }
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Malformed request body", undefined, requestId),
    );
    return;
  }
  const parsed = serviceOfferingDraftRequestV1Schema.safeParse(rawBody);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Malformed draft request", fields, requestId),
    );
    return;
  }
  try {
    const result = await deps.service.saveDraft({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
      offeringId,
      request: parsed.data,
    });
    const safeReturnTo = await resolveSafeReturnTo(
      deps,
      actor.freshUser,
      actor.workspaceId,
      parsed.data.returnTo,
    );
    writeJson(
      res,
      200,
      serviceOfferingDraftResponseV1Schema.parse({
        ...result,
        safeReturnTo,
      }),
    );
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function handleActivate(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  const offeringId = readOfferingId(req);
  if (!offeringId) {
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Missing serviceOfferingId", undefined, requestId),
    );
    return;
  }
  let rawBody: unknown;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    if (err instanceof ServiceOfferingServiceError) {
      writeTranslatedError(res, err.code, err.message, err.fieldErrors, requestId);
      return;
    }
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Malformed request body", undefined, requestId),
    );
    return;
  }
  const parsed = serviceOfferingActivateRequestV1Schema.safeParse(rawBody);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Malformed activate request", fields, requestId),
    );
    return;
  }
  try {
    const result = await deps.service.activate({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
      offeringId,
      request: parsed.data,
      requestId,
    });
    const safeReturnTo = await resolveSafeReturnTo(
      deps,
      actor.freshUser,
      actor.workspaceId,
      parsed.data.returnTo,
    );
    writeJson(
      res,
      200,
      serviceOfferingActivationResponseV1Schema.parse({
        ...result,
        safeReturnTo,
      }),
    );
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function handleList(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  try {
    const result = await deps.service.listOfferingsForOwner({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
    });
    writeJson(res, 200, serviceOfferingOwnerListResponseV1Schema.parse(result));
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function handleGet(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  const offeringId = readOfferingId(req);
  if (!offeringId) {
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Missing serviceOfferingId", undefined, requestId),
    );
    return;
  }
  try {
    const result = await deps.service.getCurrentOffering({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
      offeringId,
    });
    writeJson(res, 200, serviceOfferingGetResponseV1Schema.parse(result));
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

function resolveSafeReturnTo(
  deps: ServiceOfferingRouteDeps,
  freshUser: Bg1PublicUserV1,
  workspaceId: string,
  returnTo: string | undefined,
): Promise<string | null> {
  if (!returnTo) return Promise.resolve(null);
  try {
    const resolved = resolvePostCommandReturnDestination({
      returnTo,
      freshUser,
      actingWorkspaceId: workspaceId,
      allowedOrigin: deps.allowedReturnOrigin,
    });
    return Promise.resolve(resolved?.path ?? null);
  } catch (err) {
    if (err instanceof SafeReturnToFallback) {
      return Promise.resolve(null);
    }
    throw err;
  }
}

function writeJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function writeServiceError(res: Response, err: unknown, requestId: string): void {
  if (err instanceof ServiceOfferingServiceError) {
    writeTranslatedError(res, err.code, err.message, err.fieldErrors, requestId);
    return;
  }
  console.error(`[service-offering] requestId=${requestId} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "SERVICE_OFFERING_INTERNAL_FAILED",
      "An unexpected error occurred while processing the request.",
      undefined,
      requestId,
    ),
  );
}

function writeTranslatedError(
  res: Response,
  code: ServiceOfferingServiceError["code"],
  message: string,
  fieldErrors: ServiceOfferingServiceError["fieldErrors"],
  requestId: string,
): void {
  const fields = fieldErrors.length > 0 ? fieldErrors : undefined;
  writeSafeError(res, buildSafeError(code, message, fields, requestId));
}
