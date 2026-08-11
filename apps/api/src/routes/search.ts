import contentType from "content-type";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Router, type Request, type Response } from "express";
import {
  talentSearchRequestV1Schema,
  talentSearchResponseV1Schema,
  type TalentSearchResponseV1,
} from "@soundhub/types";
import { ZodError } from "zod";
import type { TalentSearchService } from "../services/talent-search.service.js";
import { TalentSearchInvalidCriteriaError } from "../services/talent-search.service.js";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
  type SafeErrorResponse,
} from "../lib/errors.js";

export interface SearchRouteDeps {
  readonly service: TalentSearchService;
}

const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export function createSearchRouter(deps: SearchRouteDeps): Router {
  const router = Router();
  router.post("/", (req, res) => {
    void handleSearch(req, res, deps);
  });
  return router;
}

async function handleSearch(req: Request, res: Response, deps: SearchRouteDeps): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const mediaType = parseApplicationJsonMediaType(req.headers["content-type"]);
  if (!mediaType.ok) {
    const error = buildSafeError("UNSUPPORTED_MEDIA_TYPE", mediaType.message, undefined, requestId);
    writeSafeError(res, error);
    drainAndEnd(req, res);
    return;
  }

  // Up-front Content-Length check: if the client declares a body
  // larger than the limit, reject immediately. This avoids reading
  // any body bytes, so the response is flushed quickly and the
  // socket is ready for the next request without any keep-alive
  // hang. Transfer-Encoding: chunked requests do not provide a
  // Content-Length; for those, the streaming reader enforces the
  // limit on bytes observed.
  const declaredLength = parseContentLengthHeader(req.headers["content-length"]);
  if (declaredLength !== null && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = buildSafeError(
      "INVALID_JSON",
      `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit.`,
      undefined,
      requestId,
    );
    writeSafeError(res, error);
    return;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBodyWithByteLimit(req);
  } catch (err) {
    const isOversize = err instanceof PayloadTooLargeError;
    if (isOversize) {
      // Set Connection: close BEFORE writing the response so
      // Node's HTTP server tears down the socket after the
      // safe envelope is flushed. The body reader paused `req`
      // to stop accumulating bytes, but the underlying socket
      // may still hold an in-flight chunked body; tearing down
      // the connection after the response ensures the client
      // is notified not to send further requests on this
      // socket. We intentionally do NOT call req.destroy()
      // before the response is flushed: doing so would race
      // with the TCP write and could close the socket before
      // the client receives the safe envelope.
      res.setHeader("Connection", "close");
    }
    const error = buildSafeError(
      "INVALID_JSON",
      isOversize
        ? `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit.`
        : "Request body is not valid JSON.",
      undefined,
      requestId,
    );
    noteError(error, err);
    writeSafeError(res, error);
    return;
  }

  let parsedRequest;
  try {
    parsedRequest = talentSearchRequestV1Schema.parse(rawBody);
  } catch (err) {
    if (err instanceof ZodError) {
      const fields = buildFieldErrors(err.issues);
      const error = buildSafeError(
        "INVALID_SEARCH_CRITERIA",
        "Request body failed schema validation.",
        fields,
        requestId,
      );
      writeSafeError(res, error);
      return;
    }
    throw err;
  }

  let response: TalentSearchResponseV1;
  try {
    response = await deps.service.search(parsedRequest);
  } catch (err) {
    if (err instanceof TalentSearchInvalidCriteriaError) {
      const error = buildSafeError("INVALID_SEARCH_CRITERIA", err.message, undefined, requestId);
      noteError(error, err);
      writeSafeError(res, error);
      return;
    }
    const safe = isUnavailable(err)
      ? buildSafeError(
          "SEARCH_UNAVAILABLE",
          "Talent search is temporarily unavailable. Please try again.",
          undefined,
          requestId,
        )
      : buildSafeError(
          "SEARCH_FAILED",
          "An unexpected error occurred while processing the search.",
          undefined,
          requestId,
        );
    noteError(safe, err);
    writeSafeError(res, safe);
    return;
  }

  const validated = talentSearchResponseV1Schema.safeParse(response);
  if (!validated.success) {
    const safe = buildSafeError(
      "SEARCH_FAILED",
      "An unexpected error occurred while processing the search.",
      undefined,
      requestId,
    );
    noteError(safe, validated.error);
    writeSafeError(res, safe);
    return;
  }

  res.status(200).json(validated.data);
}

function resolveRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return generateRequestId();
}

// Parse the Content-Type header for `application/json` (with optional
// parameters such as `charset=utf-8`). Returns an ok/error result so the
// caller can write the safe envelope without leaking parser internals.
//
// Per the v1 contract, only `application/json` is supported. The
// `+json` suffix (e.g. `application/vnd.api+json`) is NOT broadened
// here because authoritative docs do not list it as supported.
type MediaTypeResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

function parseApplicationJsonMediaType(header: string | string[] | undefined): MediaTypeResult {
  if (Array.isArray(header)) {
    return { ok: false, message: "Multiple Content-Type headers are not supported." };
  }
  if (header === undefined || header.trim() === "") {
    return { ok: false, message: "Request is missing the Content-Type header." };
  }
  let parsed: { type: string; parameters: Record<string, string> };
  try {
    parsed = contentType.parse(header);
  } catch (err) {
    return {
      ok: false,
      message: `Malformed Content-Type header: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed.type.toLowerCase() !== "application/json") {
    return {
      ok: false,
      message: `Request Content-Type must be application/json (got ${parsed.type}).`,
    };
  }
  return { ok: true };
}

// Drain the request stream so the underlying socket is reusable for
// keep-alive. Used after sending an error response that has already
// terminated the handler. The previous implementation short-circuited
// when the response was already ended, which left unread request bytes
// on a keep-alive connection. This implementation unconditionally
// drains the request and is a no-op once the response is already
// finished.
function drainAndEnd(req: IncomingMessage, res: ServerResponse): void {
  // Replace the 'data' handler with a no-op so any incoming bytes are
  // discarded without being processed.
  req.on("data", () => {
    /* discard */
  });
  req.on("end", () => {
    if (!res.writableEnded) {
      res.end();
    }
  });
  // If the request has already finished, end the response now.
  if (req.readableEnded && !res.writableEnded) {
    res.end();
  }
}

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

function parseContentLengthHeader(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

// Read the request body as a UTF-8 string and enforce the 16 KiB
// limit by actual request bytes, not by JavaScript string length.
//
// On overflow the data/end/error listeners are removed, the
// request stream is paused so no further body bytes are
// accumulated, and the Promise is rejected atomically through
// `fail()` (which sets the settled flag and calls reject in one
// step). The route handler then writes the safe envelope and
// destroys the request so the socket is closed deterministically.
// Because the body reader pauses the request, the underlying
// socket can still hold an in-flight chunked body; destroying
// the request ensures that unread bytes cannot be left on a
// keep-alive connection. The response is written synchronously
// before this function returns, so the client receives the safe
// envelope immediately. A subsequent request opens a fresh
// connection; the keep-alive socket from the oversized request
// is intentionally not reused.
async function readJsonBodyWithByteLimit(req: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        // Oversized: stop processing. Remove the resolution
        // listeners, pause the request so no further body bytes are
        // accumulated, then atomically reject through `fail()`. The
        // settlement (settled flag + reject) MUST be a single
        // operation through `fail()` so the Promise cannot be left
        // pending. The route handler destroys the request after
        // writing the safe envelope so the socket is closed
        // deterministically and cannot be reused while paused.
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
        req.pause();
        fail(new PayloadTooLargeError("Request body too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const onError = (err: Error) => {
      fail(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function isUnavailable(err: unknown): boolean {
  if (!err) return false;
  if (typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  // Prisma-specific connection errors.
  if (
    code === "P1001" ||
    code === "P1002" ||
    code === "P1008" ||
    code === "P1017" ||
    code === "P1009" ||
    code === "P1010"
  ) {
    return true;
  }
  // PostgreSQL SQLSTATE connection errors.
  if (
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "08000" ||
    code === "08003" ||
    code === "08006" ||
    code === "08001" ||
    code === "08004" ||
    code === "08007"
  ) {
    return true;
  }
  // Node system errors that mean "can't reach the database".
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH"
  ) {
    return true;
  }
  return false;
}

function noteError(safe: SafeErrorResponse, err: unknown): void {
  // Diagnostic only; never serialize internal details to the response.
  console.error(
    `[talent-search] requestId=${safe.body.error.requestId} code=${safe.body.error.code}:`,
    err,
  );
}
