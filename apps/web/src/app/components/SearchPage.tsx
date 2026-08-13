"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useSearch } from "../hooks/useSearch";
import { Card } from "./ui/Card";
import { SearchForm } from "./SearchForm";
import { RequiredFilters, type CategoryOption, type RequiredFiltersValue } from "./RequiredFilters";
import { formatPricing } from "../lib/pricing";
import type { ApiFieldErrorV1, TalentSearchResultV1 } from "@soundhub/types";

// Canonical list of service categories rendered in the structured filter
// dropdown. The category names mirror the canonical names seeded in
// PostgreSQL (the API is the source of truth for category existence).
// Future tickets may resolve these from a metadata endpoint; for M1.4
// the canonical 10 categories are the only ones the buyer can require.
const CANONICAL_CATEGORIES: readonly CategoryOption[] = [
  { key: "music-production", name: "Music Production" },
  { key: "songwriting", name: "Songwriting" },
  { key: "custom-composition", name: "Custom Composition" },
  { key: "session-vocals", name: "Session Vocals" },
  { key: "session-instrument-performance", name: "Session Instrument Performance" },
  { key: "featured-artist-performance", name: "Featured Artist Performance" },
  { key: "mixing", name: "Mixing" },
  { key: "mastering", name: "Mastering" },
  { key: "recording-engineering", name: "Recording Engineering" },
  { key: "live-performance", name: "Live Performance" },
];

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<RequiredFiltersValue>({
    primaryCategoryKey: "",
    customPrimaryCategoryKey: "",
    independentlyPurchasableServiceKey: "",
    serviceModes: [],
    basedInCountryCode: "",
    serviceAreaCountryCode: "",
  });
  const { results, isLoading, error, errorCode, fieldErrors, requestId, search } = useSearch();

  // Field errors whose path is not rendered inside the RequiredFilters
  // panel (e.g. errors targeting `query` or `preferred.*`) are
  // forwarded here by the panel via `onUnmatchedErrors`. We render
  // them in the global error panel so the buyer always sees actionable
  // feedback for any rejection, even when the path is outside the
  // structured filters.
  const [unmatchedFieldErrors, setUnmatchedFieldErrors] = useState<readonly ApiFieldErrorV1[]>([]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void search(query, filters);
  };

  // Effective field errors: those returned by the API plus those
  // emitted by the filter panel for paths it does not render.
  const visibleFieldErrors = useMemo(() => {
    return [...fieldErrors, ...unmatchedFieldErrors];
  }, [fieldErrors, unmatchedFieldErrors]);

  // The empty state renders whenever the most recent completed search
  // returned no results. The buyer's request is meaningful if it has
  // either a usable query OR a usable structured filter, so both
  // paths qualify the page to show actionable feedback rather than
  // letting a no-result response read as a system error.
  const hasUsableCriteria =
    query.trim().length >= 2 ||
    filters.primaryCategoryKey.length > 0 ||
    filters.customPrimaryCategoryKey.length > 0 ||
    filters.independentlyPurchasableServiceKey.length > 0 ||
    filters.serviceModes.length > 0 ||
    filters.basedInCountryCode.trim().length > 0 ||
    filters.serviceAreaCountryCode.trim().length > 0;
  const showEmptyState =
    !isLoading && results !== null && results.results.length === 0 && hasUsableCriteria;

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
              onUnmatchedErrors={setUnmatchedFieldErrors}
              categories={CANONICAL_CATEGORIES}
              disabled={isLoading}
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
            {visibleFieldErrors.length > 0 && (
              <ul className="mt-3 space-y-1" data-testid="search-error-fields">
                {visibleFieldErrors.map((err) => (
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

function ResultCard({ result }: { result: TalentSearchResultV1 }) {
  const { seller, bestMatchingOffering, matchReason } = result;
  const pricingLabel = formatPricing(bestMatchingOffering.pricing);

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

        <div className="bg-gray-50 p-3 rounded-lg mb-3">
          <p className="text-sm font-medium text-gray-900" data-testid="result-offering-title">
            {bestMatchingOffering.title}
          </p>
          <p className="text-xs text-gray-600 mt-1">{bestMatchingOffering.description}</p>

          <dl className="text-xs text-gray-700 mt-2 space-y-1">
            <div>
              <dt className="inline font-medium text-gray-500">Service category: </dt>
              <dd className="inline" data-testid="result-category">
                {bestMatchingOffering.primaryCategory.name}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium text-gray-500">Service mode: </dt>
              <dd className="inline" data-testid="result-service-mode">
                {formatServiceMode(bestMatchingOffering.serviceMode)}
              </dd>
            </div>
            {bestMatchingOffering.serviceAreas.length > 0 && (
              <div>
                <dt className="inline font-medium text-gray-500">Service area: </dt>
                <dd className="inline" data-testid="result-service-areas">
                  {bestMatchingOffering.serviceAreas.map(formatLocation).join(" · ")}
                </dd>
              </div>
            )}
            {bestMatchingOffering.genreTags.length > 0 && (
              <div>
                <dt className="inline font-medium text-gray-500">Genres: </dt>
                <dd className="inline" data-testid="result-genres">
                  {bestMatchingOffering.genreTags.join(", ")}
                </dd>
              </div>
            )}
            <div>
              <dt className="inline font-medium text-gray-500">Pricing: </dt>
              <dd className="inline" data-testid="result-pricing">
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
          <p className="text-xs text-gray-500 mt-2 italic" data-testid="result-pricing-disclaimer">
            {pricingLabel === null
              ? "This seller has not advertised pricing. Any pricing discussed later is non-binding until it is incorporated into approved terms."
              : "Advertised pricing is non-binding and not a quote. It binds no one until it is incorporated into approved terms."}
          </p>

          {bestMatchingOffering.includedServices.length > 0 && (
            <p className="text-xs text-gray-700 mt-2" data-testid="result-included-services">
              <span className="font-medium text-gray-500">Bundle includes: </span>
              {bestMatchingOffering.includedServices
                .map((included) => `${included.name} (bundle only)`)
                .join(", ")}
            </p>
          )}
        </div>

        <div className="bg-blue-50 p-3 rounded-lg" data-testid="result-match-reason">
          <p className="text-sm font-medium text-blue-900 mb-1">Why this matches</p>
          <p className="text-sm text-blue-800">{matchReason}</p>
        </div>
      </Card.Content>
    </Card>
  );
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
