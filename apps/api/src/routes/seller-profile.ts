// SellerProfile route (M2 #84).
//
// Background: the M2 seller-onboarding slice exposes the Professional
// Profile lifecycle for a Seller-capable Personal Workspace. Four
// commands hang off this route family:
//
//   - PUT  /api/workspaces/:workspaceId/seller-profile/draft
//     Lazy first-save / resume / update-draft. Idempotent on
//     (workspaceId) via the unique constraint.
//
//   - POST /api/workspaces/:workspaceId/seller-profile/publish
//     Atomic Draft -> Published transition with immutable evidence
//     row insertion. The client supplies `idempotencyKey` (UUID) to
//     converge transport retries on the already-persisted outcome.
//
//   - PUT  /api/workspaces/:workspaceId/seller-profile
//     Atomic full field set replacement on a Published profile.
//     Same idempotencyKey contract as publish.
//
//   - GET  /api/workspaces/:workspaceId/seller-profile
//     Editor / review on-mount read of the OwnerView shape
//     (includes Draft rows for the owner; never exposed publicly).
//
// Authorization contract:
//   - The route authenticates the session via
//     `AuthenticationService.resolveSession(sessionId)`.
//   - The service layer revalidates current membership on the
//     target Personal Workspace + the Seller capability
//     precondition (Personal-Workspace-only AND Seller-capable).
//   - Organization seller-profile administration is OUT OF SCOPE
//     for #84; a Seller-capable Organization actor receives
//     `SELLER_PROFILE_FORBIDDEN` regardless of capability.
//
// Body contract (request schemas in @soundhub/types):
//   - All write commands carry the full public field set
//     (identity, basedIn, disciplines).
//   - Publish / update additionally carry `confirmationVersion`
//     (the immutable document identifier) and `idempotencyKey`
//     (UUID generated client-side at the start of a new
//     publication attempt; retained across uncertain transport
//     outcomes and explicit Retry actions; cleared only on
//     definitive success, payload change, or user abandonment).
//   - `returnTo` is optional and revalidated via the existing
//     `resolvePostCommandReturnDestination` helper. The response
//     echoes only the validated `returnTo` AND the SERVER-RESOLVED
//     `safeReturnTo`.

