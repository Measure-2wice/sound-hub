"use client";

interface SearchFormProps {
  query: string;
  setQuery: (query: string) => void;
  onSearch: (e: React.FormEvent) => void;
  loading: boolean;
  label?: string;
  placeholder?: string;
}

export function SearchForm({
  query,
  setQuery,
  onSearch,
  loading,
  label = "Describe your project",
  placeholder = "e.g., Haitian producer in New York for a remote dancehall single",
}: SearchFormProps) {
  return (
    <form onSubmit={onSearch} className="mb-8" data-testid="search-form">
      <div className="space-y-4">
        <div>
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
            minLength={2}
            maxLength={500}
          />
        </div>
        <button
          type="submit"
          disabled={loading || query.trim().length < 2}
          data-testid="search-submit"
          className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Searching…" : "Search talent"}
        </button>
      </div>
    </form>
  );
}
