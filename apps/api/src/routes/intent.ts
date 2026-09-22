// Intent selection route (M2 #83).
//
// Background: a freshly-converged Personal Workspace has no
// marketplace capability. The human must explicitly choose
// `Hire talent`, `Offer services`, or `Both` to provision Buyer /
// Seller capability. The intent route is the single HTTP entry
// point for that provisioning.
//
// Authorization contract:
//
//   - The route authenticates the session via `resolveSession`.
//     A missing or invalid session returns `SESSION_INVALID`.
//   - The route revalidates current membership on the target
//     Personal Workspace via
//     `WorkspaceAuthorizationService.requirePersonalActingMembership`.
//     A valid current Owner/Admin/Member role on an Organization
//     Workspace does NOT grant intent authority — the route is
//     Personal-Workspace-only.
//   - The acting Workspace id comes from the URL path
//     (`/api/workspaces/:workspaceId/intent`).
//
// Body contract:
//
//   - `intent`: `"Hire" | "Offer" | "Both"` (closed enum).
//   - No `sellerAcceptance` field is carried on the intent
//     surface. #83 does NOT collect a generic Seller
//     participation/terms acceptance at capability-provisioning
//     time — context-specific confirmations remain owned by their
//     later boundaries (SellerProfile publication, media use,
//     ServiceOffering activation, Deal approval authority /
//     approval).
//   - `returnTo`: optional. The route revalidates it via the
//     existing internal-return validation rules
//     (`isValidReturnPath`); invalid values are silently dropped.
//     The successful response echoes only the validated `returnTo`
//     AND the SERVER-RESOLVED `safeReturnTo`.
//
// Response contract:
//
//   - `ok`: `true`.
//   - `user`: the updated public user payload. The intent navigation
//     contract does NOT carry a separate `setupState` field —
//     recovery is already surfaced via the user payload's existing
//     `setupState` field.
//   - `returnTo`: the schema-validated path (or `null`).
//   - `safeReturnTo`: the post-command server-resolved destination
//     against the FRESH post-provision user. The browser consumes
//     ONLY this value (see `apps/web/src/app/lib/navigate-after-
//     intent.ts`).
//
// Error contract:
//
//   - `INTENT_INVALID` (400): malformed request body.
//   - `INTENT_FORBIDDEN` (403): authorization rejection (collapsed
//     by the safe envelope). Includes Personal-Workspace boundary
//     (`INTENT_NOT_PERSONAL` translated to `INTENT_FORBIDDEN`).
//
// M2 (#83) abuse surface: rate-limiting is intentionally deferred
// to a future ticket. The route does NOT introduce a limiter in
// this slice.

import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { intentRequestV1Schema, intentResponseV1Schema } from "@soundhub/types";
import type { AuthenticationService } from "../services/authentication.service.js";
import type { IntentService, IntentServiceError } from "../services/intent.service.js";
import type { PersonalWorkspaceConvergenceService } from "../services/personal-workspace-convergence.service.js";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
} from "../lib/errors.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";
import { isValidReturnPath } from "../lib/return-context.js";
import {
  SafeReturnToFallback,
  resolvePostCommandReturnDestination,
} from "../lib/post-command-return-destination.js";

export interface IntentRouteDeps {
  readonly authenticationService: AuthenticationService;
  readonly intentService: IntentService;
  readonly personalWorkspaceConvergenceService: PersonalWorkspaceConvergenceService;
  readonly allowedReturnOrigin: string;
}

export function createIntentRouter(deps: IntentRouteDeps): Router {
  const router = Router();

  // Body parser. Mirrors the BG1 auth-route pattern: 8 KiB cap,
  // surface INVALID_INTENT_REQUEST (re-using the same envelope
  // code as the auth surface — the safe envelope does not
  // distinguish intent from auth at the malformed-body layer
  // because both are domain-validated request surfaces).
  router.use(parseIntentRequestBody);

  router.post("/:workspaceId/intent", (req, res, next) => {
    handleIntent(req, res, deps).catch((err: unknown) => {
      if (res.headersSent) return;
      next(err);
    });
  });

  return router;
}

// ---------- POST /api/workspaces/:workspaceId/intent ----------

