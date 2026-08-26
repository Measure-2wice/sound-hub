"use client";

// Buyer-discovery audio samples panel.
//
// Background: ticket #61 follow-up review (P1-002 / P2-001)
// requires that the buyer search UI integrate bounded audio
// sample playback AND parse the response against the shared
// `bg2AudioSampleListResponseV1Schema` so a malformed or hostile
// payload cannot crash the render path. The component is
// read-only, public, and reaches the same
// `/api/services/:offeringId/audio-samples` endpoint the
// seller-management UI consumes.
//
// The browser renders `sample.playbackUrl` (a SoundHub-owned
// in-app route) directly. The application re-runs eligibility +
// sample-existence checks on every request, so removed or
// ineligible samples never appear.

import { useEffect, useState } from "react";
import { bg2AudioSampleListResponseV1Schema, type Bg2AudioSamplePublicV1 } from "@soundhub/types";

export interface AudioSamplesPanelProps {
  readonly offeringId: string;
  readonly offeringTitle: string;
}

interface PanelState {
  readonly samples: readonly Bg2AudioSamplePublicV1[];
  readonly loading: boolean;
  readonly error: string | null;
}

export function AudioSamplesPanel({ offeringId, offeringTitle }: AudioSamplesPanelProps) {
  const [state, setState] = useState<PanelState>({ samples: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ samples: [], loading: true, error: null });
    void (async () => {
      try {
        const response = await fetch(
          `/api/services/${encodeURIComponent(offeringId)}/audio-samples`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
          },
        );
        if (!response.ok) {
          // 403/404 means the offering is ineligible or removed;
          // treat as "no samples" so the buyer UI degrades cleanly.
          if (response.status === 403 || response.status === 404) {
            if (!cancelled) {
              setState({ samples: [], loading: false, error: null });
            }
            return;
          }
          throw new Error(`Audio fetch failed (${response.status}).`);
        }
        const raw: unknown = await response.json();
        // Per ticket #61 follow-up review (P2-001): the panel must
        // validate the response against the shared Zod schema so a
        // hostile or drifted payload (null entries, malformed
        // label/playbackUrl, oversized arrays) cannot crash the
        // render path. The server is also validated, so this is a
        // defense-in-depth contract boundary.
        const parsed = bg2AudioSampleListResponseV1Schema.safeParse(raw);
        if (!parsed.success) {
          throw new Error("Audio response shape is invalid.");
        }
        if (!cancelled) {
          setState({ samples: parsed.data.samples, loading: false, error: null });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            samples: [],
            loading: false,
            error: err instanceof Error ? err.message : "Could not load samples.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [offeringId]);

  if (state.loading) {
    return (
      <p className="mt-2 text-xs text-gray-500" data-testid="audio-samples-loading">
        Loading samples…
      </p>
    );
  }
  if (state.error) {
    return (
      <p className="mt-2 text-xs text-red-700" data-testid="audio-samples-error" role="alert">
        {state.error}
      </p>
    );
  }
  if (state.samples.length === 0) {
    return null;
  }
  return (
    <ul
      className="mt-2 space-y-2"
      data-testid="audio-samples-list"
      aria-label={`Audio samples for ${offeringTitle}`}
    >
      {state.samples.map((sample) => (
        <li
          key={sample.sampleId}
          className="border border-gray-200 rounded-md p-2"
          data-testid="audio-sample-row"
          data-sample-id={sample.sampleId}
        >
          <p className="text-xs font-medium text-gray-900" data-testid="audio-sample-label">
            {sample.label}
          </p>
          <audio
            controls
            preload="none"
            src={sample.playbackUrl}
            className="mt-1 w-full"
            data-testid="audio-sample-player"
            aria-label={`${sample.label} sample player`}
          >
            Your browser does not support inline audio playback.
          </audio>
        </li>
      ))}
    </ul>
  );
}
