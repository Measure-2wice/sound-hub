"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearch } from "../hooks/useSearch";
import { hasUsableCriteria, type RequiredFiltersValue } from "../lib/talent-search-request-builder";
import { isControlledRequiredPath } from "../lib/field-error-paths";
import { Card } from "./ui/Card";
import { SearchForm } from "./SearchForm";
import { RequiredFilters } from "./RequiredFilters";
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
  const { results, isLoading, error, errorCode, fieldErrors, requestId, search } = useSearch();

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

function ResultCard({ result }: { result: TalentSearchResultV1 }) {
  const { seller, bestMatchingOffering, additionalMatchingOfferings, matchReason } = result;

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
                  <p
                    className="text-sm font-medium text-gray-800"
                    data-testid="result-additional-offering-title"
                  >
                    {offering.title}
                  </p>
                  <p className="text-xs text-gray-600 mt-0.5">{offering.description}</p>
                  <dl className="text-xs text-gray-700 mt-1 space-y-0.5">
                    <div>
                      <dt className="inline font-medium text-gray-500">Service category: </dt>
                      <dd className="inline">{offering.primaryCategory.name}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-gray-500">Service mode: </dt>
                      <dd className="inline">{formatServiceMode(offering.serviceMode)}</dd>
                    </div>
                  </dl>
                  {offering.includedServices.length > 0 && (
                    <p className="text-xs text-gray-700 mt-1">
                      <span className="font-medium text-gray-500">Bundle includes: </span>
                      {offering.includedServices
                        .map((included) => `${included.name} (bundle only)`)
                        .join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="bg-blue-50 p-3 rounded-lg mt-3" data-testid="result-match-reason">
          <p className="text-sm font-medium text-blue-900 mb-1">Why this matches</p>
          <p className="text-sm text-blue-800">{matchReason}</p>
          {/* relevanceScore is a bounded strategy-specific ordering signal; it
              is not a probability, quality rating, or confidence. The card
              surfaces it as a qualitative fit description rather than a
              percentage so the buyer is never led to read it as certainty. */}
          <p
            className="mt-2 text-xs text-blue-700"
            data-testid="result-fit-summary"
            data-relevance-score={result.relevanceScore}
            data-fit-band={fitBandFor(result.relevanceScore)}
          >
            {describeFit(result.relevanceScore)}
          </p>
        </div>
      </Card.Content>
    </Card>
  );
}

// BestOfferingCard: the lead offering for a result. Extracted so the
// best/additional rendering paths share the same row markup. The
// `testIdPrefix` lets the best card keep its `result-*` test ids and the
// additional cards re-use stable names without collision.
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
      <p className="text-sm font-medium text-gray-900" data-testid={`${testIdPrefix}-title`}>
        {offering.title}
      </p>
      <p className="text-xs text-gray-600 mt-1">{offering.description}</p>

      <dl className="text-xs text-gray-700 mt-2 space-y-1">
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

      {offering.includedServices.length > 0 && (
        <p className="text-xs text-gray-700 mt-2" data-testid={`${testIdPrefix}-included-services`}>
          <span className="font-medium text-gray-500">Bundle includes: </span>
          {offering.includedServices.map((included) => `${included.name} (bundle only)`).join(", ")}
        </p>
      )}
    </div>
  );
}

// Map a bounded [0, 1] strategy score to a qualitative fit phrase. The
// raw value never reaches the page as a percentage; only the band label
// and a one-sentence explanation do. The `data-fit-band` attribute
// carries the band key for downstream tests so they can assert the
// qualitative mapping without depending on threshold prose.
function fitBandFor(score: number): "strong" | "good" | "partial" | "weak" {
  if (score >= 0.75) return "strong";
  if (score >= 0.5) return "good";
  if (score >= 0.25) return "partial";
  return "weak";
}

function describeFit(score: number): string {
  const band = fitBandFor(score);
  switch (band) {
    case "strong":
      return "Strong qualitative fit for this search.";
    case "good":
      return "Good qualitative fit; check details before commissioning.";
    case "partial":
      return "Partial qualitative fit; some preferences are unmet.";
    case "weak":
      return "Weak qualitative fit; consider broadening your search.";
  }
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