async function handleIntent(req: Request, res: Response, deps: IntentRouteDeps): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const workspaceId = req.params.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    writeSafeError(
      res,
      buildSafeError(
        "INTENT_INVALID",
        "Intent request did not name an acting Workspace.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  // Resolve session. The session cookie is the only authoritative
  // identity signal the route can read.
  const sessionId = readSessionCookie(req);
  const resolved = await deps.authenticationService.resolveSession(sessionId);
  if (!resolved) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to choose marketplace intent.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const rawBody: unknown = req.body;
  let parsed;
  try {
    parsed = intentRequestV1Schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "INTENT_INVALID",
          "Intent request failed schema validation.",
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return;
    }
    throw err;
  }

  // Validate `returnTo` shape server-side. The post-command
  // SERVER-RESOLVED `safeReturnTo` (workspace + capability +
  // route-shape authorization) is computed after the service
  // resolves, against the FRESH post-provision user payload.
  // The browser consumes ONLY `safeReturnTo`.
  const shapeValidatedReturn = parsed.returnTo
    ? isValidReturnPath(parsed.returnTo, deps.allowedReturnOrigin)
      ? parsed.returnTo
      : null
    : null;

  // Derive setupState via the existing convergence classification.
  // Intent is capability-only; recovery is rendered by the
  // dashboard from the user payload's existing `setupState`
  // field. The route never re-classifies recovery as part of
  // intent.
  const kind = await deps.personalWorkspaceConvergenceService.resolveConvergence({
    userAccountId: resolved.userAccountId,
  });
  const setupState: "converged" | "recovery" = kind.kind === "converged" ? "converged" : "recovery";

  try {
    const result = await deps.intentService.submitIntent({
      userAccountId: resolved.userAccountId,
      workspaceId,
      setupState,
      intent: parsed,
    });

    // Resolve `safeReturnTo` against the FRESH post-provision
    // user payload. The browser consumes only this value.
    let safeReturnTo: string | null = null;
    try {
      const resolvedDestination = resolvePostCommandReturnDestination({
        returnTo: shapeValidatedReturn,
        freshUser: result.user,
        actingWorkspaceId:
          result.user.workspaces.find((w) => w.workspaceType === "Personal")?.workspaceId ?? null,
        allowedOrigin: deps.allowedReturnOrigin,
      });
      safeReturnTo = resolvedDestination?.path ?? null;
    } catch (err) {
      if (err instanceof SafeReturnToFallback) {
        safeReturnTo = "/dashboard";
      } else {
        throw err;
      }
    }

    const body = intentResponseV1Schema.parse({
      ok: true,
      user: result.user,
      returnTo: shapeValidatedReturn,
      safeReturnTo,
    });
    res.status(200).json(body);
  } catch (err) {
    if (err instanceof Error && err.name === "IntentServiceError") {
      const intentErr = err as IntentServiceError;
      writeSafeError(res, buildSafeError(intentErr.code, intentErr.message, undefined, requestId));
      return;
    }
    // Mirror the BG1 pattern: surface AUTH_FAILED for unexpected
    // internal failures without echoing the underlying message.
    console.error(`[intent] requestId=${requestId} unhandled:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "AUTH_FAILED",
        "An unexpected error occurred while processing the intent request.",
        undefined,
        requestId,
      ),
    );
  }
}

// ---------- Body parser middleware ----------

const INTENT_REQUEST_BODY_LIMIT = 8 * 1024;

function parseIntentRequestBody(req: Request, res: Response, next: (err?: unknown) => void): void {
  const existing: unknown = req.body;
  if (existing !== undefined && existing !== null) {
    next();
    return;
  }
  const requestId = resolveRequestId(req);
  const chunks: Buffer[] = [];
  let total = 0;

  req.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > INTENT_REQUEST_BODY_LIMIT) {
      req.pause();
      res.setHeader("x-request-id", requestId);
      writeSafeError(
        res,
        buildSafeError("INTENT_INVALID", "Request body exceeds the limit.", undefined, requestId),
      );
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    res.setHeader("x-request-id", requestId);
    if (chunks.length === 0) {
      (req as Request & { body?: unknown }).body = {};
      next();
      return;
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      (req as Request & { body?: unknown }).body = parsed;
      next();
    } catch {
      writeSafeError(
        res,
        buildSafeError("INTENT_INVALID", "Request body is not valid JSON.", undefined, requestId),
      );
    }
  });
  req.on("error", (err: Error) => {
    next(err);
  });
}

function resolveRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return generateRequestId();
}

/**
 * Read the opaque session id from the request's `Cookie` header.
 * Malformed percent-encoding (e.g. `%zz`) is treated as "no
 * session", NOT a thrown URIError. Mirrors the BG1 auth-route
 * pattern; this is a private helper because the session cookie
 * module intentionally only exports writers.
 */
function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return undefined;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${SESSION_COOKIE}=`)) continue;
    const raw = trimmed.slice(SESSION_COOKIE.length + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---------- Type-only re-exports ----------
export type { IntentServiceError };
