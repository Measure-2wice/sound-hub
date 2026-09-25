"use client";

// Free-text search input (post-#83 visual-parity pass).
//
// The post-#83 visual pass re-mounts the search input inside the new
// Stitch `Find Caribbean talent` composition. The input now sits inside a
// row that also hosts the Filters disclosure toggle and the coral
// "Find talent" submit, so the field has no room for its own visible
// label — `hideLabel` makes the label visually hidden (`sr-only`) while
// preserving it for screen readers.
//
// The contract assigns runtime validation to Express
// (docs/contracts/search-api.md: "Express owns HTTP parsing, content
// type, runtime validation, request IDs, and error mapping."). The
// browser therefore does NOT enforce a `minLength` HTML5 attribute —
// that would silently block submission for short queries and produce an
// envelope that is not the standard `ApiErrorResponseV1`. Submit
// everything; let Express (with the shared Zod schema) be the only
// thing that decides which payloads are valid.

interface SearchFormProps {
  query: string;
  setQuery: (query: string) => void;
  loading: boolean;
  label?: string;
  placeholder?: string;
  hideLabel?: boolean;
}

export function SearchForm({
  query,
  setQuery,
  loading,
  label = "Describe your project",
  placeholder = "e.g., Haitian producer in New York for a remote dancehall single",
  hideLabel = false,
}: SearchFormProps) {
  return (
    <div data-testid="search-query-field" className="w-full">
      <label
        htmlFor="search-query"
        className={hideLabel ? "sr-only" : "block text-sm font-medium text-ink mb-2"}
      >
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
        className="w-full px-2 py-2 bg-transparent text-lg text-ink placeholder:text-muted/70 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
        disabled={loading}
        maxLength={500}
      />
    </div>
  );
}
