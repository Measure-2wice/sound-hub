// Audio samples client.
//
// Background: ticket #61 wires a small typed client for the seller
// audio slice. Every call runs in the browser and includes
// `credentials: "include"` so the HttpOnly session cookie rides on
// the request. Responses are parsed against the shared Zod schemas
// from `@soundhub/types` so the browser cannot drift from the
// contract.
//
// The list endpoint is unauthenticated; the upload and remove
// endpoints require the seller session. The seller management UI
// calls the list endpoint on mount and again after every successful
// upload or remove, so a freshly-removed sample disappears from the
// UI without an explicit optimistic update.

import type {
  Bg2AudioSampleListResponseV1,
  Bg2AudioSamplePublicV1,
  Bg2AudioSampleRemoveResponseV1,
  Bg2AudioSampleUploadResponseV1,
} from "@soundhub/types";
import {
  bg2AudioSampleListResponseV1Schema,
  bg2AudioSampleRemoveResponseV1Schema,
  bg2AudioSampleUploadResponseV1Schema,
} from "@soundhub/types";

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

export async function listOfferingSamples(
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
  readonly label: string;
  readonly file: File;
}

export async function uploadOfferingSample(
  input: UploadSampleInput,
): Promise<Bg2AudioSampleUploadResponseV1> {
  // Browser-driven multipart upload. The browser owns the boundary;
  // the server validates it.
  const body = new FormData();
  body.append("label", input.label);
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
}): Promise<Bg2AudioSampleRemoveResponseV1> {
  const response = await fetch(
    `/api/services/${encodeURIComponent(input.offeringId)}/audio-samples/${encodeURIComponent(
      input.sample.sampleId,
    )}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) throw await parseErrorResponse(response);
  const raw: unknown = await response.json();
  return bg2AudioSampleRemoveResponseV1Schema.parse(raw);
}

/**
 * Resolve a buyer-safe playback URL for a sample. The deterministic
 * adapter returns the in-process `/api/services/.../audio-samples/
 * .../play` route; Supabase Storage returns a narrowly scoped signed
 * URL. The browser renders the value as the `<audio>` tag's `src`
 * without inspecting the internals.
 */
export function playbackUrlFor(input: {
  readonly offeringId: string;
  readonly sampleId: string;
}): string {
  return `/api/services/${encodeURIComponent(input.offeringId)}/audio-samples/${encodeURIComponent(
    input.sampleId,
  )}/play`;
}
