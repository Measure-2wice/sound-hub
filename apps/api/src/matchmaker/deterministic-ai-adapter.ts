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
//     `matchmakerCriteriaV1Schema` so the application boundary
//     accepts it without falling back further.
//
// The adapter has no dependency on Prisma, on storage, or on the
// authentication boundary. It can be unit-tested in isolation.

import { matchmakerCriteriaV1Schema } from "@soundhub/types";
import type { AiInterpretBriefInputV1, AiInterpretBriefOutputV1 } from "@soundhub/types";
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
//
// Each canonical city carries every natural-language cue a buyer
// might use (`in <city>`, `<city>-based`, `based in <city>`, `from
// <city>`, `located in <city>`). The adapter picks the FIRST
// canonical phrase that matches the buyer's text in declaration
// order, and each city's phrases are listed longest-first so a
// multi-word location like `based in port of spain` is preferred
// over a shorter partial match.
//
// The fail-closed detector (see `detectUnsupportedLocation` below)
// scans buyer cues bounded at project-clause transitions so a
// supported trailing-clause phrasing (`based in Port of Spain for
// a remote single`) produces a canonical `basedIn` constraint
// instead of falsely rejecting the supported city.
const LOCATION_PHRASES: ReadonlyArray<{
  readonly phrase: string;
  readonly countryCode: string;
  readonly city?: string;
  readonly region?: string;
}> = [
  // Brooklyn (US / NY)
  { phrase: "based in brooklyn", countryCode: "US", city: "Brooklyn", region: "NY" },
  { phrase: "located in brooklyn", countryCode: "US", city: "Brooklyn", region: "NY" },
  { phrase: "from brooklyn", countryCode: "US", city: "Brooklyn", region: "NY" },
  { phrase: "in brooklyn", countryCode: "US", city: "Brooklyn", region: "NY" },
  { phrase: "brooklyn-based", countryCode: "US", city: "Brooklyn", region: "NY" },
  // Toronto (CA / ON)
  { phrase: "based in toronto", countryCode: "CA", city: "Toronto", region: "ON" },
  { phrase: "located in toronto", countryCode: "CA", city: "Toronto", region: "ON" },
  { phrase: "from toronto", countryCode: "CA", city: "Toronto", region: "ON" },
  { phrase: "in toronto", countryCode: "CA", city: "Toronto", region: "ON" },
  { phrase: "toronto-based", countryCode: "CA", city: "Toronto", region: "ON" },
  // London (GB)
  { phrase: "based in london", countryCode: "GB", city: "London" },
  { phrase: "located in london", countryCode: "GB", city: "London" },
  { phrase: "from london", countryCode: "GB", city: "London" },
  { phrase: "in london", countryCode: "GB", city: "London" },
  { phrase: "london-based", countryCode: "GB", city: "London" },
  // Santo Domingo (DO)
  { phrase: "based in santo domingo", countryCode: "DO", city: "Santo Domingo" },
  { phrase: "located in santo domingo", countryCode: "DO", city: "Santo Domingo" },
  { phrase: "from santo domingo", countryCode: "DO", city: "Santo Domingo" },
  { phrase: "in santo domingo", countryCode: "DO", city: "Santo Domingo" },
  { phrase: "santo domingo-based", countryCode: "DO", city: "Santo Domingo" },
  // Nassau (BS)
  { phrase: "based in nassau", countryCode: "BS", city: "Nassau" },
  { phrase: "located in nassau", countryCode: "BS", city: "Nassau" },
  { phrase: "from nassau", countryCode: "BS", city: "Nassau" },
  { phrase: "in nassau", countryCode: "BS", city: "Nassau" },
  { phrase: "nassau-based", countryCode: "BS", city: "Nassau" },
  // Kingston (JM)
  { phrase: "based in kingston", countryCode: "JM", city: "Kingston" },
  { phrase: "located in kingston", countryCode: "JM", city: "Kingston" },
  { phrase: "from kingston", countryCode: "JM", city: "Kingston" },
  { phrase: "in kingston", countryCode: "JM", city: "Kingston" },
  { phrase: "kingston-based", countryCode: "JM", city: "Kingston" },
  // Port of Spain (TT) — multi-word city.
  { phrase: "based in port of spain", countryCode: "TT", city: "Port of Spain" },
  { phrase: "located in port of spain", countryCode: "TT", city: "Port of Spain" },
  { phrase: "from port of spain", countryCode: "TT", city: "Port of Spain" },
  { phrase: "in port of spain", countryCode: "TT", city: "Port of Spain" },
  { phrase: "port of spain-based", countryCode: "TT", city: "Port of Spain" },
  // Bridgetown (BB)
  { phrase: "based in bridgetown", countryCode: "BB", city: "Bridgetown" },
  { phrase: "located in bridgetown", countryCode: "BB", city: "Bridgetown" },
  { phrase: "from bridgetown", countryCode: "BB", city: "Bridgetown" },
  { phrase: "in bridgetown", countryCode: "BB", city: "Bridgetown" },
  { phrase: "bridgetown-based", countryCode: "BB", city: "Bridgetown" },
  // Castries (LC)
  { phrase: "based in castries", countryCode: "LC", city: "Castries" },
  { phrase: "located in castries", countryCode: "LC", city: "Castries" },
  { phrase: "from castries", countryCode: "LC", city: "Castries" },
  { phrase: "in castries", countryCode: "LC", city: "Castries" },
  { phrase: "castries-based", countryCode: "LC", city: "Castries" },
  // St. George's (GD) — apostrophe-bearing city. The dot and
  // apostrophe are preserved verbatim so a buyer typing
  // "St. George's" matches the canonical phrase.
  { phrase: "based in st. george's", countryCode: "GD", city: "St. George's" },
  { phrase: "located in st. george's", countryCode: "GD", city: "St. George's" },
  { phrase: "from st. george's", countryCode: "GD", city: "St. George's" },
  { phrase: "in st. george's", countryCode: "GD", city: "St. George's" },
  { phrase: "st. george's-based", countryCode: "GD", city: "St. George's" },
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
  interpretBrief(input: AiInterpretBriefInputV1): Promise<AiInterpretBriefOutputV1> {
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

    // Location: the buyer explicitly named a location. GS 14
    // forbids silently dropping required constraints, so we MUST
    // detect the buyer's location cue and fail closed if the named
    // location is not in the canonical LOCATION_PHRASES list. The
    // detector returns the unmatched token; the adapter throws so
    // the application boundary surfaces MATCHMAKER_INVALID_REQUEST
    // rather than running a relaxed search.
    const unsupported = detectUnsupportedLocation(input.briefText);
    if (unsupported !== null) {
      throw new AiInvalidOutputError(
        `ProjectBrief location "${unsupported}" cannot be interpreted into a canonical SoundHub location. Rephrase the brief using a supported city (Brooklyn, Toronto, London, Santo Domingo, Nassau, Kingston, Port of Spain, Bridgetown, Castries, St. George's).`,
      );
    }
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
    const result = matchmakerCriteriaV1Schema.safeParse(candidate);
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

// ---------- Location fail-closed detection (GS 14) ----------
//
// When the buyer's natural-language brief expresses a required
// location (e.g. "based in Antarctica" or "<City>-based"), the
// deterministic adapter MUST resolve the named location to a
// canonical LOCATION_PHRASES entry. A buyer-explicit but
// unsupported location is a fail-closed signal: the adapter throws
// AiInvalidOutputError so the application boundary translates it
// into MATCHMAKER_INVALID_REQUEST (HTTP 400) instead of running a
// relaxed search.
//
// The detector recognises every buyer-natural location cue the
// canonical LOCATION_PHRASES table covers:
//   - "based in <Location>" (e.g. "based in Antarctica")
//   - "in <Location>" (e.g. "in Reykjavik")
//   - "located in <Location>" (e.g. "located in Reykjavik")
//   - "from <Location>" (e.g. "from Port of Spain")
//   - "<Location>-based" (e.g. "Brooklyn-based")
//
// The matchers are case-insensitive (`/i` flag) so a buyer typing
// `in antarctica` (lowercase) triggers the same fail-closed path as
// `in Antarctica`. The detector disambiguates geographic syntax
// from creative/technical phrasing by looking at the captured
// OBJECT after `in`, not at the preceding verb. A bounded allow-list
// (`CREATIVE_OBJECT_PHRASES` below) covers phrases the buyer
// unambiguously means as a non-geographic object — audio formats
// (`stereo`, `mono`, `dolby atmos`), languages (`english`,
// `spanish`), and DAW software (`pro tools`, `logic`, `ableton`).
// When the captured object is one of these, the detector treats it
// as a creative/technical phrase and does NOT fail closed. Any other
// `in <X>` is treated as a potential geographic cue: a canonical
// LOCATION_PHRASES entry is honoured, and anything else (e.g.
// `recording in Antarctica`, `in Atlantis`) fails closed.
//
// The disambiguation is anchored on the OBJECT, not the preceding
// verb, so a creative verb followed by an explicit place name
// (`recording in Antarctica`) still fails closed rather than
// silently dropping the geography.
//
// Captures are bounded at sentence punctuation AND at project-clause
// transitions (` for `, ` who `, ` and `, ` to `, ` with `, ` by `,
// ` on `) so a supported trailing-clause phrasing like "based in
// Port of Spain for a remote single" does not pick up the project
// clause as part of the location token. The lookahead also accepts
// common temporal adverbs ("next month", "this week", etc.) and
// end-of-string so brief phrasing like "in Antarctica next month"
// captures only "Antarctica".
//
// A word in the BOUNDARY_WORDS list is also excluded from the
// location-word non-capturing group via a negative lookahead, so
// the regex never consumes "for", "next", "month" etc. as part of a
// location token (which would otherwise let the capture balloon
// past a temporal phrase like "next month" because the case-
// insensitive `[A-Z][a-z]+` matches those lowercase words too).
const BOUNDARY_WORDS = [
  "for",
  "who",
  "and",
  "to",
  "with",
  "by",
  "on",
  "next",
  "this",
  "coming",
  "today",
  "tomorrow",
  "asap",
  "soon",
  "month",
  "week",
  "year",
  "day",
  "right",
  "now",
] as const;
const BOUNDARY_WORDS_SOURCE = BOUNDARY_WORDS.join("|");

const LOCATION_CLAUSE_BOUNDARY = new RegExp(`\\s+(?:${BOUNDARY_WORDS_SOURCE})\\b|[.,;]|$`, "i");

// A single location word. Case-insensitive (`/i` flag is set on
// every regex that uses this token) but explicitly NOT one of the
// project-clause / temporal boundary words above. The negative
// lookahead sits at the start of the word so the engine never
// begins matching a known boundary word.
//
// The first alternative `St\.(?=\s+[A-Z])` absorbs the canonical
// `St.` abbreviation when it is immediately followed by another
// proper noun (e.g. "St. George"). The lookahead is what makes
// this safe: a sentence-final period after "St" cannot be matched
// because the next non-whitespace character would not be a
// capitalised word. This preserves the canonical `St. George's`
// location (Grenada) so briefs like "in St. George's" honour the
// location rather than being rejected as unsupported.
const LOCATION_WORD = String.raw`(?!(?:${BOUNDARY_WORDS_SOURCE})\b)(?:St\.(?=\s+[A-Z])|[A-Z][a-z]+)`;

// A location-word possessive: a capitalised word followed by an
// apostrophe and a lowercase suffix (e.g. "George's"). Required
// for canonical names like "St. George's" where the trailing
// apostrophe-s must remain part of the captured token so the
// canonical-phrase matcher can identify it.
const POSSESSIVE_WORD = String.raw`[A-Z][a-z]+[''][a-z]+`;

// Bounded allow-list of `in <X>` objects that are unambiguously
// non-geographic. The list covers audio formats, languages, and DAW
// software — categories where the buyer is naming a creative or
// technical tool, not a place. Anything not in this list is
// considered a potential location cue: a canonical LOCATION_PHRASES
// entry is honoured, and anything else fails closed.
//
// The list is bounded and reviewed: any new entry must be a term
// whose every use after `in` is unambiguously non-geographic in the
// Caribbean music marketplace. Real place names — even ones that
// happen to coincide with a word in another language (e.g.
// "Sterling", "Hamilton") — are deliberately excluded so the
// detector fails closed on those.
const CREATIVE_OBJECT_PHRASES: ReadonlySet<string> = new Set([
  // Audio formats / recording environments.
  "stereo",
  "mono",
  "surround",
  "surround sound",
  "atmos",
  "dolby atmos",
  "dolby digital",
  "analog",
  "analogue",
  "digital",
  "studio",
  // Languages — used as `vocals in english`, `lyrics in spanish`.
  "english",
  "spanish",
  "french",
  "portuguese",
  "italian",
  "german",
  "japanese",
  "korean",
  "mandarin",
  "cantonese",
  "hindi",
  "arabic",
  "patois",
  "creole",
  "haitian creole",
  "jamaican patois",
  // DAW / production software.
  "pro tools",
  "protools",
  "logic",
  "logic pro",
  "ableton",
  "ableton live",
  "fl studio",
  "reason",
  "cubase",
  "garageband",
  "reaper",
  // File formats / generic production nouns.
  "wav",
  "mp3",
  "aiff",
  "flac",
]);

function detectUnsupportedLocation(original: string): string | null {
  // "based in <Location>" / "located in <Location>" — non-greedy
  // capture bounded by sentence punctuation, end-of-string, a
  // project-clause transition, or a common temporal adverb. The
  // location must be at least 2 characters to avoid false positives
  // on tiny tokens. Case-insensitive so lowercase phrasing
  // ("based in antarctica") triggers the same fail-closed path.
  const basedInMatch = new RegExp(
    `\\b(?:based|located)\\s+in\\s+(${LOCATION_WORD}(?:\\s+(?:of|${LOCATION_WORD}|${POSSESSIVE_WORD}))*(?:\\s+(?:de|la|el|los|las|du|le|von|van|di|del))?)(?=${LOCATION_CLAUSE_BOUNDARY.source})`,
    "i",
  ).exec(original);
  if (basedInMatch) {
    const token = basedInMatch[1]!.trim();
    if (token.length >= 2 && !matchesKnownLocation(token)) {
      return token;
    }
  }
  // "in <Location>" — case-insensitive. The detector iterates every
  // occurrence (the `/g` flag) because a brief can mix a non-
  // geographic `in <X>` (`mixing in Dolby Atmos`) with a later
  // geographic cue (`producer in Antarctica`). Each captured object
  // is checked against `CREATIVE_OBJECT_PHRASES`; only objects in
  // that bounded allow-list are skipped. Any other object is treated
  // as a potential location cue: a canonical LOCATION_PHRASES entry
  // is honoured, and anything else fails closed.
  const inRegex = new RegExp(
    `\\bin\\s+(${LOCATION_WORD}(?:\\s+(?:of|${LOCATION_WORD}|${POSSESSIVE_WORD}))*(?:\\s+(?:de|la|el|los|las|du|le|von|van|di|del))?)(?=${LOCATION_CLAUSE_BOUNDARY.source})`,
    "gi",
  );
  let inMatch: RegExpExecArray | null;
  while ((inMatch = inRegex.exec(original)) !== null) {
    const token = inMatch[1]!.trim();
    if (CREATIVE_OBJECT_PHRASES.has(token.toLowerCase())) continue;
    if (token.length >= 2 && !matchesKnownLocation(token)) {
      return token;
    }
  }
  // "from <Location>" — case-insensitive.
  const fromRegex = new RegExp(
    `\\bfrom\\s+(${LOCATION_WORD}(?:\\s+(?:of|${LOCATION_WORD}|${POSSESSIVE_WORD}))*(?:\\s+(?:de|la|el|los|las|du|le|von|van|di|del))?)(?=${LOCATION_CLAUSE_BOUNDARY.source})`,
    "gi",
  );
  let fromMatch: RegExpExecArray | null;
  while ((fromMatch = fromRegex.exec(original)) !== null) {
    const token = fromMatch[1]!.trim();
    if (token.length >= 2 && !matchesKnownLocation(token)) {
      return token;
    }
  }

  // "<Location>-based" — case-insensitive. The Capitalised prefix
  // prevents "remote-based" or "music-based" from false-positive
  // triggering fail-closed; service-mode keywords are excluded by
  // `matchesKnownLocation`. Case-insensitive flag means
  // "reykjavik-based" (lowercase) reaches the same path as
  // "Reykjavik-based".
  const xBasedRegex = new RegExp(
    `\\b(${LOCATION_WORD}(?:\\s+(?:of|${LOCATION_WORD}|${POSSESSIVE_WORD}))*)-based\\b`,
    "gi",
  );
  let xBasedMatch: RegExpExecArray | null;
  while ((xBasedMatch = xBasedRegex.exec(original)) !== null) {
    const token = xBasedMatch[1]!.trim().replace(/[.,;]+$/, "");
    if (token.length >= 2 && !matchesKnownLocation(token)) {
      return token;
    }
  }

  return null;
}

function matchesKnownLocation(token: string): boolean {
  const lc = token.toLowerCase();
  // Buyers name the bare city ("Brooklyn"), not the canonical
  // phrase ("in brooklyn"). Match against the LOCATION_PHRASES
  // fields so a token equal to a canonical city/region/country
  // counts as known, regardless of whether the buyer said "in
  // brooklyn" or "Brooklyn-based". Apostrophe-bearing canonical
  // cities like "St. George's" are normalised by stripping the
  // apostrophe so the buyer-side token "St. George" matches.
  const lcNormalized = lc.replace(/[''`]/g, "");
  for (const entry of LOCATION_PHRASES) {
    if (entry.city !== undefined) {
      const cityLc = entry.city.toLowerCase();
      if (cityLc === lc || cityLc.replace(/[''`]/g, "") === lcNormalized) return true;
      if (lc.includes(cityLc)) return true;
    }
    if (entry.region !== undefined && entry.region.toLowerCase() === lc) {
      return true;
    }
    if (entry.countryCode.toLowerCase() === lc) return true;
  }
  // Service-mode keywords are not locations. Treating them as
  // fail-closed candidates would block legitimate briefs like
  // "remote-based producer".
  const SERVICE_MODE_KEYWORDS = ["remote", "hybrid", "in-person", "in person", "online", "offline"];
  return SERVICE_MODE_KEYWORDS.includes(lc);
}
