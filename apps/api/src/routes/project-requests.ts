// Express ProjectRequest routes (BG4).
//
// Background: ticket #62 requires the API surface that lets an
// authorized buyer create a ProjectRequest, the seller accept or
// decline, and either side view / list requests they belong to. The
// routes follow the same patterns as the BG3 matchmaker routes:
//
//   - Express owns untrusted JSON parsing and the safe error
//     envelope.
//   - The application service owns authorization and state
//     transitions; the route never reads Workspace.ownerUserId.
//   - The route revalidates the authenticated session on every
//     request; a stale cookie fails closed with SESSION_INVALID.
//
// Routes:
//
//   POST /api/project-requests
//     Body: { actingWorkspaceId, projectBriefId, serviceOfferingId }.
//     Response: { ok: true, projectRequest } (a Pending request;
//     never a Deal).
//
//   GET /api/project-requests/:projectRequestId?actingWorkspaceId=...
//     Response: { projectRequest }. Revalidates current membership
//     on every read.
//
//   GET /api/project-requests?actingWorkspaceId=...&status=Pending|...
//     Response: { projectRequests }. Seller inbox uses status=Pending.
//
//   POST /api/project-requests/:projectRequestId/accept
//     Body: { actingWorkspaceId }. Response: { ok: true,
//     projectRequest, deal }. Atomically transitions Pending to
//     Accepted and creates exactly one Negotiating Deal.
//
//   POST /api/project-requests/:projectRequestId/decline
//     Body: { actingWorkspaceId }. Response: { ok: true,
//     projectRequest }. Atomically transitions Pending to Declined
//     and creates NO Deal.

import { Router, type NextFunction, type Request, type Response } from "express";
import {
  acceptProjectRequestResponseV1Schema,
  createProjectRequestRequestV1Schema,
  createProjectRequestResponseV1Schema,
  declineProjectRequestResponseV1Schema,
  getProjectRequestResponseV1Schema,
  listProjectRequestsResponseV1Schema,
  respondProjectRequestRequestV1Schema,
  projectRequestStatusValuesV1,
  type ApiErrorCodeV1,
} from "@soundhub/types";
import { ZodError } from "zod";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
  type SafeErrorResponse,
} from "../lib/errors.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";
import type { AuthenticationService } from "../services/authentication.service.js";
import { AuthorizationError } from "../services/workspace-authorization.service.js";
import {
  ProjectRequestError,
  type ProjectRequestService,
} from "../project-request/project-request.service.js";

export interface ProjectRequestRouteDeps {
  readonly authenticationService: AuthenticationService;
  readonly projectRequestService: ProjectRequestService;
}

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const MAX_PATH_PARAM_LENGTH = 128;