import { Router, type Request, type Response } from "express";
import {
  sellerProfileDraftRequestV1Schema,
  sellerProfileDraftResponseV1Schema,
  sellerProfileGetResponseV1Schema,
  sellerProfilePublicationResponseV1Schema,
  sellerProfilePublishRequestV1Schema,
  sellerProfileUpdateRequestV1Schema,
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
import type {
  SellerProfileService} from "../services/seller-profile.service.js";
import {
  SellerProfileServiceError,
} from "../services/seller-profile.service.js";

const SELLER_PROFILE_REQUEST_BODY_LIMIT = 16 * 1024;

export interface SellerProfileRouteDeps {
  readonly service: SellerProfileService;
  readonly authenticationService: AuthenticationService;
  readonly allowedReturnOrigin: string;
}

export function createSellerProfileRouter(deps: SellerProfileRouteDeps): Router {
  const router = Router({ mergeParams: true });
  // The router is mounted at `/api/workspaces`, so the URL path
  // remaining in the router is `/:workspaceId/seller-profile/...`.
  // The intent router at `apps/api/src/routes/intent.ts:99` uses
  // the same shape (`/:workspaceId/intent`); mirror it here so
  // the `:workspaceId` param is available to the handlers.
  router.put("/:workspaceId/seller-profile/draft", (req, res) => {
    void handleDraft(req, res, deps);
  });
  router.post("/:workspaceId/seller-profile/publish", (req, res) => {
    void handlePublish(req, res, deps);
  });
  router.put("/:workspaceId/seller-profile", (req, res) => {
    void handleUpdate(req, res, deps);
  });
  router.get("/:workspaceId/seller-profile", (req, res) => {
    void handleGet(req, res, deps);
  });
  return router;
}

function readSessionCookie(req: Request): string | undefined {
  // Mirror the project-request-route-helpers / intent-route
  // patterns. The cookie name is the same as every other route
  // in the application.
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
  // The intent router's body parser middleware runs ahead of the
  // seller-profile router (both are mounted at `/api/workspaces`)
  // and populates `req.body` for every request. When the parsed
  // body is already available, use it directly. Otherwise fall
  // through to a streaming read with a size cap. Mirrors the
  // intent-route pattern at `apps/api/src/routes/intent.ts:296-301`.
  const existing: unknown = req.body;
  if (existing !== undefined && existing !== null) {
    return existing;
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    received += buffer.length;
    if (received > SELLER_PROFILE_REQUEST_BODY_LIMIT) {
      throw new SellerProfileServiceError(
        "Request body exceeds the maximum allowed size",
        "SELLER_PROFILE_INVALID",
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
  deps: SellerProfileRouteDeps,
): Promise<{ userAccountId: string; workspaceId: string; freshUser: Bg1PublicUserV1 } | null> {
  const workspaceId = (req.params.workspaceId ?? "").trim();
  if (!workspaceId) {
    writeSafeError(
      res,
      buildSafeError(
        "SELLER_PROFILE_INVALID",
        "Missing workspaceId",
        undefined,
        getRequestId(req as Request & { requestId?: string }),
      ),
    );
    return null;
  }
  const sessionId = readSessionCookie(req);
  // Use `resolveSessionWithSetupState` (not `resolveSession`) so we
  // can build the `Bg1PublicUserV1` (which includes `setupState`)
  // required by `resolvePostCommandReturnDestination`. The route
  // does not mutate state on this read; the same read-only
  // classification feeds `/api/auth/me`.
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

async function handleDraft(
  req: Request,
  res: Response,
  deps: SellerProfileRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  let rawBody: unknown;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    if (err instanceof SellerProfileServiceError) {
      writeTranslatedError(res, err.code, err.message, requestId);
      return;
    }
    writeSafeError(
      res,
      buildSafeError("SELLER_PROFILE_INVALID", "Malformed request body", undefined, requestId),
    );
    return;
  }
  const parsed = sellerProfileDraftRequestV1Schema.safeParse(rawBody);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    writeSafeError(
      res,
      buildSafeError("SELLER_PROFILE_INVALID", "Malformed draft request", fields, requestId),
    );
    return;
  }
  try {
    const result = await deps.service.saveDraft({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
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
      sellerProfileDraftResponseV1Schema.parse({
        ...result,
        safeReturnTo,
      }),
    );
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function handlePublish(
  req: Request,
  res: Response,
  deps: SellerProfileRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  let rawBody: unknown;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    if (err instanceof SellerProfileServiceError) {
      writeTranslatedError(res, err.code, err.message, requestId);
      return;
    }
    writeSafeError(
      res,
      buildSafeError("SELLER_PROFILE_INVALID", "Malformed request body", undefined, requestId),
    );
    return;
  }
  const parsed = sellerProfilePublishRequestV1Schema.safeParse(rawBody);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    writeSafeError(
      res,
      buildSafeError("SELLER_PROFILE_INVALID", "Malformed publish request", fields, requestId),
    );
    return;
  }
  try {
    const result = await deps.service.publishProfile({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
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
      sellerProfilePublicationResponseV1Schema.parse({
        ...result,
        safeReturnTo,
      }),
    );
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function handleUpdate(
  req: Request,
  res: Response,
  deps: SellerProfileRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  let rawBody: unknown;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    if (err instanceof SellerProfileServiceError) {
      writeTranslatedError(res, err.code, err.message, requestId);
      return;
    }
    writeSafeError(
      res,
      buildSafeError("SELLER_PROFILE_INVALID", "Malformed request body", undefined, requestId),
    );
    return;
  }
  const parsed = sellerProfileUpdateRequestV1Schema.safeParse(rawBody);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    writeSafeError(
      res,
      buildSafeError("SELLER_PROFILE_INVALID", "Malformed update request", fields, requestId),
    );
    return;
  }
  try {
    const result = await deps.service.updatePublishedProfile({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
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
      sellerProfilePublicationResponseV1Schema.parse({
        ...result,
        safeReturnTo,
      }),
    );
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function handleGet(req: Request, res: Response, deps: SellerProfileRouteDeps): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  try {
    const result = await deps.service.getCurrentProfile({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
    });
    writeJson(res, 200, sellerProfileGetResponseV1Schema.parse(result));
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function resolveSafeReturnTo(
  deps: SellerProfileRouteDeps,
  freshUser: import("@soundhub/types").Bg1PublicUserV1,
  workspaceId: string,
  returnTo: string | undefined,
): Promise<string | null> {
  if (!returnTo) return null;
  try {
    const resolved = resolvePostCommandReturnDestination({
      returnTo,
      freshUser,
      actingWorkspaceId: workspaceId,
      allowedOrigin: deps.allowedReturnOrigin,
    });
    return resolved?.path ?? null;
  } catch (err) {
    if (err instanceof SafeReturnToFallback) {
      return null;
    }
    throw err;
  }
}

function writeJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function writeServiceError(res: Response, err: unknown, requestId: string): void {
  if (err instanceof SellerProfileServiceError) {
    writeTranslatedError(res, err.code, err.message, requestId);
    return;
  }
  console.error(`[seller-profile] requestId=${requestId} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "SELLER_PROFILE_INTERNAL_FAILED",
      "An unexpected error occurred while processing the request.",
      undefined,
      requestId,
    ),
  );
}

function writeTranslatedError(
  res: Response,
  code: SellerProfileServiceError["code"],
  message: string,
  requestId: string,
): void {
  writeSafeError(res, buildSafeError(code, message, undefined, requestId));
}
