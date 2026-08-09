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

async function handleSearch(
  req: Request,
  res: Response,
  deps: SearchRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const error = buildSafeError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Request Content-Type must be application/json.",
      undefined,
      requestId,
    );
    writeSafeError(res, error);
    return;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    const code =
      err instanceof PayloadTooLargeError
        ? "INVALID_JSON"
        : "INVALID_JSON";
    const message =
      err instanceof PayloadTooLargeError
        ? `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit.`
        : "Request body is not valid JSON.";
    const error = buildSafeError(code, message, undefined, requestId);
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
      const error = buildSafeError(
        "INVALID_SEARCH_CRITERIA",
        err.message,
        undefined,
        requestId,
      );
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

class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

async function readJsonBody(req: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (settled) return;
      if (data.length + chunk.length > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        req.destroy();
        reject(new PayloadTooLargeError("Request body too large"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (data.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
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