export function createProjectRequestRouter(deps: ProjectRequestRouteDeps): Router {
  const router = Router();

  // List BEFORE `:projectRequestId` so the literal route wins the
  // Express path match. (Express's path-to-regexp would otherwise
  // treat `pending` as a path param; this explicit ordering
  // prevents that ambiguity.)
  router.get("/", (req, res, next) => {
    handleListProjectRequests(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });

  router.post("/", (req, res, next) => {
    handleCreateProjectRequest(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });

  router.get("/:projectRequestId", (req, res, next) => {
    handleGetProjectRequest(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });

  router.post("/:projectRequestId/accept", (req, res, next) => {
    handleAcceptProjectRequest(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });

  router.post("/:projectRequestId/decline", (req, res, next) => {
    handleDeclineProjectRequest(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });

  return router;
}

function forwardUnhandledRejection(
  req: Request,
  res: Response,
  next: NextFunction,
  err: unknown,
): void {
  if (res.headersSent) {
    console.error(
      `[project-requests] requestId=${resolveRequestId(req)} handler-rejection-after-write:`,
      err,
    );
    return;
  }
  next(err);
}

// ---------- POST /api/project-requests ----------

async function handleCreateProjectRequest(
  req: Request,
  res: Response,
  deps: ProjectRequestRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const sessionId = readSessionCookie(req);
  const session = await deps.authenticationService.resolveSession(sessionId);
  if (!session) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to create a ProjectRequest.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const rawBody = await readJsonBodyOrRespond(req, res, requestId);
  if (rawBody === undefined) return;

  let parsed;
  try {
    parsed = createProjectRequestRequestV1Schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "PROJECT_REQUEST_INVALID",
          "ProjectRequest creation failed schema validation.",
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return;
    }
    throw err;
  }

  let result;
  try {
    result = await deps.projectRequestService.createProjectRequest({
      userAccountId: session.userAccountId,
      actingWorkspaceId: parsed.actingWorkspaceId,
      projectBriefId: parsed.projectBriefId,
      serviceOfferingId: parsed.serviceOfferingId,
    });
  } catch (err) {
    if (err instanceof ProjectRequestError) {
      writeProjectRequestError(res, err, requestId);
      return;
    }
    if (err instanceof AuthorizationError) {
      // ProjectRequest is buyer-side; collapse both authorization
      // errors to PROJECT_REQUEST_FORBIDDEN so the route contract
      // emits a single safe envelope code for the buyer side.
      writeSafeError(
        res,
        buildSafeError("PROJECT_REQUEST_FORBIDDEN", err.message, undefined, requestId),
      );
      return;
    }
    console.error(`[project-requests] requestId=${requestId} unhandled:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while creating the ProjectRequest.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const validated = createProjectRequestResponseV1Schema.safeParse({
    ok: true,
    projectRequest: result.projectRequest,
  });
  if (!validated.success) {
    console.error(
      `[project-requests] requestId=${requestId} response-schema-drift:`,
      validated.error,
    );
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while preparing the response.",
        undefined,
        requestId,
      ),
    );
    return;
  }
  res.status(201).json(validated.data);
}

// ---------- GET /api/project-requests/:projectRequestId ----------

async function handleGetProjectRequest(
  req: Request,
  res: Response,
  deps: ProjectRequestRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const sessionId = readSessionCookie(req);
  const session = await deps.authenticationService.resolveSession(sessionId);
  if (!session) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to fetch a ProjectRequest.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const projectRequestId = readPathParam(req, "projectRequestId");
  if (!projectRequestId) {
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "ProjectRequest id is missing or malformed.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const actingWorkspaceId = readActingWorkspaceFromQuery(req);
  if (!actingWorkspaceId) {
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "actingWorkspaceId is required.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  let result;
  try {
    result = await deps.projectRequestService.getProjectRequest({
      userAccountId: session.userAccountId,
      actingWorkspaceId,
      projectRequestId,
    });
  } catch (err) {
    if (err instanceof ProjectRequestError) {
      writeProjectRequestError(res, err, requestId);
      return;
    }
    if (err instanceof AuthorizationError) {
      writeSafeError(
        res,
        buildSafeError("PROJECT_REQUEST_FORBIDDEN", err.message, undefined, requestId),
      );
      return;
    }
    console.error(`[project-requests] requestId=${requestId} unhandled:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while fetching the ProjectRequest.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const validated = getProjectRequestResponseV1Schema.safeParse({
    projectRequest: result.projectRequest,
  });
  if (!validated.success) {
    console.error(
      `[project-requests] requestId=${requestId} get-response-schema-drift:`,
      validated.error,
    );
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while preparing the response.",
        undefined,
        requestId,
      ),
    );
    return;
  }
  res.status(200).json(validated.data);
}

// ---------- GET /api/project-requests ----------

async function handleListProjectRequests(
  req: Request,
  res: Response,
  deps: ProjectRequestRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const sessionId = readSessionCookie(req);
  const session = await deps.authenticationService.resolveSession(sessionId);
  if (!session) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to list ProjectRequests.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const actingWorkspaceId = readActingWorkspaceFromQuery(req);
  if (!actingWorkspaceId) {
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "actingWorkspaceId is required.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const statusFilterRaw = readQueryString(req, "status");
  let statusFilter: "Pending" | "Accepted" | "Declined" | undefined;
  if (statusFilterRaw !== undefined) {
    if (!(projectRequestStatusValuesV1 as readonly string[]).includes(statusFilterRaw)) {
      writeSafeError(
        res,
        buildSafeError(
          "PROJECT_REQUEST_INVALID",
          "status filter is invalid.",
          undefined,
          requestId,
        ),
      );
      return;
    }
    statusFilter = statusFilterRaw as "Pending" | "Accepted" | "Declined";
  }

  let result;
  try {
    result = await deps.projectRequestService.listProjectRequests({
      userAccountId: session.userAccountId,
      actingWorkspaceId,
      ...(statusFilter ? { statusFilter } : {}),
    });
  } catch (err) {
    if (err instanceof ProjectRequestError) {
      writeProjectRequestError(res, err, requestId);
      return;
    }
    if (err instanceof AuthorizationError) {
      writeSafeError(
        res,
        buildSafeError("PROJECT_REQUEST_FORBIDDEN", err.message, undefined, requestId),
      );
      return;
    }
    console.error(`[project-requests] requestId=${requestId} unhandled:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while listing ProjectRequests.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const validated = listProjectRequestsResponseV1Schema.safeParse({
    projectRequests: result.projectRequests,
  });
  if (!validated.success) {
    console.error(
      `[project-requests] requestId=${requestId} list-response-schema-drift:`,
      validated.error,
    );
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while preparing the response.",
        undefined,
        requestId,
      ),
    );
    return;
  }
  res.status(200).json(validated.data);
}

// ---------- POST /api/project-requests/:projectRequestId/accept ----------

async function handleAcceptProjectRequest(
  req: Request,
  res: Response,
  deps: ProjectRequestRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const sessionId = readSessionCookie(req);
  const session = await deps.authenticationService.resolveSession(sessionId);
  if (!session) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to accept a ProjectRequest.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const projectRequestId = readPathParam(req, "projectRequestId");
  if (!projectRequestId) {
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "ProjectRequest id is missing or malformed.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const rawBody = await readJsonBodyOrRespond(req, res, requestId);
  if (rawBody === undefined) return;

  let parsed;
  try {
    parsed = respondProjectRequestRequestV1Schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "PROJECT_REQUEST_INVALID",
          "Accept request failed schema validation.",
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return;
    }
    throw err;
  }

  let result;
  try {
    result = await deps.projectRequestService.acceptProjectRequest({
      userAccountId: session.userAccountId,
      actingWorkspaceId: parsed.actingWorkspaceId,
      projectRequestId,
    });
  } catch (err) {
    if (err instanceof ProjectRequestError) {
      writeProjectRequestError(res, err, requestId);
      return;
    }
    if (err instanceof AuthorizationError) {
      writeSafeError(
        res,
        buildSafeError("PROJECT_REQUEST_FORBIDDEN", err.message, undefined, requestId),
      );
      return;
    }
    console.error(`[project-requests] requestId=${requestId} unhandled:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while accepting the ProjectRequest.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const validated = acceptProjectRequestResponseV1Schema.safeParse({
    ok: true,
    projectRequest: result.projectRequest,
    deal: result.deal,
  });
  if (!validated.success) {
    console.error(
      `[project-requests] requestId=${requestId} accept-response-schema-drift:`,
      validated.error,
    );
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while preparing the response.",
        undefined,
        requestId,
      ),
    );
    return;
  }
  res.status(200).json(validated.data);
}

// ---------- POST /api/project-requests/:projectRequestId/decline ----------

async function handleDeclineProjectRequest(
  req: Request,
  res: Response,
  deps: ProjectRequestRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const sessionId = readSessionCookie(req);
  const session = await deps.authenticationService.resolveSession(sessionId);
  if (!session) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to decline a ProjectRequest.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const projectRequestId = readPathParam(req, "projectRequestId");
  if (!projectRequestId) {
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "ProjectRequest id is missing or malformed.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const rawBody = await readJsonBodyOrRespond(req, res, requestId);
  if (rawBody === undefined) return;

  let parsed;
  try {
    parsed = respondProjectRequestRequestV1Schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "PROJECT_REQUEST_INVALID",
          "Decline request failed schema validation.",
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return;
    }
    throw err;
  }

  let result;
  try {
    result = await deps.projectRequestService.declineProjectRequest({
      userAccountId: session.userAccountId,
      actingWorkspaceId: parsed.actingWorkspaceId,
      projectRequestId,
    });
  } catch (err) {
    if (err instanceof ProjectRequestError) {
      writeProjectRequestError(res, err, requestId);
      return;
    }
    if (err instanceof AuthorizationError) {
      writeSafeError(
        res,
        buildSafeError("PROJECT_REQUEST_FORBIDDEN", err.message, undefined, requestId),
      );
      return;
    }
    console.error(`[project-requests] requestId=${requestId} unhandled:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while declining the ProjectRequest.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const validated = declineProjectRequestResponseV1Schema.safeParse({
    ok: true,
    projectRequest: result.projectRequest,
  });
  if (!validated.success) {
    console.error(
      `[project-requests] requestId=${requestId} decline-response-schema-drift:`,
      validated.error,
    );
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "An unexpected error occurred while preparing the response.",
        undefined,
        requestId,
      ),
    );
    return;
  }
  res.status(200).json(validated.data);
}

// ---------- Helpers ----------

function resolveRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return generateRequestId();
}

function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      const raw = trimmed.slice(SESSION_COOKIE.length + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function readPathParam(req: Request, name: string): string | undefined {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_PARAM_LENGTH) {
    return undefined;
  }
  return value;
}

function readQueryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value;
}

function readActingWorkspaceFromQuery(req: Request): string | undefined {
  const value = readQueryString(req, "actingWorkspaceId");
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > MAX_PATH_PARAM_LENGTH) return undefined;
  return value;
}

function writeProjectRequestError(
  res: Response,
  err: ProjectRequestError,
  requestId: string,
): void {
  const safe: SafeErrorResponse = buildSafeError(err.code, err.message, undefined, requestId);
  console.error(`[project-requests] requestId=${requestId} code=${err.code}:`, err);
  writeSafeError(res, safe);
}

async function readJsonBody(req: Request, res: Response, requestId: string): Promise<unknown> {
  const existing: unknown = req.body;
  if (existing !== undefined && existing !== null) return existing;

  const chunks: Buffer[] = [];
  let total = 0;
  const limit = MAX_REQUEST_BODY_BYTES;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          req.pause();
          writeSafeError(
            res,
            buildSafeError(
              "PROJECT_REQUEST_INVALID",
              `Request body exceeds the ${limit}-byte limit.`,
              undefined,
              requestId,
            ),
          );
          reject(new BodyReadError("payload-too-large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", (err: Error) => reject(err));
    });
  } catch (err) {
    if (err instanceof Error && err.message === "payload-too-large") {
      throw new BodyReadError("payload-too-large");
    }
    throw err;
  }
  if (res.writableEnded) {
    throw new BodyReadError("response-already-ended");
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    writeSafeError(
      res,
      buildSafeError(
        "PROJECT_REQUEST_INVALID",
        "Request body is not valid JSON.",
        undefined,
        requestId,
      ),
    );
    throw new BodyReadError("invalid-json");
  }
}

class BodyReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyReadError";
  }
}

async function readJsonBodyOrRespond(
  req: Request,
  res: Response,
  requestId: string,
): Promise<unknown> {
  try {
    return await readJsonBody(req, res, requestId);
  } catch (err) {
    if (err instanceof BodyReadError) {
      return undefined;
    }
    throw err;
  }
}

// Re-export for tests that want to assert error codes verbatim.
export type ProjectRequestApiErrorCode = ApiErrorCodeV1;
