"use client";

import { useCallback, useRef, useState } from "react";
import {
  apiErrorResponseV1Schema,
  talentSearchRequestV1Schema,
  talentSearchResponseV1Schema,
  type TalentSearchResponseV1,
} from "@soundhub/types";

export interface UseSearchReturn {
  results: TalentSearchResponseV1 | null;
  isLoading: boolean;
  error: string | null;
  errorCode: string | null;
  requestId: string | null;
  search: (query: string) => Promise<void>;
  clearResults: () => void;
}

export function useSearch(): UseSearchReturn {
  const [results, setResults] = useState<TalentSearchResponseV1 | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  // Cancellation guard to prevent stale responses from overwriting newer state.
  const requestIdRef = useRef(0);

  const search = useCallback(async (rawQuery: string) => {
    const trimmed = rawQuery.trim();
    if (trimmed.length < 2) {
      setResults(null);
      setError("Please enter at least 2 characters of search criteria.");
      setErrorCode("INVALID_SEARCH_CRITERIA");
      return;
    }

    const parsed = talentSearchRequestV1Schema.safeParse({ query: trimmed });
    if (!parsed.success) {
      setResults(null);
      setError(parsed.error.issues[0]?.message ?? "Search criteria are invalid.");
      setErrorCode("INVALID_SEARCH_CRITERIA");
      return;
    }

    const currentRequest = requestIdRef.current + 1;
    requestIdRef.current = currentRequest;
    setIsLoading(true);
    setError(null);
    setErrorCode(null);

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const responseRequestId = response.headers.get("x-request-id") ?? "";

      if (!response.ok) {
        const errorJson: unknown = await response.json().catch(() => null);
        const parsedError = apiErrorResponseV1Schema.safeParse(errorJson);
        if (parsedError.success) {
          if (requestIdRef.current !== currentRequest) return;
          setError(parsedError.data.error.message);
          setErrorCode(parsedError.data.error.code);
          setRequestId(parsedError.data.error.requestId);
          setResults(null);
          return;
        }
        if (requestIdRef.current !== currentRequest) return;
        setError(`Search failed: ${response.statusText || "unknown error"}`);
        setErrorCode("SEARCH_FAILED");
        setRequestId(responseRequestId);
        setResults(null);
        return;
      }

      const data: unknown = await response.json();
      const validated = talentSearchResponseV1Schema.safeParse(data);
      if (!validated.success) {
        if (requestIdRef.current !== currentRequest) return;
        setError("Search returned an unexpected response shape.");
        setErrorCode("SEARCH_FAILED");
        setRequestId(responseRequestId);
        setResults(null);
        return;
      }
      if (requestIdRef.current !== currentRequest) return;
      setResults(validated.data);
      setRequestId(responseRequestId);
    } catch (err) {
      if (requestIdRef.current !== currentRequest) return;
      const message =
        err instanceof Error ? (err.name === "AbortError" ? null : err.message) : "Network error";
      if (message !== null) {
        setError(message);
        setErrorCode("SEARCH_FAILED");
        setRequestId(null);
        setResults(null);
      }
    } finally {
      if (requestIdRef.current === currentRequest) {
        setIsLoading(false);
      }
    }
  }, []);

  const clearResults = useCallback(() => {
    setResults(null);
    setError(null);
    setErrorCode(null);
    setRequestId(null);
  }, []);

  return { results, isLoading, error, errorCode, requestId, search, clearResults };
}
