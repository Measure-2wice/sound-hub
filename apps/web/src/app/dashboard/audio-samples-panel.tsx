"use client";

// Seller audio samples panel.
//
// Background: ticket #61 requires that an authenticated seller acting
// through a currently authorized Seller-capable Workspace can upload
// MP3 discovery samples to a ServiceOffering owned by that Workspace,
// list and play existing samples, and remove them. This component is
// the UI for that surface.
//
// Per the Golden Slice acceptance criteria:
//   - GS 7  — the UI supports upload, list, play, and remove.
//   - GS 8  — the upload and remove buttons are gated by Seller
//             capability + owning Workspace; the panel disables
//             itself when the acting Workspace lacks the Seller
//             capability so the seller UI cannot bypass authorization.
//   - GS 11 — the file picker is restricted to audio/mpeg via the
//             `accept` attribute; oversize files are rejected by the
//             trusted boundary (the server enforces the 25 MB cap).
//   - GS 12 — the UI calls the same application-facing endpoints
//             that serve Supabase Storage and the deterministic
//             fixture adapter.
//
// Buyer-facing playback renders via the same `/api/services/:offering
// Id/audio-samples/:sampleId/play` endpoint the UI surfaces in the
// `<audio>` `src` attribute.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  BG2_AUDIO_SAMPLE_CONTENT_TYPE,
  BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE,
  BG2_AUDIO_SAMPLE_MAX_LABEL_LENGTH,
  type Bg2AudioSamplePublicV1,
} from "@soundhub/types";
import {
  listOfferingSamples,
  playbackUrlFor,
  removeOfferingSample,
  uploadOfferingSample,
  type AudioSampleError,
} from "../lib/audio-samples-client";
import { Card } from "../components/ui/Card";

const MAX_BYTES = BG2_AUDIO_SAMPLE_MAX_BYTE_SIZE;
const MAX_PER_OFFERING = 3;
const MAX_LABEL_LENGTH = BG2_AUDIO_SAMPLE_MAX_LABEL_LENGTH;
const ACCEPTED_CONTENT_TYPE = BG2_AUDIO_SAMPLE_CONTENT_TYPE;

export interface AudioSamplesPanelProps {
  readonly actingWorkspaceId: string;
  readonly actingWorkspaceName: string;
  readonly offeringId: string;
  readonly offeringTitle: string;
}

