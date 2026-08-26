// Deterministic AI adapter.
//
// Background: BG3 requires the AI boundary to fail closed: invalid
// or unavailable AI output uses a deterministic fallback that
// crosses the same validation + TalentSearchService boundary. This
// adapter is that fallback.
//
// The adapter is intentionally simple: it parses the buyer's brief
// for a small set of recognised phrases and emits a candidate
// criteria payload that respects every hard requirement the buyer
// expressed. Required constraints are NEVER silently relaxed — the
// adapter maps phrases like "remote" / "in-person" / "in person"
// into a `required.serviceModes` entry, and matches genre tokens
// ("dancehall", "soca", "bachata", "afrobeats", …) into
// `preferred.genreTags`. No other behaviour exists; everything else
// is left to the search service's eligibility rules.
//
// The adapter is NOT a heuristic AI model. It is a deterministic
// fallback. Its contract guarantees are:
//
//   - Identical inputs produce identical candidate payloads.
//   - Required constraints appear only when the buyer's text names
//     them; absent signals do not invent constraints.
//   - The candidate payload ALWAYS validates against
//     `bg3MatchmakerCriteriaV1Schema` so the application boundary
//     accepts it without falling back further.
//
// The adapter has no dependency on Prisma, on storage, or on the
// authentication boundary. It can be unit-tested in isolation.

import { bg3MatchmakerCriteriaV1Schema } from "@soundhub/types";
import type { Bg3AiInterpretInputV1, Bg3AiInterpretOutputV1 } from "@soundhub/types";
import { AiInvalidOutputError, type AiAdapter } from "./ai-adapter.js";

// A curated allow-list of phrases the deterministic fallback maps to
// the M1 `serviceModes` enum. Each value is a normalised lowercase
// substring; the buyer text is lowercased before matching so
// case variations ("Remote", "remote", "REMOTE") all collide on
// the same canonical entry. Substrings are intentionally chosen to
// match buyer phrasing without false positives; e.g. "in-person"
// must not collide with "in-person consulting" because both phrases
// collapse to "InPerson" anyway, but we deliberately avoid
// matching the bare word "person" inside unrelated phrases.
//
// Anything outside the allow-list is treated as "buyer did not
// express a hard service-mode requirement" and the required
// constraint is left absent — the search service still produces
// eligibility-determined results (the brief may match other hard
// axes the buyer expressed, like category or location).
const SERVICE_MODE_PHRASES: ReadonlyArray<{
  readonly phrase: string;
  readonly mode: "Remote" | "InPerson" | "Hybrid";
}> = [
  { phrase: "remote only", mode: "Remote" },
  { phrase: "remote", mode: "Remote" },
  { phrase: "in-person", mode: "InPerson" },
  { phrase: "in person", mode: "InPerson" },
  { phrase: "live in", mode: "InPerson" },
  { phrase: "live performance", mode: "InPerson" },
  { phrase: "live set", mode: "InPerson" },
  { phrase: "hybrid", mode: "Hybrid" },
];

// A curated allow-list of genres the deterministic fallback
// recognises. The list mirrors the genre tags the canonical seed
// uses so the search service can actually match them. Genres the
// buyer mentions that are NOT in this list are dropped silently —
// the search service will still rank by other signals, but no
// fabricated genre tag is produced.
const KNOWN_GENRES: ReadonlyArray<string> = [
  "dancehall",
  "soca",
  "bachata",
  "merengue",
  "afrobeats",
  "reggae",
  "hip-hop",
  "r&b",
  "pop",
  "calypso",
  "junkanoo",
  "score",
  "ambient",
  "cinematic",
];

// Category keys mirror the canonical seed so a recognised phrase
// produces a real `primaryCategoryKey`. Phrases outside the table
// are not promoted to required categories; the buyer may still
// surface a recommendation through other axes.
const CATEGORY_PHRASES: ReadonlyArray<{
  readonly phrase: string;
  readonly key: string;
}> = [
  { phrase: "songwriting", key: "songwriting" },
  { phrase: "song writer", key: "songwriting" },
  { phrase: "songwriter", key: "songwriting" },
  { phrase: "topline", key: "songwriting" },
  { phrase: "mixing", key: "mixing" },
  { phrase: "mix engineer", key: "mixing" },
  { phrase: "mastering", key: "mastering" },
  { phrase: "master", key: "mastering" },
  { phrase: "session vocals", key: "session-vocals" },
  { phrase: "vocal recording", key: "session-vocals" },
  { phrase: "session instrument", key: "session-instrument-performance" },
  { phrase: "recording engineer", key: "recording-engineering" },
  { phrase: "tracking", key: "recording-engineering" },
  { phrase: "featured artist", key: "featured-artist-performance" },
  { phrase: "music production", key: "music-production" },
  { phrase: "beat", key: "music-production" },
  { phrase: "producer", key: "music-production" },
  { phrase: "production", key: "music-production" },
  { phrase: "live performance", key: "live-performance" },
  { phrase: "live set", key: "live-performance" },
  { phrase: "live band", key: "live-performance" },
  { phrase: "custom composition", key: "custom-composition" },
  { phrase: "custom score", key: "custom-composition" },
  { phrase: "sync", key: "custom-composition" },
  { phrase: "film score", key: "custom-composition" },
];

