"use client";

import { useState, type FormEvent } from "react";
import { useSearch } from "../hooks/useSearch";
import { Card } from "./ui/Card";
import { SearchForm } from "./SearchForm";
import type { TalentSearchResultV1 } from "@soundhub/types";

export function SearchPage() {
  const [query, setQuery] = useState("");
  const { results, isLoading, error, errorCode, requestId, search } = useSearch();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void search(query);
  };

  const showEmptyState =
    !isLoading && results !== null && results.results.length === 0 && query.trim().length >= 2;

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
          <SearchForm
            query={query}
            setQuery={setQuery}
            onSearch={handleSubmit}
            loading={isLoading}
          />
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
        <Card.Title data-testid="result-seller-name">{seller.professionalName}</Card.Title>
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
              TermsVersion. The disclaimer is always shown so no pricing
              presentation reads as a quote or commitment, but its wording
              follows the state: disclaiming "advertised pricing" on an
              offering that advertises none would imply a price is present. */}
          <p className="text-xs text-gray-500 mt-2 italic" data-testid="result-pricing-disclaimer">
            {pricingLabel === null
              ? "This seller has not advertised pricing. Any pricing discussed later is non-binding until agreed terms."
              : "Advertised pricing is non-binding and not a quote."}
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

function formatPricing(
  pricing: TalentSearchResultV1["bestMatchingOffering"]["pricing"],
): string | null {
  if (!pricing) return null;
  if (pricing.kind === "ContactForQuote") return "Contact for quote";
  const amount = pricing.amount.amountMinor / 100;
  const formatted = `${amount.toFixed(2)} ${pricing.amount.currency}/${pricing.unit}`;
  return pricing.kind === "StartingAt" ? `Starting at ${formatted}` : `Fixed ${formatted}`;
}
