// ServiceOffering route (M2 #85).
//
// Background: the M2 seller-onboarding slice exposes the
// ServiceOffering lifecycle for a Seller-capable Personal Workspace.
// Eight commands hang off this route family:
//
//   - POST /api/workspaces/:workspaceId/service-offerings/draft
//     M2 (#85) PR-review feedback: lazy first-create. The route
//     generates a Draft offering row tied to the Workspace's
//     SellerProfile and returns the new offeringId. The
//     `(workspaceId, idempotencyKey)` tuple on the create-evidence
//     row is the convergence key — a transport retry with the
//     same idempotencyKey returns the SAME offeringId; a
//     deliberate new attempt (a new idempotencyKey) creates a
//     fresh offering.
//
//   - GET  /api/workspaces/:workspaceId/service-offerings/:offeringId/audio-samples
//     M2 (#85) PR-review feedback: authenticated owner-side
//     sample list. Returns Draft + Paused + Active samples for the
//     owning Workspace only.
//
//   - GET  /api/workspaces/:workspaceId/service-offerings/:offeringId/audio-samples/:sampleId/play
//     M2 (#85) PR-review feedback: authenticated seller-side
//     preview. Resolves the session cookie, revalidates Seller
//     capability on the acting Workspace, and streams the
//     sample bytes for Draft / Paused / Active offerings owned by
//     that Workspace.
//
//   - PUT  /api/workspaces/:workspaceId/service-offerings/:offeringId/draft
//     Resume / update-draft. The same-attempt retry identity is
//     enforced via the application-layer compare-and-set UPDATE.
//     Lazy first-create (an empty editor on the "new" path that
//     becomes a real row only on the first Save) uses the
//     `POST /:workspaceId/service-offerings/draft` endpoint above
//     with the supplied draft payload; a deliberate second-offering
//     creation is a new POST with a new `Idempotency-Key`.
//
//   - POST /api/workspaces/:workspaceId/service-offerings/:offeringId/activate
//     Atomic Draft → Active transition with immutable evidence
//     row insertion. The client supplies `idempotencyKey` (UUID)
//     to converge transport retries on the already-persisted
//     outcome.
//
//   - GET  /api/workspaces/:workspaceId/service-offerings
//     Editor listing on-mount read of the OwnerView list.
//
//   - GET  /api/workspaces/:workspaceId/service-offerings/:offeringId
//     Editor on-mount read of the OwnerView shape (includes Draft
//     rows for the owner; never exposed publicly).
//
// Authorization contract:
//   - The route authenticates the session via
//     `AuthenticationService.resolveSessionWithSetupState`.
//   - The service layer revalidates current membership on the
//     target Personal Workspace + the Seller capability
//     precondition (Personal-Workspace-only AND Seller-capable).
//   - Organization seller-offering administration is OUT OF SCOPE
//     for #85; a Seller-capable Organization actor receives
//     `SERVICE_OFFERING_FORBIDDEN` regardless of capability.
//
// Body contract (request schemas in @soundhub/types):
//   - The draft write carries the full RELAXED field set
//     (every field is optional; a partial first-save does not
//     silently fabricate a value the seller never chose).
//   - The activate write carries the full STRICT field set plus
//     `confirmationVersion` (the immutable document identifier)
//     and `idempotencyKey` (UUID generated client-side at the
//     start of a new activation attempt; retained across uncertain
//     transport outcomes and explicit Retry actions; cleared only
//     on definitive success or user-initiated payload change).
//   - `returnTo` is optional and revalidated via the existing
//     `resolvePostCommandReturnDestination` helper.

