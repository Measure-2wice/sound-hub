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
    const error = buildSafeError(
      "UNSUPPORTED_MEDIA_TYPE",
      mediaType.message,
      undefined,
      requestId,
    );
    writeSafeError(res, error);
    drainAndEnd(req, res);
    return;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBodyWithByteLimit(req);
  } catch (err) {
    const isOversize = err instanceof PayloadTooLargeError;
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
    drainAndEnd(req, res);
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
  const segments = header.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { ok: false, message: "Content-Type is empty." };
  }
  const mediaType = segments[0]!.toLowerCase();
  if (mediaType !== "application/json") {
    return {
      ok: false,
      message: `Request Content-Type must be application/json (got ${mediaType}).`,
    };
  }
  // Optional parameters such as `charset=utf-8` are accepted. The
  // parser only validates well-formedness; charset decoding is the
  // runtime's responsibility.
  for (let i = 1; i < segments.length; i += 1) {
    const parameter = segments[i]!;
    if (!parameter.includes("=")) {
      return { ok: false, message: `Malformed Content-Type parameter: ${parameter}` };
    }
  }
  return { ok: true };
}

// Drain the request stream so the underlying socket is reusable for
// keep-alive, then end the response. Used after sending an error
// response that has already terminated the handler.
function drainAndEnd(req: Request, res: Response): void {
  if (res.writableEnded) return;
  req.on("data", () => {
    /* discard */
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    res.end();
  });
  // If the client has already closed the request side, end the
  // response immediately.
  if (req.readableEnded) {
    if (!res.writableEnded) res.end();
  }
}

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

// Read the request body as a UTF-8 string and enforce the 16 KiB
// limit by actual request bytes, not by JavaScript string length. The
// pause + reject pattern drains the rest of the stream in the
// background after overflow so the connection is not stuck mid-body.
async function readJsonBodyWithByteLimit(req: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let oversize = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      if (settled || oversize) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        oversize = true;
        // Pause so the rest of the body is not accumulated into
        // memory. The `end` handler below will finish draining and
        // resolve, but we resolve with an error to the caller.
        req.pause();
        fail(new PayloadTooLargeError("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
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
    });
    req.on("error", (err: Error) => {
      fail(err);
    });
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

