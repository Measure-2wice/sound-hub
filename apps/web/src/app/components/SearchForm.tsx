interface SearchFormProps {
  query: string;
  setQuery: (query: string) => void;
  onSearch: (e: React.FormEvent) => void;
  loading: boolean;
}

export function SearchForm({ query, setQuery, onSearch, loading }: SearchFormProps) {
  return (
    <form onSubmit={onSearch} style={{ marginBottom: "2rem" }}>
      <div style={{ display: "flex", gap: "1rem" }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Describe the vibe you're looking for... (e.g., 'dark atmospheric beats with heavy bass')"
          style={{
            flex: 1,
            padding: "0.75rem",
            fontSize: "1rem",
            border: "2px solid #ddd",
            borderRadius: "8px",
            outline: "none",
          }}
          onFocus={(e) => {
            e.target.style.borderColor = "#0070f3";
          }}
          onBlur={(e) => {
            e.target.style.borderColor = "#ddd";
          }}
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          style={{
            padding: "0.75rem 1.5rem",
            fontSize: "1rem",
            backgroundColor: loading ? "#ccc" : "#0070f3",
            color: "white",
            border: "none",
            borderRadius: "8px",
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Searching..." : "Find Producers"}
        </button>
      </div>
    </form>
  );
}