import { Router, type Request, type Response } from "express";
import {
  BG2_AUDIO_SAMPLE_CONTENT_TYPE,
  bg2AudioSampleListResponseV1Schema,
  serviceOfferingActivateRequestV1Schema,
  serviceOfferingActivationResponseV1Schema,
  serviceOfferingCreateDraftRequestV1Schema,
  serviceOfferingDraftRequestV1Schema,
  serviceOfferingDraftResponseV1Schema,
  serviceOfferingGetResponseV1Schema,
  serviceOfferingOwnerListResponseV1Schema,
  type Bg1PublicUserV1,
} from "@soundhub/types";
import type { AuthenticationService } from "../services/authentication.service.js";
import { toPublicUser } from "../dto/public-mappers.js";
import { buildSafeError, generateRequestId, writeSafeError } from "../lib/errors.js";
import {
  resolvePostCommandReturnDestination,
  SafeReturnToFallback,
} from "../lib/post-command-return-destination.js";
import { getRequestId } from "../lib/request-id.js";
import type { ServiceOfferingService } from "../services/service-offering.service.js";
import { ServiceOfferingServiceError } from "../services/service-offering.service.js";
import type { AudioSampleService } from "../services/audio-sample.service.js";
import { AudioSampleError } from "../services/audio-sample.service.js";

const SERVICE_OFFERING_REQUEST_BODY_LIMIT = 32 * 1024;

export interface ServiceOfferingRouteDeps {
  readonly service: ServiceOfferingService;
  readonly authenticationService: AuthenticationService;
  readonly allowedReturnOrigin: string;
  /**
   * M2 (#85) PR-review feedback: the authenticated seller-side
   * audio routes (owner list + owner play) hang off this router
   * alongside the ServiceOffering writes. The audio slice keeps
   * its existing public router for the buyer-side list / play;
   * this surface is the authenticated mirror.
   */
  readonly audioSampleService: AudioSampleService;
}

export function createServiceOfferingRouter(deps: ServiceOfferingRouteDeps): Router {
  const router = Router({ mergeParams: true });
  // The router is mounted at `/api/workspaces`, so the URL path
  // remaining in the router is `/:workspaceId/service-offerings/...`.
  // The intent router at `apps/api/src/routes/intent.ts:99` uses the
  // same shape (`/:workspaceId/intent`); mirror it here so the
  // `:workspaceId` param is available to the handlers.
  router.post("/:workspaceId/service-offerings/draft", (req, res) => {
    void handleCreateDraft(req, res, deps);
  });
  router.put("/:workspaceId/service-offerings/:offeringId/draft", (req, res) => {
    void handleDraft(req, res, deps);
  });
  router.post("/:workspaceId/service-offerings/:offeringId/activate", (req, res) => {
    void handleActivate(req, res, deps);
  });
  router.get("/:workspaceId/service-offerings", (req, res) => {
    void handleList(req, res, deps);
  });
  router.get("/:workspaceId/service-offerings/:offeringId", (req, res) => {
    void handleGet(req, res, deps);
  });
  // M2 (#85) PR-review feedback: authenticated owner-side audio
  // surface. Mounted under the same workspace-scoped router so
  // the session + workspace ownership + Seller capability
  // authorization chain matches the rest of the slice.
  router.get("/:workspaceId/service-offerings/:offeringId/audio-samples", (req, res) => {
    void handleOwnerListSamples(req, res, deps);
  });
  router.get(
    "/:workspaceId/service-offerings/:offeringId/audio-samples/:sampleId/play",
    (req, res) => {
      void handleOwnerPlay(req, res, deps);
    },
  );
  return router;
}

function readSessionCookie(req: Request): string | undefined {
  // Mirror the seller-profile route / intent route patterns. The
  // cookie name is the same as every other route in the application.
  const raw = req.headers.cookie;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.startsWith("soundhub_session=")) {
      return trimmed.slice("soundhub_session=".length);
    }
  }
  return undefined;
}

