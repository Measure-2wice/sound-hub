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
//     Body: { email, return? }.
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
//     Response: { ok: true, user, returnTo } and a
//     `Set-Cookie: soundhub_session` header carrying the opaque
//     session id. The return-context cookie is cleared on every
//     response (success or recovery).
//
//   GET /api/auth/me
//     Response: { user | null } derived from the session cookie.
//     STRICTLY READ-ONLY: classifies current persisted state into
//     `setupState: "converged" | "recovery"` but does NOT invoke
//     convergence creation/attachment. Convergence is owned
//     exclusively by POST /api/auth/verify-token.
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
//     legacy ownerUserId match. Returns the server-resolved
//     `safeReturnTo` against the fresh post-switch user payload;
//     `Cancel` does NOT call this route — it is a safe in-page
//     exit to `/dashboard` under the still-committed current
//     Workspace.

import { createHash } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit, { MemoryStore, type RateLimitRequestHandler } from "express-rate-limit";
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
import type { AuthRepository } from "../auth-repository/auth-repository.js";
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
import {
  clearReturnContextCookie,
  readReturnContextCookie,
  resolveAllowedOrigin,
  setReturnContextCookie,
} from "../lib/return-context.js";
import {
  SafeReturnToFallback,
  resolvePostCommandReturnDestination,
} from "../lib/post-command-return-destination.js";
import { toPublicUser } from "../dto/public-mappers.js";

export interface AuthRouteDeps {
  readonly authenticationService: AuthenticationService;
  readonly workspaceAuthorizationService: WorkspaceAuthorizationService;
  readonly authRepository: AuthRepository;
  /**
   * M2 (#82): configured application origin used for canonical URL
   * parsing of return-context destinations. Defaults to
   * `process.env.FRONTEND_URL` so the same value the CORS layer uses
   * drives both protections.
   */
  readonly allowedReturnOrigin?: string;
}

