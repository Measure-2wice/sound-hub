// Express auth routes for BG1.
//
// Background: every endpoint funnels through the same application
// boundary (`AuthenticationService` + `WorkspaceAuthorizationService`)
// and writes the shared safe error envelope on failure. Provider
// subjects and raw session ids never cross a public DTO; the session
// cookie is the only authoritative identity signal the client can
// read.
//
// Routes:
//   POST /api/auth/magic-link
//     Body: { email }.
//     Response: { ok: true, requestId, devVerificationUrl? }. Neutral
//     on well-formed requests regardless of whether the email is
//     registered, so the surface cannot be used to enumerate
//     accounts. The `requestId` is the PUBLIC correlation id; the
//     private verification credential is never exposed.
//
//   POST /api/auth/verify-token
//     Body: { verificationToken }. The field is the PRIVATE one-time
//     credential the browser extracted from the magic-link callback
//     URL. The PUBLIC correlation id from `/magic-link` is NOT
//     acceptable (per ticket #59 P2-001).
//     Response: { ok: true, user } and a `Set-Cookie: soundhub_session`
//     header carrying the opaque session id.
//
//   GET /api/auth/me
//     Response: { user | null } derived from the session cookie. No
//     write side effects.
//
//   POST /api/auth/sign-out
//     Revokes the current session. Idempotent. Clears the session
//     cookie. Returns { ok: true }.
//
//   POST /api/auth/acting-workspace
//     Body: { actingWorkspaceId }. Requires an authenticated session
//     and a current WorkspaceMembership. Proves the GS 4 / GS 5 /
//     GS 6 contracts: the route revalidates current membership on
//     every request and rejects a user without it, regardless of any
//     legacy ownerUserId match.

import { Router, type NextFunction, type Request, type Response } from "express";
import {
  bg1MagicLinkRequestV1Schema,
  bg1MagicLinkResponseV1Schema,
  bg1VerifyTokenRequestV1Schema,
  bg1VerifyTokenResponseV1Schema,
  bg1SessionInfoV1Schema,
  bg1SignOutResponseV1Schema,
  bg1ActingWorkspaceRequestV1Schema,
  bg1ActingWorkspaceResponseV1Schema,
  type ApiErrorCodeV1,
} from "@soundhub/types";
import { ZodError } from "zod";
import type { AuthenticationService } from "../services/authentication.service.js";
import {
  AuthorizationError,
  type WorkspaceAuthorizationService,
} from "../services/workspace-authorization.service.js";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
  type SafeErrorResponse,
} from "../lib/errors.js";
import { SESSION_COOKIE, setSessionCookie, clearSessionCookie } from "../lib/session-cookie.js";
import type { AuthRepository } from "../auth-repository/auth-repository.js";
import { toPublicUser } from "../dto/public-mappers.js";

export interface AuthRouteDeps {
  readonly authenticationService: AuthenticationService;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  readonly authRepository: AuthRepository;
}

export function createAuthRouter(deps: AuthRouteDeps): Router {
  const router = Router();

  // BG1 contract: route handlers MUST NOT leave promise rejections
  // unhandled. The handlers only translate recognised errors into
  // safe-envelope responses; any unexpected throw escapes the
  // service/route boundary. The wrapper forwards those rejections to
  // Express's error middleware so a synchronous-looking failure
  // cannot crash the process under Node's default
  // unhandled-rejection policy.
  //
  // If the handler already wrote (or partially wrote) the response,
  // the wrapper logs and returns instead of calling `next(err)` —
  // the error middleware would attempt to set headers on a sent
  // response and produce ERR_HTTP_HEADERS_SENT.
  router.post("/magic-link", (req, res, next) => {
    handleMagicLink(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });
  router.post("/verify-token", (req, res, next) => {
    handleVerifyToken(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });
  router.get("/me", (req, res, next) => {
    handleMe(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });
  router.post("/sign-out", (req, res, next) => {
    handleSignOut(req, res, deps).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });
  router.post("/acting-workspace", (req, res, next) => {
    handleActingWorkspace(req, res, deps).catch((err) =>
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
    // The handler already wrote (or partially wrote) the response.
    // We cannot recover by handing the error to the error
    // middleware — it would attempt to set headers / write JSON on a
    // sent response. Log so the failure is auditable and let the
    // request close so the process stays responsive.
    console.error(`[auth] requestId=${resolveRequestId(req)} handler-rejection-after-write:`, err);
    return;
  }
  next(err);
}

// ---------- POST /api/auth/magic-link ----------

async function handleMagicLink(req: Request, res: Response, deps: AuthRouteDeps): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const rawBody = await readJsonBodyOrRespond(req, res, requestId);
  if (rawBody === undefined) return;

  let parsed;
  try {
    parsed = bg1MagicLinkRequestV1Schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "INVALID_AUTH_REQUEST",
          "Magic link request failed schema validation.",
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return;
    }
    throw err;
  }

  try {
    const { envelope } = await deps.authenticationService.requestSignIn({
      email: parsed.email,
    });
    const validated = bg1MagicLinkResponseV1Schema.parse(envelope);
    res.status(200).json(validated);
  } catch (err) {
    writeAuthError(res, err, requestId, "magic-link");
  }
}

// ---------- POST /api/auth/verify-token ----------

async function handleVerifyToken(req: Request, res: Response, deps: AuthRouteDeps): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const rawBody = await readJsonBodyOrRespond(req, res, requestId);
  if (rawBody === undefined) return;

  let parsed;
  try {
    parsed = bg1VerifyTokenRequestV1Schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "INVALID_AUTH_REQUEST",
          "Verify-token request failed schema validation.",
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return;
    }
    throw err;
  }

  try {
    const { session, publicUser } = await deps.authenticationService.verifySignIn({
      verificationToken: parsed.verificationToken,
    });
    setSessionCookie(res, session.sessionId, session.expiresAt);
    const body = bg1VerifyTokenResponseV1Schema.parse({ ok: true, user: publicUser });
    res.status(200).json(body);
  } catch (err) {
    writeAuthError(res, err, requestId, "verify-token");
  }
}

// ---------- GET /api/auth/me ----------

async function handleMe(req: Request, res: Response, deps: AuthRouteDeps): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);
  const sessionId = readSessionCookie(req);
  const view = await deps.authenticationService.resolveSession(sessionId);
  const body = bg1SessionInfoV1Schema.parse({ user: view ? toPublicUser(view) : null });
  res.status(200).json(body);
}

