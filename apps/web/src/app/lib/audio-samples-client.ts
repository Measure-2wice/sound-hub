// Audio samples client.
//
// Background: ticket #61 wires a small typed client for the seller
// audio slice. Every call runs in the browser and includes
// `credentials: "include"` so the HttpOnly session cookie rides on
// the request. Responses are parsed against the shared Zod schemas
// from `@soundhub/types` so the browser cannot drift from the
// contract.
//
// M2 (#85) PR-review feedback: the seller-side audio surface is
// now authenticated. The list endpoint is at
// `/api/workspaces/:workspaceId/service-offerings/:offeringId/audio-samples`
// and returns Draft + Paused + Active samples for the owner (the
// public buyer list at `/api/services/:offeringId/audio-samples`
// still rejects Draft offerings — the editor used to call that
// endpoint, which silently broke the refresh after a Draft
// upload). The seller preview URL is at
// `/api/workspaces/:workspaceId/service-offerings/:offeringId/audio-samples/:sampleId/play`
// and authenticates via the HttpOnly session cookie (no
// `?actingWorkspaceId` query parameter — that gate was guessable).
//
// The upload endpoint still lives at
// `/api/services/:offeringId/audio-samples` (no change to the
// seller-side upload/remove surface) but now requires a
// `confirmationVersion` multipart field so the application boundary
// can persist the closed media-use acknowledgement alongside the
// sample row.

import type {
  Bg2AudioSampleListResponseV1,
  Bg2AudioSamplePublicV1,
  Bg2AudioSampleRemoveResponseV1,
  Bg2AudioSampleUploadResponseV1,
  ServiceOfferingAudioMediaConfirmationVersionV1,
} from "@soundhub/types";
import {
  bg2AudioSampleListResponseV1Schema,
  bg2AudioSampleRemoveResponseV1Schema,
  bg2AudioSampleUploadResponseV1Schema,
} from "@soundhub/types";

// The current closed set of media-use confirmation versions the
// application boundary accepts. The editor's confirmation checkbox
// carries this version so a stale acknowledgement can never satisfy
// a future contract bump.
export const AUDIO_MEDIA_CONFIRMATION_VERSION: ServiceOfferingAudioMediaConfirmationVersionV1 =
  "m2-audio-confirmation-v1";

export interface AudioSampleError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
}

async function parseErrorResponse(response: Response): Promise<AudioSampleError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Empty or non-JSON bodies are reported with a generic code so
    // the UI can render an actionable message.
  }
  const candidate = body as {
    error?: { code?: string; message?: string; requestId?: string };
  } | null;
  const message = candidate?.error?.message ?? "Audio sample request failed.";
  const err: AudioSampleError = Object.assign(new Error(message), {
    status: response.status,
    code: candidate?.error?.code ?? "AUDIO_STORAGE_FAILED",
    requestId: candidate?.error?.requestId ?? null,
  });
  return err;
}

/**
 * M2 (#85) PR-review feedback: owner-side authenticated sample list.
 * Replaces the previous public buyer list which rejected Draft
 * offerings. The HttpOnly session cookie rides on the request via
 * `credentials: "include"`; the route re-validates Seller
 * capability + workspace ownership server-side.
 */
export async function listOfferingSamples(input: {
  readonly workspaceId: string;
  readonly offeringId: string;
}): Promise<Bg2AudioSampleListResponseV1> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/service-offerings/${encodeURIComponent(input.offeringId)}/audio-samples`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) throw await parseErrorResponse(response);
  const raw: unknown = await response.json();
  return bg2AudioSampleListResponseV1Schema.parse(raw);
}

/**
 * Public buyer-side sample list. Calls the unauthenticated
 * `/api/services/:offeringId/audio-samples` route (the route's
 * buyer-side gate requires Active + Published + Active Workspace
 * + Seller capability; Draft / Paused offerings are rejected at
 * the route). The recommendation preview calls this so a Draft
 * offering simply yields no preview rather than a hard error.
 */
export async function listOfferingSamplesPublic(
  offeringId: string,
): Promise<Bg2AudioSampleListResponseV1> {
  const response = await fetch(`/api/services/${encodeURIComponent(offeringId)}/audio-samples`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await parseErrorResponse(response);
  const raw: unknown = await response.json();
  return bg2AudioSampleListResponseV1Schema.parse(raw);
}

export interface UploadSampleInput {
  readonly offeringId: string;
  readonly actingWorkspaceId: string;
  readonly label: string;
  readonly file: File;
}

export async function uploadOfferingSample(
  input: UploadSampleInput,
): Promise<Bg2AudioSampleUploadResponseV1> {
  // Browser-driven multipart upload. The browser owns the boundary;
  // the server validates it. `actingWorkspaceId` is required on
  // every consequential command per the GS 4 contract. M2 (#85)
  // PR-review feedback: the upload boundary also requires a
  // `confirmationVersion` text part so the application can persist
  // a durable media-use acknowledgement alongside the sample.
  const body = new FormData();
  body.append("actingWorkspaceId", input.actingWorkspaceId);
  body.append("label", input.label);
  body.append("confirmationVersion", AUDIO_MEDIA_CONFIRMATION_VERSION);
  body.append("file", input.file);
  const response = await fetch(
    `/api/services/${encodeURIComponent(input.offeringId)}/audio-samples`,
    {
      method: "POST",
      credentials: "include",
      body,
    },
  );
  if (!response.ok) throw await parseErrorResponse(response);
  const raw: unknown = await response.json();
  return bg2AudioSampleUploadResponseV1Schema.parse(raw);
}

export async function removeOfferingSample(input: {
  readonly offeringId: string;
  readonly sample: Bg2AudioSamplePublicV1;
  readonly actingWorkspaceId: string;
}): Promise<Bg2AudioSampleRemoveResponseV1> {
  const response = await fetch(
    `/api/services/${encodeURIComponent(input.offeringId)}/audio-samples/${encodeURIComponent(
      input.sample.sampleId,
    )}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actingWorkspaceId: input.actingWorkspaceId }),
    },
  );
  if (!response.ok) throw await parseErrorResponse(response);
  const raw: unknown = await response.json();
  return bg2AudioSampleRemoveResponseV1Schema.parse(raw);
}
