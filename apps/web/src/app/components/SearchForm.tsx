"use client";

// Free-text search input. The structured required filters (category,
// service mode, location, service area) live in the dedicated
// `RequiredFilters` component. The parent owns the submit handler and
// owns the structured filters, so the SearchForm stays narrowly
// responsible for the text query.
//
// The contract assigns runtime validation to Express
// (docs/contracts/search-api.md: "Express owns HTTP parsing, content
// type, runtime validation, request IDs, and error mapping."). The
// browser therefore does NOT enforce a `minLength` HTML5 attribute —
// that would silently block submission for short queries and produce
// an envelope that is not the standard `ApiErrorResponseV1`. Submit
// everything; let Express (with the shared Zod schema) be the only
// thing that decides which payloads are valid.

interface SearchFormProps {
  query: string;
  setQuery: (query: string) => void;
  loading: boolean;
  label?: string;
  placeholder?: string;
}

export function SearchForm({
  query,
  setQuery,
  loading,
  label = "Describe your project",
  placeholder = "e.g., Haitian producer in New York for a remote dancehall single",
}: SearchFormProps) {
  return (
    <div data-testid="search-query-field">
      <label htmlFor="search-query" className="block text-sm font-medium text-gray-700 mb-2">
        {label}
      </label>
      <input
        id="search-query"
        name="q"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        data-testid="search-input"
        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        disabled={loading}
        maxLength={500}
      />
    </div>
  );
}
