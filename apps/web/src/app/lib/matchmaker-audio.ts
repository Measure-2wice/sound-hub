// Matchmaker audio preview helper.
//
// Background: ticket #65 (BG7) lets the buyer preview the bounded
// audio samples attached to a Matchmaker recommendation without
// navigating away from the matchmaker page. This module wraps the
// existing buyer-safe `listOfferingSamples` client
// (apps/web/src/app/lib/audio-samples-client.ts) so the
// recommendation row can fetch + render an `<audio>` element.
//
// The helper is single-purpose: returns the first sample's
// `playbackUrl` (or `null` when the offering has zero live samples).
// The recommendation DTO does NOT carry audio metadata — fetching
// here keeps the M1 search surface decoupled from BG2 storage.

import { listOfferingSamples } from "./audio-samples-client";

export interface RecommendationAudioPreview {
  readonly offeringId: string;
  readonly sampleId: string;
  readonly label: string;
  readonly playbackUrl: string;
}

/**
 * Fetch the first live sample's playback URL for a recommendation's
 * `bestMatchingOffering`. Returns `null` when the offering has zero
 * samples (the common case for negative eligibility fixtures).
 *
 * Any thrown error from the underlying fetch bubbles up so the
 * caller can render an error label without losing the
 * recommendation's other affordances.
 */
export async function fetchRecommendationAudioPreview(
  offeringId: string,
): Promise<RecommendationAudioPreview | null> {
  const response = await listOfferingSamples(offeringId);
  if (response.samples.length === 0) return null;
  const first = response.samples[0]!;
  return {
    offeringId: first.offeringId,
    sampleId: first.sampleId,
    label: first.label,
    playbackUrl: first.playbackUrl,
  };
}