async function readBody(req: Request): Promise<unknown> {
  const existing: unknown = req.body;
  if (existing !== undefined && existing !== null) {
    return existing;
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    received += buffer.length;
    if (received > SERVICE_OFFERING_REQUEST_BODY_LIMIT) {
      throw new ServiceOfferingServiceError(
        "Request body exceeds the maximum allowed size",
        "SERVICE_OFFERING_INVALID",
      );
    }
    chunks.push(buffer);
  }
  if (received === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function resolveActor(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<{ userAccountId: string; workspaceId: string; freshUser: Bg1PublicUserV1 } | null> {
  const workspaceId = (req.params.workspaceId ?? "").trim();
  if (!workspaceId) {
    writeSafeError(
      res,
      buildSafeError(
        "SERVICE_OFFERING_INVALID",
        "Missing workspaceId",
        undefined,
        getRequestId(req as Request & { requestId?: string }),
      ),
    );
    return null;
  }
  const sessionId = readSessionCookie(req);
  const resolved = await deps.authenticationService.resolveSessionWithSetupState(sessionId);
  if (!resolved) {
    writeSafeError(
      res,
      buildSafeError(
        "SESSION_INVALID",
        "Authentication required.",
        undefined,
        getRequestId(req as Request & { requestId?: string }),
      ),
    );
    return null;
  }
  const freshUser: Bg1PublicUserV1 = toPublicUser(resolved.user, resolved.setupState);
  return { userAccountId: freshUser.userAccountId, workspaceId, freshUser };
}

function readOfferingId(req: Request): string | null {
  const raw = req.params["offeringId"];
  return typeof raw === "string" && raw.length > 0 && raw.length <= 128 ? raw : null;
}

async function handleDraft(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  const offeringId = readOfferingId(req);
  if (!offeringId) {
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Missing serviceOfferingId", undefined, requestId),
    );
    return;
  }
  let rawBody: unknown;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    if (err instanceof ServiceOfferingServiceError) {
      writeTranslatedError(res, err.code, err.message, err.fieldErrors, requestId);
      return;
    }
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Malformed request body", undefined, requestId),
    );
    return;
  }
  const parsed = serviceOfferingDraftRequestV1Schema.safeParse(rawBody);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Malformed draft request", fields, requestId),
    );
    return;
  }
  try {
    const result = await deps.service.saveDraft({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
      offeringId,
      request: parsed.data,
    });
    const safeReturnTo = await resolveSafeReturnTo(
      deps,
      actor.freshUser,
      actor.workspaceId,
      parsed.data.returnTo,
    );
    writeJson(
      res,
      200,
      serviceOfferingDraftResponseV1Schema.parse({
        ...result,
        safeReturnTo,
      }),
    );
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function handleActivate(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  const offeringId = readOfferingId(req);
  if (!offeringId) {
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Missing serviceOfferingId", undefined, requestId),
    );
    return;
  }
  let rawBody: unknown;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    if (err instanceof ServiceOfferingServiceError) {
      writeTranslatedError(res, err.code, err.message, err.fieldErrors, requestId);
      return;
    }
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Malformed request body", undefined, requestId),
    );
    return;
  }
  const parsed = serviceOfferingActivateRequestV1Schema.safeParse(rawBody);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Malformed activate request", fields, requestId),
    );
    return;
  }
  try {
    const result = await deps.service.activate({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
      offeringId,
      request: parsed.data,
      requestId,
    });
    const safeReturnTo = await resolveSafeReturnTo(
      deps,
      actor.freshUser,
      actor.workspaceId,
      parsed.data.returnTo,
    );
    writeJson(
      res,
      200,
      serviceOfferingActivationResponseV1Schema.parse({
        ...result,
        safeReturnTo,
      }),
    );
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function handleList(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  try {
    const result = await deps.service.listOfferingsForOwner({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
    });
    writeJson(res, 200, serviceOfferingOwnerListResponseV1Schema.parse(result));
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

async function handleGet(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  const offeringId = readOfferingId(req);
  if (!offeringId) {
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Missing serviceOfferingId", undefined, requestId),
    );
    return;
  }
  try {
    const result = await deps.service.getCurrentOffering({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
      offeringId,
    });
    writeJson(res, 200, serviceOfferingGetResponseV1Schema.parse(result));
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

function resolveSafeReturnTo(
  deps: ServiceOfferingRouteDeps,
  freshUser: Bg1PublicUserV1,
  workspaceId: string,
  returnTo: string | undefined,
): Promise<string | null> {
  if (!returnTo) return Promise.resolve(null);
  try {
    const resolved = resolvePostCommandReturnDestination({
      returnTo,
      freshUser,
      actingWorkspaceId: workspaceId,
      allowedOrigin: deps.allowedReturnOrigin,
    });
    return Promise.resolve(resolved?.path ?? null);
  } catch (err) {
    if (err instanceof SafeReturnToFallback) {
      return Promise.resolve(null);
    }
    throw err;
  }
}

function writeJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

function writeServiceError(res: Response, err: unknown, requestId: string): void {
  if (err instanceof ServiceOfferingServiceError) {
    writeTranslatedError(res, err.code, err.message, err.fieldErrors, requestId);
    return;
  }
  console.error(`[service-offering] requestId=${requestId} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "SERVICE_OFFERING_INTERNAL_FAILED",
      "An unexpected error occurred while processing the request.",
      undefined,
      requestId,
    ),
  );
}

function writeTranslatedError(
  res: Response,
  code: ServiceOfferingServiceError["code"],
  message: string,
  fieldErrors: ServiceOfferingServiceError["fieldErrors"],
  requestId: string,
): void {
  const fields = fieldErrors.length > 0 ? fieldErrors : undefined;
  writeSafeError(res, buildSafeError(code, message, fields, requestId));
}

// ---------- M2 (#85) PR-review feedback: create + owner-side audio ----------

async function handleCreateDraft(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;

  // The idempotency key arrives via the `Idempotency-Key` header
  // (preferred) or a `idempotencyKey` JSON body field for clients
  // that cannot set custom headers. The body carries the full
  // RELAXED draft field set — the create-and-save is one atomic
  // transaction (M2 #85 PR-review feedback round 3).
  //
  // PR-review feedback (round 4): a malformed or oversized body
  // MUST NOT be silently coerced to `undefined`. With every
  // draft field optional and a valid `Idempotency-Key` header,
  // the schema would pass and the route would persist an
  // empty Draft — a regression of round 3's "no empty orphans"
  // contract. Surface the parse error as
  // SERVICE_OFFERING_INVALID without invoking the service.
  let body: unknown = undefined;
  try {
    body = await readBody(req);
  } catch (err) {
    const message =
      err instanceof Error && err.message.length > 0
        ? `Malformed create request body: ${err.message}`
        : "Malformed create request body";
    writeSafeError(res, buildSafeError("SERVICE_OFFERING_INVALID", message, undefined, requestId));
    return;
  }
  const idempotencyKey = readIdempotencyKey(req, body);
  const parsed = serviceOfferingCreateDraftRequestV1Schema.safeParse({
    ...(body && typeof body === "object" ? body : {}),
    idempotencyKey,
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Malformed create request", fields, requestId),
    );
    return;
  }

  try {
    const result = await deps.service.createDraft({
      userAccountId: actor.userAccountId,
      workspaceId: actor.workspaceId,
      requestId,
      idempotencyKey: parsed.data.idempotencyKey,
      draft: parsed.data,
    });
    const body = serviceOfferingDraftResponseV1Schema.parse({
      ok: true,
      offering: result,
      returnTo: null,
      safeReturnTo: null,
    });
    res.status(201).json(body);
  } catch (err) {
    writeServiceError(res, err, requestId);
  }
}

function readIdempotencyKey(req: Request, body: unknown): string {
  const headerVal = req.headers["idempotency-key"];
  if (typeof headerVal === "string" && headerVal.length > 0) {
    return headerVal;
  }
  if (
    body &&
    typeof body === "object" &&
    "idempotencyKey" in body &&
    typeof (body as { idempotencyKey?: unknown }).idempotencyKey === "string"
  ) {
    return (body as { idempotencyKey: string }).idempotencyKey;
  }
  return "";
}

async function handleOwnerListSamples(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  const offeringId = readOfferingIdFromParams(req);
  if (!offeringId) {
    writeSafeError(
      res,
      buildSafeError("SERVICE_OFFERING_INVALID", "Missing serviceOfferingId", undefined, requestId),
    );
    return;
  }
  try {
    const result = await deps.audioSampleService.listSamplesForSeller({
      userAccountId: actor.userAccountId,
      offeringId,
      actingWorkspaceId: actor.workspaceId,
    });
    const body = bg2AudioSampleListResponseV1Schema.parse({
      offeringId: result.offeringId,
      samples: result.samples,
    });
    res.status(200).json(body);
  } catch (err) {
    writeAudioErrorForServiceOffering(res, err, requestId);
  }
}

async function handleOwnerPlay(
  req: Request,
  res: Response,
  deps: ServiceOfferingRouteDeps,
): Promise<void> {
  const requestId = generateRequestId();
  res.setHeader("x-request-id", requestId);
  // M2 (#85) Manual QA Round 4 — private audio playback blocker.
  //
  // Helmet's default `Cross-Origin-Resource-Policy: same-origin`
  // (apps/api/src/index.ts `app.use(helmet())`) prevents the
  // SoundHub web origin from embedding the audio stream it
  // serves. The SoundHub web runs on `localhost:3000`, the API
  // on `localhost:4000` (production is the same shape — different
  // origins), and the global helmet policy blocks the browser
  // from loading the response body. The result on the editor was
  // `Runtime NotSupportedError` raised by the `<audio>` element.
  //
  // The owner-side `/play` route is the single audio playback
  // surface hung off the workspace-scoped router, and it is the
  // ONLY authenticated media route in the application (the
  // buyer-side `/api/services/.../play` is unauthenticated and
  // stays at helmet's default). The route already enforces
  // authorization, workspace ownership, and offering lifecycle
  // state via the session cookie + the audio service. Releasing
  // the CORP policy here lets the SoundHub browser app embed
  // the authenticated preview bytes without disabling helmet
  // globally and without weakening any other API route's CORP
  // policy.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  const offeringId = readOfferingIdFromParams(req);
  const sampleId = readSampleIdFromParams(req);
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
    const playback = await deps.audioSampleService.getBytesForPlayback({
      offeringId,
      sampleId,
      actingUserAccountId: actor.userAccountId,
      actingWorkspaceId: actor.workspaceId,
    });
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
    writeAudioErrorForServiceOffering(res, err, requestId);
  }
}

function readOfferingIdFromParams(req: Request): string | null {
  const raw = req.params["offeringId"];
  return typeof raw === "string" && raw.length > 0 && raw.length <= 128 ? raw : null;
}

function readSampleIdFromParams(req: Request): string | null {
  const raw = req.params["sampleId"];
  return typeof raw === "string" && raw.length > 0 && raw.length <= 128 ? raw : null;
}

function writeAudioErrorForServiceOffering(res: Response, err: unknown, requestId: string): void {
  if (err instanceof AudioSampleError) {
    // The AudioSampleError code is a stable API error code (the
    // BG2 + new AUDIO_SAMPLE_MEDIA_CONFIRMATION_REQUIRED codes
    // are all part of `apiErrorCodeV1Schema`), so passing it
    // directly to `buildSafeError` is type-correct. Cast through
    // `unknown` to satisfy the strict signature.
    writeSafeError(res, buildSafeError(err.code, err.message, undefined, requestId));
    return;
  }
  console.error(`[service-offering-audio] requestId=${requestId} unhandled:`, err);
  writeSafeError(
    res,
    buildSafeError(
      "SERVICE_OFFERING_INTERNAL_FAILED",
      "An unexpected error occurred while processing the request.",
      undefined,
      requestId,
    ),
  );
}