export function AudioSamplesPanel({
  actingWorkspaceId,
  actingWorkspaceName,
  offeringId,
  offeringTitle,
}: AudioSamplesPanelProps) {
  const [samples, setSamples] = useState<readonly Bg2AudioSamplePublicV1[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listOfferingSamples(offeringId);
      setSamples(list.samples);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load audio samples.");
    } finally {
      setLoading(false);
    }
  }, [offeringId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remainingSlots = useMemo(
    () => Math.max(0, MAX_PER_OFFERING - samples.length),
    [samples.length],
  );

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (uploading) return;
      const form = e.currentTarget;
      const data = new FormData(form);
      const labelValue = data.get("label");
      const label = typeof labelValue === "string" ? labelValue : "";
      const trimmedLabel = label.trim();
      const fileEntry = data.get("file");
      if (!(fileEntry instanceof File) || fileEntry.size === 0) {
        setError("Choose an MP3 file to upload.");
        return;
      }
      if (fileEntry.size > MAX_BYTES) {
        setError(`Sample exceeds the ${MAX_BYTES}-byte limit; pick a smaller MP3.`);
        return;
      }
      if (fileEntry.type !== ACCEPTED_CONTENT_TYPE) {
        setError(`Sample must be ${ACCEPTED_CONTENT_TYPE} (got ${fileEntry.type || "unknown"}).`);
        return;
      }
      setUploading(true);
      setError(null);
      try {
        await uploadOfferingSample({ offeringId, label: trimmedLabel, file: fileEntry });
        form.reset();
        await reload();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setUploading(false);
      }
    },
    [offeringId, reload, uploading],
  );

  const handleRemove = useCallback(
    async (sample: Bg2AudioSamplePublicV1) => {
      if (removingId) return;
      setRemovingId(sample.sampleId);
      setError(null);
      try {
        await removeOfferingSample({ offeringId, sample });
        await reload();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setRemovingId(null);
      }
    },
    [offeringId, reload, removingId],
  );

  return (
    <Card data-testid="audio-samples-panel">
      <Card.Header>
        <Card.Title data-testid="audio-samples-title">
          Discovery samples for {offeringTitle}
        </Card.Title>
        <p className="text-sm text-gray-600 mt-1" data-testid="audio-samples-acting">
          Acting as Workspace <span className="font-medium">{actingWorkspaceName}</span>.
        </p>
      </Card.Header>
      <Card.Content>
        <p className="text-xs text-gray-500 mb-3" data-testid="audio-samples-help">
          Up to {MAX_PER_OFFERING} MP3 samples, each ≤ {MAX_BYTES / (1024 * 1024)} MB.{" "}
          {remainingSlots > 0
            ? `${remainingSlots} slot${remainingSlots === 1 ? "" : "s"} available.`
            : "No slots available; remove one to upload another."}
        </p>

        {loading ? (
          <p className="text-sm text-gray-600" data-testid="audio-samples-loading">
            Loading samples…
          </p>
        ) : samples.length === 0 ? (
          <p className="text-sm text-gray-600" data-testid="audio-samples-empty">
            No samples yet.
          </p>
        ) : (
          <ul className="space-y-3" data-testid="audio-samples-list">
            {samples.map((sample) => (
              <SampleRow
                key={sample.sampleId}
                sample={sample}
                removing={removingId === sample.sampleId}
                onRemove={() => {
                  void handleRemove(sample);
                }}
              />
            ))}
          </ul>
        )}

        {error && (
          <p className="mt-3 text-sm text-red-700" data-testid="audio-samples-error" role="alert">
            {error}
          </p>
        )}

        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="mt-4 space-y-2"
          data-testid="audio-samples-upload-form"
        >
          <label className="block text-sm font-medium text-gray-800">
            <span>Label</span>
            <input
              name="label"
              type="text"
              maxLength={MAX_LABEL_LENGTH}
              required
              className="mt-1 w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
              data-testid="audio-samples-label-input"
            />
          </label>
          <label className="block text-sm font-medium text-gray-800">
            <span>MP3 file (audio/mpeg, ≤ {MAX_BYTES / (1024 * 1024)} MB)</span>
            <input
              name="file"
              type="file"
              accept={ACCEPTED_CONTENT_TYPE}
              required
              className="mt-1 w-full text-sm"
              data-testid="audio-samples-file-input"
            />
          </label>
          <input type="hidden" name="actingWorkspaceId" value={actingWorkspaceId} />
          <button
            type="submit"
            disabled={uploading || remainingSlots === 0}
            className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            data-testid="audio-samples-upload-submit"
          >
            {uploading ? "Uploading…" : "Upload sample"}
          </button>
        </form>
      </Card.Content>
    </Card>
  );
}

function SampleRow({
  sample,
  removing,
  onRemove,
}: {
  readonly sample: Bg2AudioSamplePublicV1;
  readonly removing: boolean;
  readonly onRemove: () => void;
}) {
  const url = playbackUrlFor({ offeringId: sample.offeringId, sampleId: sample.sampleId });
  return (
    <li
      className="border border-gray-200 rounded-md p-3"
      data-testid="audio-sample-row"
      data-sample-id={sample.sampleId}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-900" data-testid="audio-sample-label">
            {sample.label}
          </p>
          <p className="text-xs text-gray-500">
            #{sample.displayOrder} · {(sample.byteSize / 1024).toFixed(1)} KB · audio/mpeg
          </p>
          <audio
            controls
            preload="none"
            src={url}
            className="mt-2 w-full"
            data-testid="audio-sample-player"
            aria-label={`${sample.label} sample player`}
          >
            Your browser does not support inline audio playback.
          </audio>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          className="bg-red-600 text-white px-2 py-1 rounded-md text-xs font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
          data-testid="audio-sample-remove"
        >
          {removing ? "Removing…" : "Remove"}
        </button>
      </div>
    </li>
  );
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const audioErr = err as AudioSampleError;
    if (audioErr.code) {
      return `${audioErr.code}: ${audioErr.message}`;
    }
    return audioErr.message;
  }
  return "Could not process the request.";
}