export function createAuthRouter(deps: AuthRouteDeps): Router {
  const router = Router();
  const allowedReturnOrigin = resolveAllowedOrigin(
    deps.allowedReturnOrigin ?? process.env.FRONTEND_URL ?? "http://localhost:3000",
  );

  // Body parser for the auth router. Mounted as the first router
  // middleware so the per-route rate-limit keyGenerators (registered
  // immediately after this) observe `req.body` populated. The handler
  // short-circuits its own streaming reader when this middleware has
  // already parsed the body (same pattern as `matchmaker.ts`).
  //
  // 8 KiB cap matches the limit the inline streaming reader enforces;
  // overflow + invalid-JSON failures translate to the same
  // `INVALID_AUTH_REQUEST` safe envelope the handler would have
  // produced. Reusing a single body-parsing path means the rate-limit
  // `keyGenerator` and the schema validator observe the same parsed
  // object — there is no second stream read.
  router.use(parseAuthRequestBody);

  // Rate limiters (CodeQL `js/missing-rate-limiting` remediation).
  // Each instance owns a fresh `MemoryStore`; constructing the router
  // twice produces two independent buckets, so tests can isolate by
  // constructing a fresh router per `describe`.
  //
  // SoundHub's measured Railway topology does NOT preserve the
  // browser IP to Express:
  //   1. Railway web edge sees the browser IP
  //   2. Next.js creates a new server-side request
  //   3. Railway API edge sees the web service's SNAT address
  //   4. Express sees Railway CGNAT / forwarded service identity
  // Therefore req.ip cannot provide independent client identity and
  // per-email / per-IP keying on `/magic-link` would collapse
  // every legitimate browser onto the same bucket under the
  // current deploy. Per-client abuse protection for magic-link
  // therefore REQUIRES a trustworthy client identity at the
  // public boundary (deferred — out of scope for #82).
  //
  // `POST /magic-link` therefore mounts NO SoundHub-side
  // limiter. A route-wide constant-key circuit breaker would
  // create a single shared bucket that any unauthenticated
  // client could exhaust and deny authentication to every
  // legitimate user — exactly the failure mode Tenki flagged as
  // High. The original CodeQL finding is mitigated for the
  // surface it actually covers (`POST /verify-token`); targeted
  // per-client `/magic-link` abuse protection is deferred to
  // the future public-boundary security ticket.
  //
  // `POST /verify-token` retains a SHA-256 per-token limiter
  // (3 / 60 s) attached directly to the route middleware chain
  // so the original CodeQL `js/missing-rate-limiting` finding
  // remains mitigated. The per-token bucket is keyed by the
  // PRIVATE verificationToken the browser extracted from the
  // magic-link callback URL (canonicalized by `.min(1).max(512)`)
  // so it never retains a plaintext token and bounded-retry is
  // preserved. No global circuit breaker is mounted — distinct
  // tokens are independent.
  const verifyTokenPerTokenLimiter: RateLimitRequestHandler = rateLimit({
    windowMs: 60_000,
    limit: 3,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    store: new MemoryStore(),
    keyGenerator: tokenRateLimitKey,
    handler: (req, res) => rateLimitHandler(req, res),
  });

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
  //
  // Per-route rate-limit middleware runs immediately before each
  // handler. Attaching it directly to the `router.post(...)` chain
  // (rather than via `router.use(...)` above the limiter) keeps the
  // protection visible to CodeQL in the same declaration as the
  // route.
  //
  // `/magic-link` mounts NO SoundHub-side limiter. See the limiter
  // construction comment above for the reasoning.
  router.post("/magic-link", (req, res, next) => {
    handleMagicLink(req, res, { ...deps, allowedReturnOrigin }).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });
  router.post("/verify-token", verifyTokenPerTokenLimiter, (req, res, next) => {
    handleVerifyToken(req, res, { ...deps, allowedReturnOrigin }).catch((err) =>
      forwardUnhandledRejection(req, res, next, err),
    );
  });
  router.get("/me", (req, res, next) => {
    handleMe(req, res, deps).catch((err) => forwardUnhandledRejection(req, res, next, err));
  });
  router.post("/sign-out", (req, res, next) => {
    handleSignOut(req, res, deps).catch((err) => forwardUnhandledRejection(req, res, next, err));
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

async function handleMagicLink(
  req: Request,
  res: Response,
  deps: AuthRouteDeps & { readonly allowedReturnOrigin: string },
): Promise<void> {
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
    // M2 (#82): if the request includes a validated return destination,
    // set the short-lived HttpOnly cookie. Invalid destinations are
    // silently dropped (no error, no cookie) so the caller never
    // has to handle a partial state.
    if (parsed.return) {
      setReturnContextCookie(res, parsed.return, deps.allowedReturnOrigin);
    }
    res.status(200).json(validated);
  } catch (err) {
    writeAuthError(res, err, requestId, "magic-link");
  }
}

// ---------- POST /api/auth/verify-token ----------

async function handleVerifyToken(
  req: Request,
  res: Response,
  deps: AuthRouteDeps & { readonly allowedReturnOrigin: string },
): Promise<void> {
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

  // M2 (#82): re-validate the return-context cookie. The cookie is
  // re-read here (not trusted from the body) so a tampered cookie
  // value cannot grant return authority. Recovery overrides the
  // return context: when the convergence service returns a recovery
  // state, the route clears the cookie and the response carries
  // `returnTo: null`.
  const cookieHeader = req.headers.cookie;
  const validatedReturn = readReturnContextCookie(cookieHeader, deps.allowedReturnOrigin);

  try {
    const { session, publicUser } = await deps.authenticationService.verifySignIn({
      verificationToken: parsed.verificationToken,
    });
    // Append both cookies via `Set-Cookie` headers. Express's
    // `setHeader("Set-Cookie", ...)` REPLACES the previous value, so
    // the helpers cannot both be called back-to-back on the same
    // response without losing the first cookie. Append the second via
    // `appendHeader` so both reach the browser.
    setSessionCookie(res, session.sessionId, session.expiresAt);
    // Always clear the return-context cookie on success (recovery or
    // converged); the response carries the validated destination.
    clearReturnContextCookie(res);
    const returnTo = publicUser.setupState === "recovery" ? null : validatedReturn;
    const body = bg1VerifyTokenResponseV1Schema.parse({
      ok: true,
      user: publicUser,
      returnTo,
    });
    res.status(200).json(body);
  } catch (err) {
    // Failure: also clear the return-context cookie so a stale value
    // never carries across sessions. The helper uses
    // `appendHeader` so a prior session cookie is not overwritten.
    clearReturnContextCookie(res);
    writeAuthError(res, err, requestId, "verify-token");
  }
}

// ---------- GET /api/auth/me ----------

async function handleMe(req: Request, res: Response, deps: AuthRouteDeps): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);
  const sessionId = readSessionCookie(req);
  // M2 (#82): surface `setupState` on the public user so the
  // browser renders recovery based solely on this field, never on
  // inference from the workspaces array.
  const resolved = await deps.authenticationService.resolveSessionWithSetupState(sessionId);
  const body = bg1SessionInfoV1Schema.parse({
    user: resolved ? toPublicUser(resolved.user, resolved.setupState) : null,
  });
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
  const resolved = await deps.authenticationService.resolveSessionWithSetupState(sessionId);
  if (!resolved) {
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
  const view = resolved;

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
      userAccountId: view.user.userAccountId,
      workspaceId: parsed.actingWorkspaceId,
    });
    // Resolve `safeReturnTo` against the FRESH post-commit user
    // payload (via the bounded #83 post-command destination
    // resolver). The browser consumes ONLY this value; the raw
    // `?return=` query parameter is never honored client-side
    // after a successful commit, so a cross-Workspace destination
    // cannot reach the browser before the Workspace the customer
    // just committed to is the actor. A `null` request value, or
    // a value that fails the bounded revalidation, leaves
    // `safeReturnTo` at `null` and the browser falls back to
    // `/dashboard`.
    const publicUser = toPublicUser(view.user, view.setupState);
    let safeReturnTo: string | null = null;
    try {
      const resolvedDestination = resolvePostCommandReturnDestination({
        returnTo: parsed.returnTo ?? null,
        freshUser: publicUser,
        actingWorkspaceId: membership.workspace.workspaceId,
        allowedOrigin:
          deps.allowedReturnOrigin ?? process.env.FRONTEND_URL ?? "http://localhost:3000",
      });
      safeReturnTo = resolvedDestination?.path ?? null;
    } catch (err) {
      if (err instanceof SafeReturnToFallback) {
        safeReturnTo = null;
      } else {
        throw err;
      }
    }
    const body = bg1ActingWorkspaceResponseV1Schema.parse({
      ok: true,
      actingWorkspace: membership.workspace,
      membership: {
        role: membership.role,
        joinedAt: membership.joinedAt.toISOString(),
      },
      safeReturnTo,
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
  // When the body has already been parsed by the router-level
  // `parseAuthRequestBody` middleware (the production path) reuse it
  // instead of re-reading the stream. Reading again would hang
  // because the stream has already been consumed. The pre-parsed
  // shape is the same `unknown` the streaming path returns, so the
  // downstream schema validator sees an identical object.
  //
  // `null` is a legitimate JSON payload (a literal `null` body) that
  // MUST reach `schema.parse(null)` so the Zod validator returns its
  // normal `INVALID_AUTH_REQUEST` envelope rather than the handler
  // silently treating it as "stop signal". The matchmaker short-
  // circuit intentionally excludes `null`; the auth short-circuit
  // intentionally includes it.
  const existing: unknown = req.body;
  if (existing !== undefined) return existing;

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

// ---------- Body parser middleware ----------
//
// Reads the request body once and assigns the parsed value to
// `req.body`, then continues the middleware chain. Mounted as the
// first router-level middleware on `/api/auth` so the rate-limit
// `keyGenerator` (attached immediately after) observes the same
// parsed object the schema validator will see.
//
// Failures write the existing `INVALID_AUTH_REQUEST` safe envelope
// and end the response. Reusing the existing envelope keeps the
// public error contract identical to the inline streaming reader's
// behaviour.

const AUTH_REQUEST_BODY_LIMIT = 8 * 1024;

function parseAuthRequestBody(req: Request, res: Response, next: NextFunction): void {
  // Mirror the streaming reader's short-circuit: if some other
  // middleware (a test harness's `express.json()`, for example) has
  // already populated `req.body`, skip parsing. This keeps the
  // router's body contract compatible with upstream parsers without
  // requiring every test to know about the internal middleware.
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
    if (total > AUTH_REQUEST_BODY_LIMIT) {
      req.pause();
      res.setHeader("x-request-id", requestId);
      writeSafeError(
        res,
        buildSafeError(
          "INVALID_AUTH_REQUEST",
          "Request body exceeds the limit.",
          undefined,
          requestId,
        ),
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
        buildSafeError(
          "INVALID_AUTH_REQUEST",
          "Request body is not valid JSON.",
          undefined,
          requestId,
        ),
      );
    }
  });
  req.on("error", (err: Error) => {
    next(err);
  });
}

