// Express routes for the seller-audio slice (Buildathon Golden Slice 2).
//
// Background: ticket #61 wires a bounded MP3 upload/list/play/remove
// surface through the same Express application boundary as the M1
// search and BG1 auth routes. Every consequential command:
//
//   - resolves the authenticated user via the HttpOnly session
//     cookie (the same cookie the BG1 /api/auth/me route reads);
//   - carries the explicit acting Workspace in the body so the
//     server revalidates current membership + Seller capability +
//     offering ownership against it (a user belonging to two
//     Workspaces cannot modify a stale offering under the wrong
//     one);
//   - delegates to the AudioSampleService, which owns the
//     authorization, content-type, size, and 3-sample-cap rules;
//   - emits the shared safe envelope on rejection so a future
//     contract-drift detector can compare the response codes
//     against the schema enum.
//
// Endpoints:
//
//   POST   /api/services/:offeringId/audio-samples
//     multipart/form-data with `actingWorkspaceId`, `label`, `file`
//     (audio/mpeg, ≤ 25 MB). Requires Seller capability + offering
//     ownership + actingWorkspaceId match. Returns
//     { ok: true, sample } on success.
//
//   GET    /api/services/:offeringId/audio-samples
//     Buyer-facing read of the bounded samples for an Active
//     offering. No authentication required: the samples are public
//     discovery evidence. Returns the same allow-listed DTO the
//     seller management UI consumes.
//
//   DELETE /api/services/:offeringId/audio-samples/:sampleId
//     Requires authentication + Seller capability + offering
//     ownership + actingWorkspaceId match. Removes a sample.
//     Idempotent: a missing sample returns the safe envelope code
//     AUDIO_SAMPLE_NOT_FOUND.
//
//   GET    /api/services/:offeringId/audio-samples/:sampleId/play
//     Read-only stream of an Active offering's sample bytes for the
//     deterministic adapter. The Supabase path returns a signed
//     URL in the public DTO instead, so this route never streams
//     bytes for the deployed backend.

import { Router, type NextFunction, type Request, type Response } from "express";
import {
  bg2AudioSampleListResponseV1Schema,
  bg2AudioSampleRemoveResponseV1Schema,
  bg2AudioSampleUploadResponseV1Schema,
  BG2_AUDIO_SAMPLE_CONTENT_TYPE,
  BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE,
  BG2_AUDIO_SAMPLE_MAX_LABEL_LENGTH,
} from "@soundhub/types";
import { z, ZodError } from "zod";
import type { AudioSampleService } from "../services/audio-sample.service.js";
import { AudioSampleError } from "../services/audio-sample.service.js";
import {
  buildFieldErrors,
  buildSafeError,
  generateRequestId,
  writeSafeError,
  type SafeErrorResponse,
} from "../lib/errors.js";
import { SESSION_COOKIE } from "../lib/session-cookie.js";
import type { AuthenticationService } from "../services/authentication.service.js";

export interface AudioSamplesRouteDeps {
  readonly service: AudioSampleService;
  readonly authenticationService: AuthenticationService;
}

const MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024; // 30 MB; 25 MB sample + multipart overhead
const MAX_LABEL_CHARS = BG2_AUDIO_SAMPLE_MAX_LABEL_LENGTH; // 120 characters

export function createAudioSamplesRouter(deps: AudioSamplesRouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.post("/services/:offeringId/audio-samples", (req, res, next) => {
    handleUpload(req, res, deps).catch((err) => forwardUnhandledRejection(req, res, next, err));
  });
  router.get("/services/:offeringId/audio-samples", (req, res, next) => {
    handleList(req, res, deps).catch((err) => forwardUnhandledRejection(req, res, next, err));
  });
  router.delete("/services/:offeringId/audio-samples/:sampleId", (req, res, next) => {
    handleRemove(req, res, deps).catch((err) => forwardUnhandledRejection(req, res, next, err));
  });
  router.get("/services/:offeringId/audio-samples/:sampleId/play", (req, res, next) => {
    handlePlay(req, res, deps).catch((err) => forwardUnhandledRejection(req, res, next, err));
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
      `[audio-samples] requestId=${resolveRequestId(req)} handler-rejection-after-write:`,
      err,
    );
    return;
  }
  next(err);
}

