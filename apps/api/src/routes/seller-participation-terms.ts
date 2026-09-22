// Seller participation terms read endpoint (M2 #83).
//
// Background: the intent page reads the currently registered
// Seller participation terms so the customer can view the document
// AND the explicit acceptance checkbox before submitting. The
// route is the single server-side authority for that read; the
// browser does not invent legal copy — when the registration
// seam is null (production has not yet registered), the response
// carries `version: null, content: null, contentHash: null` and
// the page renders the legal-blocked copy.
//
// Authorization:
//
//   - Authentication required (session cookie). Public discovery
//     of the registered terms DOES NOT require a workspace id —
//     terms are a global registration seam, not a workspace-
//     scoped record. Any signed-in user with the cookie may
//     read the current registration to decide whether to
//     accept.
//   - The route is independent of `requireActingMembership`.
//     Reading terms is not a privileged command.
//
// Response contract (200):
//
//   {
//     "ok": true,
//     "registered": false,
//     "version": null,
//     "contentHash": null,
//     "content": null
//   }
//
// or, when registered:
//
//   {
//     "ok": true,
//     "registered": true,
//     "version": "1.0.0",
//     "contentHash": "<64-char hex sha-256>",
//     "content": "<immutable document text>"
//   }

import { Router, type Request, type Response } from "express";
import type { AuthenticationService } from "../services/authentication.service.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";
import { buildSafeError, generateRequestId, writeSafeError } from "../lib/errors.js";
import { getCurrentSellerParticipationTerms } from "../lib/seller-participation-terms.js";
import type { SellerParticipationTerms } from "../lib/seller-participation-terms.js";

export interface SellerTermsRouteDeps {
  readonly authenticationService: AuthenticationService;
}

export function createSellerTermsRouter(deps: SellerTermsRouteDeps): Router {
  const router = Router();

  router.get("/", (req: Request, res: Response) => {
    handleReadSellerTerms(req, res, deps).catch((err: unknown) => {
      if (res.headersSent) return;
      // Mirror the BG1 pattern: unexpected failures return
      // AUTH_FAILED via the safe envelope rather than echoing
      // the underlying message.
      const requestId = resolveRequestId(req);
      console.error(`[seller-terms] requestId=${requestId} unhandled:`, err);
      writeSafeError(
        res,
        buildSafeError(
          "AUTH_FAILED",
          "Could not read registered Seller terms.",
          undefined,
          requestId,
        ),
      );
    });
  });

  return router;
}

async function handleReadSellerTerms(
  req: Request,
  res: Response,
  deps: SellerTermsRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  // Authentication: the session cookie must resolve. Reading
  // registration is not a workspace-scoped command but it IS
  // an authenticated endpoint — anonymous discovery would
  // expose the legal document to the world before production
  // finalises it.
  const sessionId = readSessionCookie(req);
  const resolved = await deps.authenticationService.resolveSession(sessionId);
  if (!resolved) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to view the Seller participation terms.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const registered: SellerParticipationTerms | null = getCurrentSellerParticipationTerms();
  res.status(200).json({
    ok: true,
    registered: registered !== null,
    version: registered?.version ?? null,
    contentHash: registered?.contentHash ?? null,
    content: registered?.content ?? null,
  });
}

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

function resolveRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return generateRequestId();
}