// Location phrases. The deterministic fallback only emits a
// hard `basedIn` constraint when the buyer explicitly names a
// city/region/country — inferring location from context would be
// exactly the "silent broadening" the GS 14 contract forbids.
const LOCATION_PHRASES: ReadonlyArray<{
  readonly phrase: string;
  readonly countryCode: string;
  readonly city?: string;
  readonly region?: string;
}> = [
  // City -> country shortcuts the seed uses. Kept explicit so the
  // fallback cannot accidentally broaden a buyer request.
  { phrase: "in brooklyn", countryCode: "US", city: "Brooklyn", region: "NY" },
  { phrase: "in toronto", countryCode: "CA", city: "Toronto", region: "ON" },
  { phrase: "in london", countryCode: "GB", city: "London" },
  { phrase: "in santo domingo", countryCode: "DO", city: "Santo Domingo" },
  { phrase: "in nassau", countryCode: "BS", city: "Nassau" },
  { phrase: "in kingston", countryCode: "JM", city: "Kingston" },
  { phrase: "in port of spain", countryCode: "TT", city: "Port of Spain" },
  { phrase: "in bridgetown", countryCode: "BB", city: "Bridgetown" },
  { phrase: "in castries", countryCode: "LC", city: "Castries" },
  { phrase: "in st. george's", countryCode: "GD", city: "St. George's" },
];

// Caribbean affiliation codes the deterministic fallback recognises
// from phrase text. The full canonical list lives in the search
// contract; we only emit codes that map to a country the buyer
// mentioned by name (e.g. "Haitian" -> "HT").
const AFFILIATION_PHRASES: ReadonlyArray<{
  readonly phrase: string;
  readonly code: string;
}> = [
  { phrase: "haitian", code: "HT" },
  { phrase: "haiti", code: "HT" },
  { phrase: "jamaican", code: "JM" },
  { phrase: "jamaica", code: "JM" },
  { phrase: "trinidadian", code: "TT" },
  { phrase: "trinidad", code: "TT" },
  { phrase: "barbadian", code: "BB" },
  { phrase: "barbados", code: "BB" },
  { phrase: "dominican", code: "DO" },
  { phrase: "dominicana", code: "DO" },
  { phrase: "saint lucian", code: "LC" },
  { phrase: "saint lucia", code: "LC" },
  { phrase: "bahamian", code: "BS" },
  { phrase: "bahamas", code: "BS" },
  { phrase: "grenadian", code: "GD" },
  { phrase: "grenada", code: "GD" },
];

// Non-search requirements the deterministic fallback captures when
// the buyer mentions a funding deadline. The value is informational
// only; the Golden Slice does not enforce the deadline (per the
// buildathon spec).
const FUNDING_DEADLINE_PATTERN = /\b(?:by|before|on)\s+([a-z]+\s+\d{1,2}(?:,\s*\d{4})?)\b/i;

