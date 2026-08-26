"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isRetriableErrorCode, useSearch } from "../hooks/useSearch";
import {
  getEmptySearchSubmissionMessage,
  hasUsableCriteria,
  type RequiredFiltersValue,
} from "../lib/talent-search-request-builder";
import { isControlledRequiredPath } from "../lib/field-error-paths";
import { Card } from "./ui/Card";
import { SearchForm } from "./SearchForm";
import { RequiredFilters } from "./RequiredFilters";
import { AudioSamplesPanel } from "./AudioSamplesPanel";
import { formatPricing } from "../lib/pricing";
import {
  categoryMetadataResponseV1Schema,
  type ApiFieldErrorV1,
  type CategoryMetadataItemV1,
  type TalentSearchResultV1,
} from "@soundhub/types";

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<RequiredFiltersValue>({
    primaryCategoryKey: "",
    independentlyPurchasableServiceKey: "",
    serviceModes: [],
    basedIn: { city: "", region: "", countryCode: "" },
    serviceArea: { city: "", region: "", countryCode: "" },
  });
  const { results, isLoading, error, errorCode, fieldErrors, requestId, search, retry } =
    useSearch();

  // Buyer-facing empty-submission guard. Set when the buyer submits
  // a (query, filters) tuple that has no usable criteria; cleared on
  // the next submission that does have usable criteria. The hook's
  // dispatch is skipped while this is set so no API request is made
  // for an empty submission (QA finding — the developer-centric
  // "Request body failed schema validation." envelope used to
  // surface here). Server-side schema validation, the safe-envelope
  // mapping, and the form's entered values are all preserved; this
  // state only controls the page-level guard and a single inline
  // guidance card.
  const [emptySearchMessage, setEmptySearchMessage] = useState<string | null>(null);

  // Canonical categories are fetched from the public metadata seam
  // (`GET /api/metadata/categories`) so the browser never holds a
  // second, independently deployable list of category keys. The
  // browser consumes the rendered list; PostgreSQL (via the API) is
  // the only source of truth.
  const [categories, setCategories] = useState<readonly CategoryMetadataItemV1[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/metadata/categories", {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(`Metadata request failed (${response.status}).`);
        }
        const body: unknown = await response.json();
        // Runtime validation against the shared Zod schema. The
        // browser MUST NOT trust a handwritten DTO cast; any
        // contract drift between PostgreSQL and the browser
        // surfaces here as a rejected categories load instead of
        // a silently populated select.
        const parsed = categoryMetadataResponseV1Schema.safeParse(body);
        if (!parsed.success) {
          throw new Error("Metadata response does not match the shared category schema.");
        }
        if (cancelled) return;
        // Reuse the shared inferred type directly; the API contract
        // and the UI model are intentionally the same shape so there
        // is no field-by-field remapping here (Codex P2-001).
        setCategories(parsed.data.categories);
        setCategoriesError(null);
      } catch (err) {
        if (cancelled) return;
        setCategoriesError(
          err instanceof Error ? err.message : "Could not load the canonical category catalog.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Page-level empty-submission guard. The pure helper returns
    // `{ message }` when the (query, filters) tuple has no usable
    // criteria and `null` otherwise. While `blocked`, the hook's
    // dispatch is skipped so no API request is made and the
    // form's entered values are preserved untouched. The shared
    // Zod schema's server-side validation, the safe envelope
    // mapping, and every other code path are unaffected because
    // this branch only fires for tuples the API would reject.
    const guard = getEmptySearchSubmissionMessage(query, filters);
    if (guard !== null) {
      setEmptySearchMessage(guard.message);
      return;
    }
    setEmptySearchMessage(null);
    void search(query, filters);
  };

  // Errors whose path the `RequiredFilters` panel does not render
  // are shown in the global panel. The full `fieldErrors` array is
  // already passed down to the panel, so the global list shows ONLY
  // the unmatched entries — controlled errors render exactly once,
  // beside their control.
  const unmatchedFieldErrors = useMemo<readonly ApiFieldErrorV1[]>(
    () => fieldErrors.filter((err) => !isControlledRequiredPath(err.path)),
    [fieldErrors],
  );

  // The empty state renders whenever the most recent completed search
  // returned no results. The buyer's request is meaningful if it has
  // either a usable query OR a usable structured filter, so both
  // paths qualify the page to show actionable feedback rather than
  // letting a no-result response read as a system error.
  const usable = hasUsableCriteria(query, filters);
  const showEmptyState = !isLoading && results !== null && results.results.length === 0 && usable;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <header className="text-center mb-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">Find Caribbean talent</h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          Search for sellers offering production, songwriting, performance, and more.
        </p>
      </header>

      <Card className="mb-8">
        <Card.Content>
          <form onSubmit={handleSubmit} className="space-y-6" data-testid="search-form">
            <SearchForm query={query} setQuery={setQuery} loading={isLoading} />
            <RequiredFilters
              value={filters}
              onChange={setFilters}
              fieldErrors={fieldErrors}
              categories={categories}
              // The whole panel only disables during an in-flight search.
              // The category catalog only blocks the two category selects
              // — service mode, based-in, and service-area controls do
              // not depend on category metadata and stay usable so the
              // buyer can still apply those strict constraints even when
              // the catalog is loading, unavailable, or validly empty.
              disabled={isLoading}
              categorySelectsDisabled={categories.length === 0}
            />
            <button
              type="submit"
              disabled={isLoading}
              data-testid="search-submit"
              className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? "Searching…" : "Search talent"}
            </button>
          </form>
        </Card.Content>
      </Card>

      <EmptySearchGuidance message={emptySearchMessage} />

      {categoriesError && (
        <Card
          variant="outlined"
          className="mb-6 border-amber-200 bg-amber-50"
          data-testid="catalog-error"
        >
          <Card.Content>
            <p className="text-amber-800" data-testid="catalog-error-message">
              The canonical category catalog is unavailable. {categoriesError}
            </p>
            <p className="mt-2 text-sm text-amber-700">
              Category selects are disabled until the catalog loads. Service mode, based-in, and
              service-area controls remain usable. Retry by refreshing the page.
            </p>
          </Card.Content>
        </Card>
      )}

      {error && (
        <Card
          variant="outlined"
          className="mb-6 border-red-200 bg-red-50"
          data-testid="search-error"
        >
          <Card.Content>
            <p className="text-red-800" data-testid="search-error-message">
              {error}
            </p>
            {errorCode === "SEARCH_UNAVAILABLE" && (
              <p className="mt-2 text-sm text-red-700">
                The brief is preserved. You can retry without retyping it.
              </p>
            )}
            {isRetriableErrorCode(errorCode) && !isLoading && (
              <button
                type="button"
                onClick={() => {
                  void retry();
                }}
                data-testid="search-retry"
                className="mt-3 inline-flex items-center gap-1 bg-red-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors"
              >
                Retry search
              </button>
            )}
            {unmatchedFieldErrors.length > 0 && (
              <ul className="mt-3 space-y-1" data-testid="search-error-fields">
                {unmatchedFieldErrors.map((err) => (
                  <li key={`${err.path}-${err.code}`} className="text-sm text-red-700">
                    <span className="font-mono text-xs mr-1">{err.path}</span>
                    {err.message}
                  </li>
                ))}
              </ul>
            )}
            {requestId && (
              <p className="mt-2 text-xs text-red-600" data-testid="search-error-request-id">
                Request ID: {requestId}
              </p>
            )}
          </Card.Content>
        </Card>
      )}

      {isLoading && (
        <div className="text-center py-12" data-testid="search-loading" aria-live="polite">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="mt-4 text-gray-600">Searching talent…</p>
        </div>
      )}

      {showEmptyState && (
        <Card className="text-center py-12" data-testid="search-empty">
          <Card.Content>
            <p className="text-gray-600">
              No matching talent yet. Try a different description or remove optional filters.
            </p>
          </Card.Content>
        </Card>
      )}

      {results && results.results.length > 0 && (
        <section data-testid="search-results" aria-label="Search results">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">
            {results.results.length} matching seller{results.results.length === 1 ? "" : "s"}
          </h2>
          <div className="grid gap-6 md:grid-cols-2">
            {results.results.map((result) => (
              <ResultCard key={result.seller.sellerId} result={result} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ResultCard is the presentational subcomponent that renders one search
// result. It is exported (further down, after its declaration) so unit
// tests can render it in isolation against a controlled sample
// `TalentSearchResultV1` and assert on rendered HTML without spinning up
// the parent `SearchPage` (which owns the fetch/state lifecycle).
function ResultCardImpl({ result }: { result: TalentSearchResultV1 }) {
  const {
    seller,
    bestMatchingOffering,
    additionalMatchingOfferings,
    matchReason,
    preferenceCoverage,
    textCoverage,
  } = result;

  return (
    <Card
      variant="elevated"
      className="hover:shadow-xl transition-shadow"
      data-testid="result-card"
    >
      <Card.Header>
        {/* `avatarUrl` is an approved optional field of the public seller
            contract, so it is part of the seller's public professional
            identity. It is rendered only when present, carries the
            professional name as its accessible label, and exposes no
            account, membership, or storage internals. */}
        <div className="flex items-center gap-3">
          {seller.avatarUrl && (
            /* eslint-disable-next-line @next/next/no-img-element -- the
               contract returns an arbitrary approved absolute URL, which the
               Next image loader would require host allow-listing for. */
            <img
              src={seller.avatarUrl}
              alt={`${seller.professionalName} profile image`}
              className="h-12 w-12 rounded-full object-cover bg-gray-100"
              width={48}
              height={48}
              loading="lazy"
              referrerPolicy="no-referrer"
              data-testid="result-seller-avatar"
            />
          )}
          <Card.Title data-testid="result-seller-name">{seller.professionalName}</Card.Title>
        </div>

        {seller.specialties.length > 0 && (
          <div className="mt-2" data-testid="result-specialties">
            <span className="text-xs font-medium text-gray-500">Specialties</span>
            <div className="flex flex-wrap gap-2 mt-1">
              {seller.specialties.map((specialty) => (
                <span
                  key={specialty}
                  className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full"
                >
                  {formatSpecialty(specialty)}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card.Header>
      <Card.Content>
        <p className="text-gray-600 text-sm mb-3">{seller.bio}</p>

        {/* Current location, Caribbean affiliation, and service area are
            distinct concepts and are labeled separately so a seller's
            residence is never read as their regional connection. */}
        <dl className="text-xs text-gray-600 mb-3 space-y-1">
          <div>
            <dt className="inline font-medium text-gray-500">Based in: </dt>
            <dd className="inline" data-testid="result-based-in">
              {formatLocation(seller.basedIn)}
            </dd>
          </div>
          {seller.caribbeanAffiliationCodes.length > 0 && (
            <div>
              <dt className="inline font-medium text-gray-500">Caribbean affiliation: </dt>
              <dd className="inline" data-testid="result-affiliations">
                {seller.caribbeanAffiliationCodes.join(", ")}
              </dd>
            </div>
          )}
        </dl>

        {/* Best matching offering. Each result leads with the seller's
            highest-eligible standalone offering — the one the buyer can
            commission right now. Bundle-only IncludedServices ride along
            below labeled as bundle-only (see ADR 0002 and CONTEXT.md). */}
        <BestOfferingCard offering={bestMatchingOffering} testIdPrefix="result-offering" />

        {additionalMatchingOfferings.length > 0 && (
          <div className="mt-3" data-testid="result-additional-offerings">
            <p className="text-xs font-medium text-gray-500 mb-1">
              Also available from this seller
            </p>
            <ul className="space-y-2">
              {additionalMatchingOfferings.map((offering) => (
                <li
                  key={offering.offeringId}
                  className="border-l-2 border-blue-200 pl-3"
                  data-testid="result-additional-offering"
                  data-offering-id={offering.offeringId}
                >
                  <OfferingDetail
                    offering={offering}
                    testIdPrefix="result-additional-offering"
                    variant="additional"
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Buyer-facing match evidence. The matchReason is the
            deterministic factual reason produced by the search service;
            it names only the fields that actually matched (offering
            title, category, preferred genre, etc.). relevanceScore is a
            bounded strategy-specific ordering signal and is not
            surfaced to the buyer — the contract prohibits rendering it
            as a percentage, and P1-003 prohibits deriving any
            qualitative strength or confidence band from it. */}
        <div className="bg-blue-50 p-3 rounded-lg mt-3" data-testid="result-match-reason">
          <p className="text-sm font-medium text-blue-900 mb-1">Why this matches</p>
          <p className="text-sm text-blue-800">{matchReason}</p>
        </div>

        {/* Qualitative fit: factual coverage statements derived from the
            deterministic matched/total counts the search service
            produces. Three independent sources can be present:
              - `preferenceCoverage` from canonical preference atoms.
              - `textCoverage` from the buyer's normalized query tokens.
              - The required-only fallback: when both coverage fields
                are absent, the request had no usable query AND no
                canonical preferences, so the service emitted the bare
                eligibility matchReason without either coverage line.
                The result itself is the factual evidence — its
                presence in the result set means it satisfied every
                requested required criterion — so a separate
                qualitative-fit block is rendered from existing result
                facts (matchReason + the absence of coverage fields).
                Deterministic, non-percentage, never derived from
                `relevanceScore`. Issue #6 requires both deterministic
                evidence AND qualitative fit; the P1-001 review found
                qualitative fit had been dropped on query-only and
                again on required-only searches, so the renderer now
                always surfaces a qualitative-fit block on a result
                that returned usable criteria. Optional coverage fields
                in the public DTO per the v1 contract (P1-002). */}
        {preferenceCoverage && (
          <div className="bg-blue-50 p-3 rounded-lg mt-2" data-testid="result-qualitative-fit">
            <p className="text-sm font-medium text-blue-900 mb-1">Preference coverage</p>
            <p className="text-sm text-blue-800" data-testid="result-qualitative-fit-text">
              {formatPreferenceCoverage(preferenceCoverage)}
            </p>
          </div>
        )}
        {textCoverage && (
          <div className="bg-blue-50 p-3 rounded-lg mt-2" data-testid="result-qualitative-fit">
            <p className="text-sm font-medium text-blue-900 mb-1">Brief coverage</p>
            <p className="text-sm text-blue-800" data-testid="result-qualitative-fit-text">
              {formatTextCoverage(textCoverage)}
            </p>
          </div>
        )}
        {!preferenceCoverage && !textCoverage && (
          <div className="bg-blue-50 p-3 rounded-lg mt-2" data-testid="result-qualitative-fit">
            <p className="text-sm font-medium text-blue-900 mb-1">Eligibility</p>
            <p className="text-sm text-blue-800" data-testid="result-qualitative-fit-text">
              {formatRequiredOnlyFit(matchReason)}
            </p>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

// Public re-export so unit tests can render the presentational result
// card in isolation against a controlled sample `TalentSearchResultV1`
// without spinning up the parent `SearchPage` (which owns the fetch/state
// lifecycle). The export deliberately sits at module scope rather than on
// the function declaration so the React component name in devtools and
// the function name used by `react-dom/server` both stay `ResultCardImpl`.
export const ResultCard = ResultCardImpl;

// Empty-submission guidance. Renders the buyer-friendly message when
// the page-level guard has flagged an empty (no-usable-criteria)
// submission so the developer-centric API envelope
// (`<root> at least one of query, required, or preferred must contain
// criteria`) used to surface. Renders nothing on a null message so
// the form's standard path can render without an extra wrapper.
//
// Exported (with the implementation kept private as `EmptySearchGuidanceImpl`)
// so tests can render it in isolation against a controlled message
// string without spinning up the parent `SearchPage` (which owns the
// fetch/state lifecycle and uses effects that have no role in the
// pure render path).
function EmptySearchGuidanceImpl({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <Card
      variant="outlined"
      className="mb-6 border-amber-200 bg-amber-50"
      data-testid="empty-search-guidance"
      role="status"
      aria-live="polite"
    >
      <Card.Content>
        <p className="text-amber-800" data-testid="empty-search-guidance-message">
          {message}
        </p>
      </Card.Content>
    </Card>
  );
}

export const EmptySearchGuidance = EmptySearchGuidanceImpl;

// OfferingDetail: the shared markup that the best and additional
// offering paths both render — title, description, service category,
// service mode, and bundle-includes (when present). Extracted so the
// two paths render the same row markup with the same data-testid
// conventions instead of duplicating five lines of JSX (P2-002
// remediation). Lead-only content (service areas, genres, pricing, and
// the pricing disclaimer) stays on BestOfferingCard because additional
// offerings are intentionally compact. Kept private (no `export`) so the
// implementation helper does not leak to external consumers until one
// exists (P2-001 remediation).
//
// Presentation style is selected via `variant` so the four CSS class
// strings travel as one cohesive style record owned by this component
// instead of being passed as a data clump from every call site (P2-001
// remediation).
type OfferingDetailVariant = "lead" | "additional";

const OFFERING_DETAIL_STYLES: Record<
  OfferingDetailVariant,
  {
    readonly title: string;
    readonly description: string;
    readonly dl: string;
    readonly bundle: string;
  }
> = {
  lead: {
    title: "text-sm font-medium text-gray-900",
    description: "text-xs text-gray-600 mt-1",
    dl: "text-xs text-gray-700 mt-2 space-y-1",
    bundle: "text-xs text-gray-700 mt-2",
  },
  additional: {
    title: "text-sm font-medium text-gray-800",
    description: "text-xs text-gray-600 mt-0.5",
    dl: "text-xs text-gray-700 mt-1 space-y-0.5",
    bundle: "text-xs text-gray-700 mt-1",
  },
};

function OfferingDetail({
  offering,
  testIdPrefix,
  variant,
}: {
  readonly offering: TalentSearchResultV1["bestMatchingOffering"];
  readonly testIdPrefix: string;
  readonly variant: OfferingDetailVariant;
}) {
  const styles = OFFERING_DETAIL_STYLES[variant];
  return (
    <>
      <p className={styles.title} data-testid={`${testIdPrefix}-title`}>
        {offering.title}
      </p>
      <p className={styles.description}>{offering.description}</p>
      <dl className={styles.dl}>
        <div>
          <dt className="inline font-medium text-gray-500">Service category: </dt>
          <dd className="inline" data-testid={`${testIdPrefix}-category`}>
            {offering.primaryCategory.name}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-gray-500">Service mode: </dt>
          <dd className="inline" data-testid={`${testIdPrefix}-service-mode`}>
            {formatServiceMode(offering.serviceMode)}
          </dd>
        </div>
      </dl>
      {offering.includedServices.length > 0 && (
        <p className={styles.bundle} data-testid={`${testIdPrefix}-included-services`}>
          <span className="font-medium text-gray-500">Bundle includes: </span>
          {offering.includedServices.map((included) => `${included.name} (bundle only)`).join(", ")}
        </p>
      )}
    </>
  );
}

// BestOfferingCard: the lead offering for a result. Uses OfferingDetail
// for the row markup shared with additional offerings and adds the
// lead-only service areas, genres, pricing, and pricing disclaimer
// below it.
function BestOfferingCard({
  offering,
  testIdPrefix,
}: {
  readonly offering: TalentSearchResultV1["bestMatchingOffering"];
  readonly testIdPrefix: string;
}) {
  const pricingLabel = formatPricing(offering.pricing);
  return (
    <div className="bg-gray-50 p-3 rounded-lg mb-3" data-testid={`${testIdPrefix}-card`}>
      <OfferingDetail offering={offering} testIdPrefix={testIdPrefix} variant="lead" />

      <dl className="text-xs text-gray-700 mt-2 space-y-1">
        {offering.serviceAreas.length > 0 && (
          <div>
            <dt className="inline font-medium text-gray-500">Service area: </dt>
            <dd className="inline" data-testid={`${testIdPrefix}-service-areas`}>
              {offering.serviceAreas.map(formatLocation).join(" · ")}
            </dd>
          </div>
        )}
        {offering.genreTags.length > 0 && (
          <div>
            <dt className="inline font-medium text-gray-500">Genres: </dt>
            <dd className="inline" data-testid={`${testIdPrefix}-genres`}>
              {offering.genreTags.join(", ")}
            </dd>
          </div>
        )}
        <div>
          <dt className="inline font-medium text-gray-500">Pricing: </dt>
          <dd className="inline" data-testid={`${testIdPrefix}-pricing`}>
            {pricingLabel ?? "Not advertised"}
          </dd>
        </div>
      </dl>

      {/* Pricing is non-binding until it is incorporated into an approved
          TermsVersion (ADR 0002, CONTEXT.md). Buyer-facing wording names
          that approved-terms boundary rather than a weaker informal
          milestone such as "agreed terms", which could imply an informal
          agreement is sufficient to bind either party. The disclaimer is
          always shown so no pricing presentation reads as a quote or
          commitment, but its wording follows the state: disclaiming
          "advertised pricing" on an offering that advertises none would
          imply a price is present. */}
      <p
        className="text-xs text-gray-500 mt-2 italic"
        data-testid={`${testIdPrefix}-pricing-disclaimer`}
      >
        {pricingLabel === null
          ? "This seller has not advertised pricing. Any pricing discussed later is non-binding until it is incorporated into approved terms."
          : "Advertised pricing is non-binding and not a quote. It binds no one until it is incorporated into approved terms."}
      </p>

      {/* Buyer-discovery audio playback (ticket #61 follow-up P1-002).
          Loads samples for this offering from the public endpoint and
          renders a bounded set of audio players. Removed or
          ineligible samples never appear because the application
          re-runs eligibility checks on every playback request. */}
      <AudioSamplesPanel offeringId={offering.offeringId} offeringTitle={offering.title} />
    </div>
  );
}

// Factual preference coverage statement. Counts only — never a percentage,
// never derived from `relevanceScore`. The contract guarantees this helper
// is only called when the buyer supplied at least one canonical preference
// atom; the no-preferences case is rendered by simply skipping this line
// (P1-001). The textCoverage line is rendered independently when the buyer
// supplied a usable query.
function formatPreferenceCoverage(coverage: {
  readonly matched: number;
  readonly total: number;
}): string {
  if (coverage.matched === coverage.total) {
    return `Matches all ${coverage.total} requested preference${coverage.total === 1 ? "" : "s"}.`;
  }
  const unmet = coverage.total - coverage.matched;
  return `Matches ${coverage.matched} of ${coverage.total} requested preferences; ${unmet} not matched.`;
}

// Factual query-token coverage statement. Counts only — never a percentage,
// never derived from `relevanceScore`. The contract guarantees this helper
// is only called when the buyer supplied at least one canonical query
// token; the no-query case is rendered by simply skipping this line.
function formatTextCoverage(coverage: {
  readonly matched: number;
  readonly total: number;
}): string {
  if (coverage.matched === coverage.total) {
    return `Matches all ${coverage.total} word${coverage.total === 1 ? "" : "s"} of your brief.`;
  }
  const unmet = coverage.total - coverage.matched;
  return `Matches ${coverage.matched} of ${coverage.total} words from your brief; ${unmet} not matched.`;
}

// Deterministic, non-percentage qualitative-fit fallback for required-only
// results. The service emits this branch whenever the request had no usable
// query AND no canonical preference atoms, in which case both coverage
// fields are omitted from the public DTO and `matchReason` falls back to
// the deterministic service-side wording for an eligibility-only match.
// Issue #6 requires the buyer UI to show both deterministic evidence
// (`matchReason`) AND qualitative fit; this helper derives the
// qualitative-fit line from the existing `matchReason` fact so no new
// public DTO field is introduced. Mode-neutral wording ("Eligible for this
// search.") because absence of the optional coverage fields does not by
// itself prove the request was structured-only — `preferenceCoverage` and
// `textCoverage` are optional in the public DTO for backward compatibility
// and may be omitted on query- or preference-bearing searches from
// in-flight clients. Counts-only wording, never a percentage, never
// derived from `relevanceScore`.
function formatRequiredOnlyFit(matchReason: string): string {
  const trimmed = matchReason.trim();
  if (trimmed.length === 0) {
    return "Eligible for this search.";
  }
  return `Eligible for this search (${trimmed}).`;
}

// Renders "City, Region · CC" while tolerating the optional city/region fields.
function formatLocation(location: { city?: string; region?: string; countryCode: string }): string {
  const locality = [location.city, location.region].filter(Boolean).join(", ");
  return locality ? `${locality} · ${location.countryCode}` : location.countryCode;
}

// Specialty keys are stable controlled records (for example `SoundEngineer`).
// Presentation-only humanization; the contract value is unchanged.
function formatSpecialty(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function formatServiceMode(mode: TalentSearchResultV1["bestMatchingOffering"]["serviceMode"]) {
  if (mode === "InPerson") return "In person";
  return mode;
}