async function handleUpload(
  req: Request,
  res: Response,
  deps: AudioSamplesRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const view = await resolveAuth(req, deps, requestId, res);
  if (!view) return;

  const offeringId = readOfferingId(req);
  if (!offeringId) {
    writeSafeError(
      res,
      buildSafeError(
        "INVALID_AUTH_REQUEST",
        "ServiceOffering id is required.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const mediaType = parseMultipartMediaType(req.headers["content-type"]);
  if (!mediaType.ok) {
    writeSafeError(
      res,
      buildSafeError("UNSUPPORTED_MEDIA_TYPE", mediaType.message, undefined, requestId),
    );
    return;
  }

  const declaredLength = parseContentLengthHeader(req.headers["content-length"]);
  if (declaredLength !== null && declaredLength > MAX_REQUEST_BODY_BYTES) {
    writeSafeError(
      res,
      buildSafeError(
        "AUDIO_PAYLOAD_TOO_LARGE",
        `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit.`,
        undefined,
        requestId,
      ),
    );
    return;
  }

  let parsed: ParsedMultipart | null = null;
  try {
    parsed = await readMultipartWithLimits(req, {
      maxBodyBytes: MAX_REQUEST_BODY_BYTES,
      maxBytes: BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE,
      maxLabelChars: MAX_LABEL_CHARS,
    });
  } catch (err) {
    if (err instanceof MultipartError) {
      const code = mapMultipartErrorCode(err);
      writeSafeError(res, buildSafeError(code, err.message, undefined, requestId));
      return;
    }
    throw err;
  }
  if (!parsed) {
    writeSafeError(
      res,
      buildSafeError("AUDIO_PAYLOAD_MISSING", "Multipart payload is empty.", undefined, requestId),
    );
    return;
  }

  try {
    const result = await deps.service.uploadSample({
      userAccountId: view.userAccountId,
      offeringId,
      actingWorkspaceId: parsed.actingWorkspaceId,
      label: parsed.label,
      contentType: parsed.contentType,
      byteSize: parsed.byteSize,
      bytes: parsed.bytes,
    });
    const body = bg2AudioSampleUploadResponseV1Schema.parse({ ok: true, sample: result.sample });
    res.status(200).json(body);
  } catch (err) {
    writeAudioError(res, err, requestId);
  }
}

async function handleList(req: Request, res: Response, deps: AudioSamplesRouteDeps): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const offeringId = readOfferingId(req);
  if (!offeringId) {
    writeSafeError(
      res,
      buildSafeError(
        "INVALID_AUTH_REQUEST",
        "ServiceOffering id is required.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  try {
    const result = await deps.service.listSamplesForBuyer(offeringId);
    const body = bg2AudioSampleListResponseV1Schema.parse({
      offeringId: result.offeringId,
      samples: result.samples,
    });
    res.status(200).json(body);
  } catch (err) {
    writeAudioError(res, err, requestId);
  }
}

async function handleRemove(
  req: Request,
  res: Response,
  deps: AudioSamplesRouteDeps,
): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const view = await resolveAuth(req, deps, requestId, res);
  if (!view) return;

  const offeringId = readOfferingId(req);
  const sampleId = readSampleId(req);
  if (!offeringId || !sampleId) {
    writeSafeError(
      res,
      buildSafeError(
        "INVALID_AUTH_REQUEST",
        "ServiceOffering id and sample id are required.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  const rawBody = await readJsonBodyOrRespond(req, res, requestId);
  if (rawBody === undefined) return;

  let actingWorkspaceId: string;
  try {
    const parsed = removeRequestSchema.parse(rawBody);
    actingWorkspaceId = parsed.actingWorkspaceId;
  } catch (err) {
    if (err instanceof ZodError) {
      writeSafeError(
        res,
        buildSafeError(
          "INVALID_AUTH_REQUEST",
          "Remove request failed schema validation.",
          buildFieldErrors(err.issues),
          requestId,
        ),
      );
      return;
    }
    throw err;
  }

  try {
    const result = await deps.service.removeSample({
      userAccountId: view.userAccountId,
      offeringId,
      sampleId,
      actingWorkspaceId,
    });
    const body = bg2AudioSampleRemoveResponseV1Schema.parse({
      ok: true,
      sampleId: result.sampleId,
      offeringId: result.offeringId,
      removedAt: result.removedAt.toISOString(),
    });
    res.status(200).json(body);
  } catch (err) {
    writeAudioError(res, err, requestId);
  }
}

async function handlePlay(req: Request, res: Response, deps: AudioSamplesRouteDeps): Promise<void> {
  const requestId = resolveRequestId(req);
  res.setHeader("x-request-id", requestId);

  const offeringId = readOfferingId(req);
  const sampleId = readSampleId(req);
  if (!offeringId || !sampleId) {
    writeSafeError(
      res,
      buildSafeError(
        "INVALID_AUTH_REQUEST",
        "ServiceOffering id and sample id are required.",
        undefined,
        requestId,
      ),
    );
    return;
  }

  try {
    const playback = await deps.service.getBytesForPlayback({ offeringId, sampleId });
    if (!playback) {
      writeSafeError(
        res,
        buildSafeError(
          "AUDIO_SAMPLE_NOT_FOUND",
          "Sample is not available for playback.",
          undefined,
          requestId,
        ),
      );
      return;
    }
    res.setHeader("Content-Type", BG2_AUDIO_SAMPLE_CONTENT_TYPE);
    res.setHeader("Content-Length", String(playback.bytes.byteLength));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.status(200).end(Buffer.from(playback.bytes));
  } catch (err) {
    writeAudioError(res, err, requestId);
  }
}

async function resolveAuth(
  req: Request,
  deps: AudioSamplesRouteDeps,
  requestId: string,
  res: Response,
): Promise<{ readonly userAccountId: string } | null> {
  const sessionId = readSessionCookie(req);
  const view = await deps.authenticationService.resolveSession(sessionId);
  if (!view) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Sign in is required to manage discovery samples.",
        undefined,
        requestId,
      ),
    );
    return null;
  }
  return { userAccountId: view.userAccountId };
}

function writeAudioError(res: Response, err: unknown, requestId: string): void {
  if (err instanceof AudioSampleError) {
    const safe: SafeErrorResponse = buildSafeError(err.code, err.message, undefined, requestId);
    console.error(`[audio-samples] requestId=${requestId} code=${err.code}:`, err);
    writeSafeError(res, safe);
    return;
  }
  if (err instanceof ZodError) {
    // Response-schema validation failures are server-side response
    // generation bugs (the route returned a body that does not match
    // the shared Zod schema). Surface as a 500; never as 400 (the
    // public DTO contract failure is not a client request defect).
    console.error(`[audio-samples] requestId=${requestId} response-schema-failure:`, err);
    writeSafeError(
      res,
      buildSafeError(
        "SEARCH_FAILED",
        "An unexpected error occurred while building the response.",
        undefined,
        requestId,
      ),
    );
    return;
  }
  console.error(`[audio-samples] requestId=${requestId} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "AUDIO_STORAGE_FAILED",
      "An unexpected error occurred while processing the request.",
      undefined,
      requestId,
    ),
  );
}

function resolveRequestId(req: Request): string {
  const incoming = req.headers["x-request-id"];
  if (typeof incoming === "string" && incoming.length > 0 && incoming.length <= 128) {
    return incoming;
  }
  return generateRequestId();
}

function readOfferingId(req: Request): string | null {
  const raw = req.params["offeringId"];
  return typeof raw === "string" && raw.length > 0 && raw.length <= 128 ? raw : null;
}

function readSampleId(req: Request): string | null {
  const raw = req.params["sampleId"];
  return typeof raw === "string" && raw.length > 0 && raw.length <= 128 ? raw : null;
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

type MediaTypeResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

function parseMultipartMediaType(header: string | string[] | undefined): MediaTypeResult {
  if (Array.isArray(header)) {
    return { ok: false, message: "Multiple Content-Type headers are not supported." };
  }
  if (header === undefined || header.trim() === "") {
    return { ok: false, message: "Request is missing the Content-Type header." };
  }
  const match = /^multipart\/form-data\s*;\s*boundary=([^;]+)$/i.exec(header.trim());
  if (!match) {
    return {
      ok: false,
      message: "Request Content-Type must be multipart/form-data with a boundary parameter.",
    };
  }
  const boundary = match[1]?.replace(/^"|"$/g, "") ?? "";
  if (boundary.length === 0) {
    return { ok: false, message: "Multipart boundary is empty." };
  }
  return { ok: true };
}

function parseContentLengthHeader(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return null;
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

class MultipartError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "AUDIO_PAYLOAD_TOO_LARGE"
      | "AUDIO_PAYLOAD_MISSING"
      | "AUDIO_CONTENT_TYPE_UNSUPPORTED"
      | "INVALID_AUTH_REQUEST",
  ) {
    super(message);
    this.name = "MultipartError";
  }
}

function mapMultipartErrorCode(
  err: MultipartError,
):
  | "AUDIO_PAYLOAD_TOO_LARGE"
  | "AUDIO_PAYLOAD_MISSING"
  | "AUDIO_CONTENT_TYPE_UNSUPPORTED"
  | "INVALID_AUTH_REQUEST" {
  return err.code;
}

interface ParsedMultipart {
  readonly actingWorkspaceId: string;
  readonly label: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly bytes: Buffer;
}

// Minimal multipart/form-data parser for the seller-audio slice.
//
// Scope: this parser accepts the exact shape the seller management
// UI produces — an `actingWorkspaceId` text field, a `label` text
// field, and a `file` part carrying the MP3 bytes. It rejects
// oversize or missing payloads at the trusted boundary. It is NOT
// a general-purpose multipart parser.
//
// Why hand-rolled: pulling in busboy/multer just for three fields
// adds a dependency for a bounded upload surface. The parser below
// handles three parts — `actingWorkspaceId`, `label`, `file` —
// the exact shape the BG2 UI emits. Every byte-count and label-
// char check is the application-layer policy, not the parser's
// responsibility.
async function readMultipartWithLimits(
  req: Request,
  limits: {
    readonly maxBodyBytes: number;
    readonly maxBytes: number;
    readonly maxLabelChars: number;
  },
): Promise<ParsedMultipart | null> {
  const header = req.headers["content-type"];
  const match =
    typeof header === "string"
      ? /^multipart\/form-data\s*;\s*boundary=(.+)$/i.exec(header.trim())
      : null;
  if (!match) {
    throw new MultipartError("Invalid multipart boundary.", "INVALID_AUTH_REQUEST");
  }
  const rawBoundary = (match[1] ?? "").replace(/^"|"$/g, "");
  const boundaryMarker = `--${rawBoundary}`;
  const crlfBoundary = `\r\n${boundaryMarker}`;
  const trailingBoundary = `\r\n${boundaryMarker}--`;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: MultipartError) => {
      if (settled) return;
      settled = true;
      req.pause();
      reject(err);
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > limits.maxBodyBytes) {
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
        fail(
          new MultipartError(
            `Request body exceeds the ${limits.maxBodyBytes}-byte limit.`,
            "AUDIO_PAYLOAD_TOO_LARGE",
          ),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      const buffer = Buffer.concat(chunks);
      try {
        const parsed = parseMultipartBuffer(buffer, crlfBoundary, trailingBoundary, limits);
        resolve(parsed);
      } catch (err) {
        if (err instanceof MultipartError) {
          reject(err);
        } else {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };
    const onError = (err: Error) => {
      fail(new MultipartError(err.message, "INVALID_AUTH_REQUEST"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function parseMultipartBuffer(
  buffer: Buffer,
  crlfBoundary: string,
  trailingBoundary: string,
  limits: {
    readonly maxBodyBytes: number;
    readonly maxBytes: number;
    readonly maxLabelChars: number;
  },
): ParsedMultipart | null {
  // Locate parts. The multipart/form-data format per RFC 7578 is:
  //   --{boundary}\r\n           (opening boundary, no leading CRLF)
  //   part headers\r\n
  //   \r\n
  //   part body\r\n
  //   --{boundary}\r\n           (intermediate boundary, leading CRLF)
  //   ...
  //   --{boundary}--\r\n         (closing boundary)
  let cursor = 0;
  let actingWorkspaceId: string | null = null;
  let label: string | null = null;
  let file: { contentType: string; bytes: Buffer } | null = null;

  const openingBoundary = crlfBoundary.slice(2);
  const partStart = buffer.indexOf(openingBoundary, cursor);
  if (partStart !== 0) {
    throw new MultipartError(
      "Multipart body does not start with the opening boundary.",
      "INVALID_AUTH_REQUEST",
    );
  }
  cursor = partStart + openingBoundary.length + 2;

  while (cursor < buffer.length) {
    // Find the next boundary. The closing form shares a prefix with
    // the intermediate form, so the parser picks whichever appears
    // first in the buffer; otherwise it would always match the
    // closing form at the end of the body and treat every part as
    // one.
    const intermediateIdx = buffer.indexOf(crlfBoundary, cursor);
    const closingIdx = buffer.indexOf(trailingBoundary, cursor);
    let partEnd: number;
    let last: boolean;
    if (intermediateIdx === -1 && closingIdx === -1) {
      throw new MultipartError("Multipart body is malformed.", "INVALID_AUTH_REQUEST");
    }
    if (intermediateIdx === -1) {
      partEnd = closingIdx;
      last = true;
    } else if (closingIdx === -1) {
      partEnd = intermediateIdx;
      last = false;
    } else if (closingIdx <= intermediateIdx) {
      partEnd = closingIdx;
      last = true;
    } else {
      partEnd = intermediateIdx;
      last = false;
    }
    const partBytes = buffer.subarray(cursor, partEnd);
    if (partBytes.length > 0) {
      const { headers, body } = splitPart(partBytes);
      const disposition = headers["content-disposition"] ?? "";
      const nameMatch = /name="([^"]+)"/i.exec(disposition);
      const name = nameMatch?.[1] ?? "";
      if (name === "actingWorkspaceId") {
        const text = body.toString("utf8").trim();
        if (text.length === 0 || text.length > 128) {
          throw new MultipartError(
            "actingWorkspaceId is required and must be at most 128 characters.",
            "INVALID_AUTH_REQUEST",
          );
        }
        actingWorkspaceId = text;
      } else if (name === "label") {
        const text = body.toString("utf8").trim();
        if (text.length === 0) {
          throw new MultipartError("Label is required.", "INVALID_AUTH_REQUEST");
        }
        // The label char limit aligns with the shared schema
        // (BG2_AUDIO_SAMPLE_MAX_LABEL_LENGTH = 120). Compare against
        // the character count, not the byte count, so a UTF-8 label
        // shorter than 120 chars but heavier than 120 bytes is not
        // a false-positive rejection.
        if (text.length > limits.maxLabelChars) {
          throw new MultipartError(
            `Label exceeds the ${limits.maxLabelChars}-character limit.`,
            "INVALID_AUTH_REQUEST",
          );
        }
        label = text;
      } else if (name === "file") {
        const ctype = headers["content-type"] ?? "";
        if (ctype !== BG2_AUDIO_SAMPLE_CONTENT_TYPE) {
          throw new MultipartError(
            `Sample content type must be ${BG2_AUDIO_SAMPLE_CONTENT_TYPE} (got ${ctype || "missing"}).`,
            "AUDIO_CONTENT_TYPE_UNSUPPORTED",
          );
        }
        if (body.length > limits.maxBytes) {
          throw new MultipartError(
            `Sample exceeds the ${limits.maxBytes}-byte limit.`,
            "AUDIO_PAYLOAD_TOO_LARGE",
          );
        }
        if (body.length === 0) {
          throw new MultipartError("Sample bytes are empty.", "AUDIO_PAYLOAD_MISSING");
        }
        file = { contentType: ctype, bytes: Buffer.from(body) };
      } else {
        throw new MultipartError(`Unsupported multipart field "${name}".`, "INVALID_AUTH_REQUEST");
      }
    }
    if (last) break;
    cursor = partEnd + crlfBoundary.length + 2;
  }

  if (!actingWorkspaceId || !label || !file) {
    // Distinguish between authorization-contract violations and
    // payload-shape violations so the safe envelope carries the
    // most actionable code:
    //   - actingWorkspaceId is the GS 4 authorization handle; a
    //     missing value is INVALID_AUTH_REQUEST, not a payload
    //     deficiency.
    //   - label or file missing is a multipart payload deficiency.
    //   - all three missing means the multipart body is genuinely
    //     empty; return null so the route can answer with
    //     AUDIO_PAYLOAD_MISSING (mapped to 400, not 413).
    if (!actingWorkspaceId && !label && !file) return null;
    if (!actingWorkspaceId) {
      throw new MultipartError(
        "actingWorkspaceId is required on every audio-sample command.",
        "INVALID_AUTH_REQUEST",
      );
    }
    const missing = [!label ? "label" : null, !file ? "file" : null].filter(
      (x): x is string => x !== null,
    );
    throw new MultipartError(
      `Multipart payload is missing ${missing.join(", ")} part(s).`,
      "AUDIO_PAYLOAD_MISSING",
    );
  }
  return {
    actingWorkspaceId,
    label,
    contentType: file.contentType,
    byteSize: file.bytes.length,
    bytes: file.bytes,
  };
}

interface PartSplit {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

function splitPart(partBytes: Buffer): PartSplit {
  const separator = partBytes.indexOf("\r\n\r\n");
  if (separator === -1) {
    throw new MultipartError("Multipart part is malformed.", "INVALID_AUTH_REQUEST");
  }
  const headerText = partBytes.subarray(0, separator).toString("utf8");
  const body = partBytes.subarray(separator + 4);
  const headers: Record<string, string> = {};
  for (const line of headerText.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }
  return { headers, body };
}

const removeRequestSchema = z.object({ actingWorkspaceId: z.string().min(1).max(128) }).strict();

async function readJsonBodyOrRespond(
  req: Request,
  res: Response,
  requestId: string,
): Promise<unknown> {
  // The body reader for the remove endpoint. Reused from the BG1
  // pattern (see routes/auth.ts): small JSON body, returns
  // `undefined` to signal "stop" on recognised failure modes.
  const chunks: Buffer[] = [];
  let total = 0;
  const limit = 8 * 1024;
  let settled = false;
  const fail = (code: string, message: string) => {
    if (settled) return;
    settled = true;
    writeSafeError(res, buildSafeError(code as never, message, undefined, requestId));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > limit) {
          req.pause();
          fail("INVALID_AUTH_REQUEST", "Request body exceeds the limit.");
          reject(new Error("payload-too-large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", (err: Error) => reject(err));
    });
  } catch (err) {
    if (err instanceof Error && err.message === "payload-too-large") return undefined;
    throw err;
  }
  if (res.writableEnded) return undefined;
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
    return undefined;
  }
}