// ---------- POST /api/auth/sign-out ----------

async function handleSignOut(req: Request, res: Response, deps: AuthRouteDeps): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);
  const sessionId = readSessionCookie(req);
  await deps.authenticationService.signOut(sessionId);
  clearSessionCookie(res);
  const body = bg1SignOutResponseV1Schema.parse({ ok: true });
  res.status(200).json(body);
}

// ---------- POST /api/auth/acting-workspace ----------

async function handleActingWorkspace(
  req: Request,
  res: Response,
  deps: AuthRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const sessionId = readSessionCookie(req);
  const view = await deps.authenticationService.resolveSession(sessionId);
  if (!view) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to act as a Workspace.",
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
    parsed = bg1ActingWorkspaceRequestV1Schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "INVALID_AUTH_REQUEST",
          "Acting-Workspace request failed schema validation.",
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return;
    }
    throw err;
  }

  try {
    const membership = await deps.workspaceAuthorizationService.requireActingMembership({
      userAccountId: view.userAccountId,
      workspaceId: parsed.actingWorkspaceId,
    });
    const body = bg1ActingWorkspaceResponseV1Schema.parse({
      ok: true,
      actingWorkspace: membership.workspace,
      membership: {
        role: membership.role,
        joinedAt: membership.joinedAt.toISOString(),
      },
    });
    res.status(200).json(body);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      const safe = buildSafeError(err.code, err.message, undefined, requestId);
      writeSafeError(res, safe);
      return;
    }
    throw err;
  }
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
      // BG1 contract: malformed percent-encoding on the cookie value
      // (e.g. `soundhub_session=%zz`) is treated as "no session", NOT
      // a thrown URIError. Without this guard, an attacker-controlled
      // Cookie header would crash the auth routes via unhandled
      // promise rejection — the routes fire handlers via
      // `void handleX(...)` and a thrown URIError would never reach
      // the Express error middleware.
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

async function readJsonBody(req: Request, res: Response, requestId: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const limit = 8 * 1024;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          req.pause();
          writeSafeError(
            res,
            buildSafeError(
              "INVALID_AUTH_REQUEST",
              "Request body exceeds the limit.",
              undefined,
              requestId,
            ),
          );
          reject(new Error("payload-too-large"));
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
        "INVALID_AUTH_REQUEST",
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
      // The body reader already wrote a safe envelope for the
      // recognised failure modes (payload-too-large, invalid-json).
      // Returning `undefined` is the unique "stop signal" the
      // handlers look for — `null` is a legitimate JSON value
      // (e.g. a literal `null` body) that must reach
      // `schema.parse(null)` so the Zod validator returns its
      // normal `INVALID_AUTH_REQUEST` envelope instead of being
      // silenced by the body-reader guard. A previous version of
      // this function returned `null`, which collided with that
      // legitimate payload and produced a second
      // `writeSafeError` call on an already-ended response
      // (`ERR_HTTP_HEADERS_SENT`) that escaped the handler as an
      // unhandled promise rejection.
      return undefined;
    }
    throw err;
  }
}

function writeAuthError(res: Response, err: unknown, requestId: string, route: string): void {
  if (err instanceof Error && err.name === "AuthenticationError") {
    const authErr = err as Error & { code?: ApiErrorCodeV1 };
    const code = authErr.code ?? "AUTH_FAILED";
    const safe: SafeErrorResponse = buildSafeError(code, err.message, undefined, requestId);
    console.error(`[auth:${route}] requestId=${requestId} code=${code}:`, err);
    writeSafeError(res, safe);
    return;
  }
  console.error(`[auth:${route}] requestId=${requestId} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "AUTH_FAILED",
      "An unexpected error occurred while processing the request.",
      undefined,
      requestId,
    ),
  );
}
