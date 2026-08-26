// Express routes for the seller-audio slice (Buildathon Golden Slice 2).
//
// Background: ticket #61 wires a bounded MP3 upload/list/play/remove
// surface through the same Express application boundary as the M1
// search and BG1 auth routes. Every consequential command:
//
//   - resolves the authenticated user via the HttpOnly session
//     cookie (the same cookie the BG1 /api/auth/me route reads);
//   - delegates to the AudioSampleService, which owns the
//     authorization, content-type, size, and 3-sample-cap rules;
//   - emits the shared safe envelope on rejection so a future
//     contract-drift detector can compare the response codes
//     against the schema enum.
//
// Endpoints:
//
//   POST   /api/services/:offeringId/audio-samples
//     multipart/form-data with `label`, `file` (audio/mpeg, ≤ 25 MB).
//     Requires authentication + Seller capability + offering ownership.
//     Returns { ok: true, sample } on success.
//
//   GET    /api/services/:offeringId/audio-samples
//     Buyer-facing read of the bounded samples for an Active
//     offering. No authentication required: the samples are public
//     discovery evidence. Returns the same allow-listed DTO the
//     seller management UI consumes, so the UI can rely on a single
//     list endpoint.
//
//   DELETE /api/services/:offeringId/audio-samples/:sampleId
//     Requires authentication + Seller capability + offering ownership.
//     Removes a sample. Idempotent: a missing sample returns the
//     safe envelope code AUDIO_SAMPLE_NOT_FOUND.
//
// Buyer-facing playback:
//
//   GET    /api/services/:offeringId/audio-samples/:sampleId/play
//     Read-only stream of an Active offering's sample bytes for the
//     deterministic adapter. The Supabase path returns a signed URL
//     in the public DTO instead.

import { Router, type NextFunction, type Request, type Response } from "express";
import {
  bg2AudioSampleListResponseV1Schema,
  bg2AudioSampleRemoveResponseV1Schema,
  bg2AudioSampleUploadResponseV1Schema,
  BG2_AUDIO_SAMPLE_CONTENT_TYPE,
  BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE,
  BG2_AUDIO_SAMPLE_MAX_LABEL_LENGTH,
  type Bg2AudioSamplePublicV1,
} from "@soundhub/types";
import { ZodError } from "zod";
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
import type { StorageAdapter } from "../storage/storage-adapter.js";

export interface AudioSamplesRouteDeps {
  readonly service: AudioSampleService;
  readonly authenticationService: AuthenticationService;
  /**
   * The same storage adapter the service uses, exposed here so the
   * deterministic playback route can read bytes for the in-process
   * adapter. Supabase Storage streams via signed URLs returned in
   * the public DTO instead.
   */
  readonly storage: StorageAdapter;
}

const MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024; // 30 MB; 25 MB sample + multipart overhead
const MAX_LABEL_BYTES = BG2_AUDIO_SAMPLE_MAX_LABEL_LENGTH * 4; // upper bound on UTF-8 expansion

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

  // Multipart parse. The request boundary is the trusted point for
  // content-type and size enforcement; the service runs the same
  // checks defensively.
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
      maxLabelBytes: MAX_LABEL_BYTES,
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
    // The buyer-facing list is public for an Active offering. The
    // service runs the eligibility check (Active offering, Published
    // profile, Active Workspace, Seller capability) before returning
    // any samples; the route does not authenticate the caller.
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

  try {
    const result = await deps.service.removeSample({
      userAccountId: view.userAccountId,
      offeringId,
      sampleId,
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
    writeSafeError(
      res,
      buildSafeError(
        "INVALID_AUTH_REQUEST",
        "Audio sample response failed schema validation.",
        buildFieldErrors(err.issues),
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
  readonly label: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly bytes: Buffer;
}

// Minimal multipart/form-data parser for the seller-audio slice.
//
// Scope: this parser accepts the exact shape the seller management
// UI produces — a `label` text field and a `file` part carrying the
// MP3 bytes. It rejects oversize or missing payloads at the trusted
// boundary. It is NOT a general-purpose multipart parser.
//
// Why hand-rolled: pulling in busboy/multer just for two fields adds
// a dependency for a bounded upload surface. The parser below
// handles one file part and one label part, the exact shape the
// BG2 UI emits. Every byte-count check is the application-layer
// policy, not the parser's responsibility.
async function readMultipartWithLimits(
  req: Request,
  limits: {
    readonly maxBodyBytes: number;
    readonly maxBytes: number;
    readonly maxLabelBytes: number;
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
    readonly maxLabelBytes: number;
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
  let label: string | null = null;
  let file: { contentType: string; bytes: Buffer } | null = null;

  // First boundary has no leading CRLF. Compute its offset directly.
  const openingBoundary = crlfBoundary.slice(2); // strip the leading \r\n
  const partStart = buffer.indexOf(openingBoundary, cursor);
  if (partStart !== 0) {
    throw new MultipartError(
      "Multipart body does not start with the opening boundary.",
      "INVALID_AUTH_REQUEST",
    );
  }
  // Skip past `--{boundary}\r\n` to reach the part headers.
  cursor = partStart + openingBoundary.length + 2; // +2 for \r\n

  while (cursor < buffer.length) {
    // Find the next boundary. The boundary is whichever of the
    // intermediate or closing forms appears FIRST in the buffer; the
    // closing form shares a prefix with the intermediate form, so a
    // naive `indexOf(trailingBoundary)` would always match the
    // closing form at the end of the body and the parser would treat
    // every part as one. Pick the nearer occurrence.
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
      // The closing form appears first. Two valid shapes are
      // possible: a body whose only part ends at the closing form,
      // or a body whose second part is the closing form. The latter
      // is the only valid RFC 7578 shape for any body with more
      // than one part.
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
      if (name === "label") {
        const text = body.toString("utf8").trim();
        if (text.length === 0 || text.length > limits.maxLabelBytes) {
          throw new MultipartError(
            "Label is required and must fit within the byte limit.",
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
    // Skip past `\r\n--{boundary}\r\n` to reach the next part's headers.
    cursor = partEnd + crlfBoundary.length + 2; // +2 for \r\n after boundary
  }

  if (!label || !file) {
    if (!label && !file) return null;
    throw new MultipartError(
      `Multipart payload is missing ${!label ? "label" : "file"} part.`,
      "AUDIO_PAYLOAD_MISSING",
    );
  }
  return {
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
  // Headers are separated from the body by a blank CRLF.
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

// Suppress unused-import warning on Bg2AudioSamplePublicV1: the
// runtime return value uses the inferred type from bg2AudioSampleListResponseV1Schema.
void (null as unknown as Bg2AudioSamplePublicV1);
