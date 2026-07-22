"use client";

import { useState } from 'react';
import { useSearch } from '../hooks/useSearch';
import { Card } from './ui/Card';
import type { IQueryResponse } from '@soundhub/types';

export function SearchPage() {
  const [query, setQuery] = useState('');
  const { results, isLoading, error, search } = useSearch();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await search(query);
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Hero Section */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Find Your Perfect Producer
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto">
          Describe the vibe you're looking for and let AI match you with producers who can bring your vision to life.
        </p>
      </div>

      {/* Search Form */}
      <Card className="mb-8">
        <Card.Content>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="search" className="block text-sm font-medium text-gray-700 mb-2">
                Describe your sound
              </label>
              <input
                id="search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g., 'dark atmospheric beats with heavy bass and industrial elements'"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={isLoading}
              />
            </div>
            <button
              type="submit"
              disabled={isLoading || !query.trim()}
              className="w-full bg-blue-600 text-white py-3 px-6 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? 'Searching...' : 'Find Producers'}
            </button>
          </form>
        </Card.Content>
      </Card>

      {/* Error State */}
      {error && (
        <Card variant="outlined" className="mb-6 border-red-200 bg-red-50">
          <Card.Content>
            <p className="text-red-800">❌ {error}</p>
          </Card.Content>
        </Card>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-6">
            Matching Producers ({results.length})
          </h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {results.map((result, index) => (
              <ProducerCard key={`${result.producerProfile.id}-${index}`} result={result} />
            ))}
          </div>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          <p className="mt-4 text-gray-600">🤖 AI is analyzing your vibe...</p>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && results.length === 0 && query && !error && (
        <Card className="text-center py-12">
          <Card.Content>
            <p className="text-gray-600">No producers found matching your vibe. Try a different description!</p>
          </Card.Content>
        </Card>
      )}
    </div>
  );
}

// Extracted Producer Card Component
function ProducerCard({ result }: { result: IQueryResponse }) {
  const { producerProfile, aiMatchExplanation, matchScore } = result;

  return (
    <Card variant="elevated" className="hover:shadow-xl transition-shadow">
      <Card.Header>
        <Card.Title>{producerProfile.displayName}</Card.Title>
        <div className="flex flex-wrap gap-2 mt-2">
          {producerProfile.genreTags.map((tag) => (
            <span
              key={tag}
              className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full"
            >
              {tag}
            </span>
          ))}
        </div>
      </Card.Header>

      <Card.Content>
        <p className="text-gray-600 text-sm mb-4">{producerProfile.bio}</p>

        <div className="bg-blue-50 p-3 rounded-lg">
          <p className="text-sm font-medium text-blue-900 mb-1">AI Match Explanation:</p>
          <p className="text-sm text-blue-800">{aiMatchExplanation}</p>
          {matchScore && (
            <p className="text-sm font-bold text-blue-600 mt-2">
              Match Score: {Math.round(matchScore * 100)}%
            </p>
          )}
        </div>
      </Card.Content>

      <Card.Footer>
        <button className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors">
          View Profile
        </button>
      </Card.Footer>
    </Card>
  );
}