// ---------- Rate-limit helpers ----------

const FALLBACK_TOKEN_KEY = "__invalid_token__";

function tokenRateLimitKey(req: Request): string {
  const body: unknown = req.body;
  if (typeof body !== "object" || body === null) return FALLBACK_TOKEN_KEY;
  const candidate: unknown = (body as Record<string, unknown>).verificationToken;
  const parsed = bg1VerifyTokenRequestV1Schema.shape.verificationToken.safeParse(candidate);
  if (!parsed.success) return FALLBACK_TOKEN_KEY;
  return createHash("sha256").update(parsed.data).digest("hex");
}

function rateLimitHandler(req: Request, res: Response): void {
  // Express-rate-limit has already set the standard rate-limit
  // headers (`RateLimit`, `RateLimit-Policy`) and `Retry-After` on
  // the response before invoking `handler`; this function only needs
  // to write the safe-error envelope so the public 429 contract
  // matches the rest of the auth surface. Only `POST /verify-token`
  // mounts a limiter, so the route tag is fixed.
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);
  console.error(`[auth:verify-token] requestId=${requestId} code=AUTH_RATE_LIMITED`);
  writeSafeError(
    res,
    buildSafeError("AUTH_RATE_LIMITED", "Too many requests.", undefined, requestId),
  );
}