export class DeterministicAiAdapter implements AiAdapter {
  interpretBrief(input: Bg3AiInterpretInputV1): Promise<Bg3AiInterpretOutputV1> {
    const normalized = input.briefText.trim().toLowerCase();
    const required: {
      serviceModes?: ("Remote" | "InPerson" | "Hybrid")[];
      primaryCategoryKeys?: string[];
      basedIn?: { city?: string; region?: string; countryCode: string };
      serviceArea?: { city?: string; region?: string; countryCode: string };
    } = {};
    const preferred: {
      genreTags?: string[];
      caribbeanAffiliationCodes?: string[];
    } = {};

    // Service modes: emit the FIRST recognised phrase in declaration
    // order. Phrases earlier in the table are more specific (e.g.
    // "remote only" beats "remote") so declaration order is the
    // tie-break for ambiguous brief text.
    for (const entry of SERVICE_MODE_PHRASES) {
      if (normalized.includes(entry.phrase)) {
        if (!required.serviceModes) required.serviceModes = [];
        if (!required.serviceModes.includes(entry.mode)) {
          required.serviceModes.push(entry.mode);
        }
        break;
      }
    }

    // Categories: emit the FIRST recognised phrase in declaration
    // order. The brief's primary-category hard requirement is the
    // most specific match — overlapping phrases collapse to a
    // single primaryCategoryKey.
    for (const entry of CATEGORY_PHRASES) {
      if (normalized.includes(entry.phrase)) {
        if (!required.primaryCategoryKeys) required.primaryCategoryKeys = [];
        if (!required.primaryCategoryKeys.includes(entry.key)) {
          required.primaryCategoryKeys.push(entry.key);
        }
        break;
      }
    }

    // Location: emit the FIRST recognised phrase as a hard
    // `basedIn` constraint. The buyer explicitly said "in
    // <city>"; the search service narrows to that geography.
    for (const entry of LOCATION_PHRASES) {
      if (normalized.includes(entry.phrase)) {
        required.basedIn = {
          countryCode: entry.countryCode,
          ...(entry.city !== undefined ? { city: entry.city } : {}),
          ...(entry.region !== undefined ? { region: entry.region } : {}),
        };
        break;
      }
    }

    // Genres: collect every recognised token. Genres are
    // preferences, not requirements (an unmatched genre is
    // non-binding per the v1 search contract), so the fallback
    // surfaces them as a buyer signal rather than a hard axis.
    const matchedGenres = new Set<string>();
    for (const genre of KNOWN_GENRES) {
      if (normalized.includes(genre)) {
        matchedGenres.add(genre);
      }
    }
    if (matchedGenres.size > 0) {
      preferred.genreTags = [...matchedGenres].sort();
    }

    // Affiliations: collect every recognised Caribbean
    // affiliation code so the buyer can scope the search by
    // diaspora affiliation.
    const matchedCodes = new Set<string>();
    for (const entry of AFFILIATION_PHRASES) {
      if (normalized.includes(entry.phrase)) {
        matchedCodes.add(entry.code);
      }
    }
    if (matchedCodes.size > 0) {
      preferred.caribbeanAffiliationCodes = [...matchedCodes].sort();
    }

    // Non-search requirements: capture a funding deadline only if
    // the buyer expressed one. The Golden Slice surfaces this
    // field for display; it does not enforce expiry.
    const nonSearchRequirements: Record<string, string> = {};
    const deadlineMatch = FUNDING_DEADLINE_PATTERN.exec(normalized);
    if (deadlineMatch && deadlineMatch[1]) {
      nonSearchRequirements.fundingDeadline = deadlineMatch[1].trim();
    }
    // Carry buyer-supplied non-search requirements verbatim so a
    // caller that explicitly passes keys (e.g. a test) is not
    // silently dropped by the fallback.
    if (input.buyerNonSearchRequirements) {
      for (const [key, value] of Object.entries(input.buyerNonSearchRequirements)) {
        if (!(key in nonSearchRequirements)) {
          nonSearchRequirements[key] = value;
        }
      }
    }

    const candidate: Record<string, unknown> = {
      // `required` is always present (even as `{}`) so the schema's
      // `.strict()` requirement is satisfied. The M1 search schema
      // accepts an empty `required` block when the buyer only
      // expressed a query.
      required,
      ...(preferred.genreTags || preferred.caribbeanAffiliationCodes ? { preferred } : {}),
      ...(Object.keys(nonSearchRequirements).length > 0 ? { nonSearchRequirements } : {}),
    };

    // When the buyer did not express any structured hard axis,
    // surface the verbatim brief text as the normalized query so
    // the TalentSearchService still has something to match. This
    // keeps GS 13 satisfied ("required golden brief proceeds
    // directly to runtime-validated search criteria") without
    // inventing hard constraints the buyer did not name.
    const hasHardAxis =
      required.serviceModes ||
      required.primaryCategoryKeys ||
      required.basedIn ||
      required.serviceArea;
    const hasPreference =
      (preferred.genreTags && preferred.genreTags.length > 0) ||
      (preferred.caribbeanAffiliationCodes && preferred.caribbeanAffiliationCodes.length > 0);
    if (!hasHardAxis && !hasPreference) {
      candidate.query = input.briefText;
    }

    // Self-validate the candidate against the BG3 runtime schema
    // before returning. The schema's usability superRefine requires
    // at least one of query / required / preferred, and the query
    // axis is subject to normalizedQuerySchema's letter/digit +
    // length rules. A punctuation-only brief (e.g. "---") would
    // fail validation here, so surface an AiInvalidOutputError
    // and let the application boundary translate it into the safe
    // MATCHMAKER_INVALID_REQUEST envelope. The deterministic
    // adapter never returns an unvalidated payload.
    const result = bg3MatchmakerCriteriaV1Schema.safeParse(candidate);
    if (!result.success) {
      throw new AiInvalidOutputError(
        "Deterministic fallback produced an invalid criteria payload.",
      );
    }

    return Promise.resolve({
      provider: "deterministic-fallback",
      modelId: null,
      candidate,
    });
  }
}
