"use client";

// Browser-side search hook.
//
// The contract assigns validation, request IDs, and error mapping to
// Express (see docs/contracts/search-api.md: "Express owns HTTP parsing,
// content type, runtime validation, request IDs, and error mapping.").
// The browser therefore ALWAYS routes a buyer submission through
// `/api/search`; it never short-circuits with a locally synthesised
// envelope. The shared `talentSearchRequestV1Schema` is still imported
// here as a type reference for the success response shape, but the
// authoritative validation is the one Express performs against the
// same shared schema.
//
// The `buildCandidatePayload` / `hasUsableCriteria` / `RequiredFiltersValue`
// definitions are owned by `talent-search-request-builder.ts` and
// imported directly from that module rather than proxied through this
// hook, so the request-model surface stays a single import.

import { useCallback, useRef, useState } from "react";
import {
  apiErrorResponseV1Schema,
  talentSearchResponseV1Schema,
  type ApiFieldErrorV1,
  type TalentSearchResponseV1,
} from "@soundhub/types";
import {
  buildCandidatePayload,
  type RequiredFiltersValue,
} from "../lib/talent-search-request-builder";

export interface UseSearchReturn {
  results: TalentSearchResponseV1 | null;
  isLoading: boolean;
  error: string | null;
  errorCode: string | null;
  fieldErrors: readonly ApiFieldErrorV1[];
  requestId: string | null;
  search: (query: string, filters: RequiredFiltersValue) => Promise<void>;
  clearResults: () => void;
}

export function useSearch(): UseSearchReturn {
  const [results, setResults] = useState<TalentSearchResponseV1 | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<readonly ApiFieldErrorV1[]>([]);
  const [requestId, setRequestId] = useState<string | null>(null);

  // Cancellation guard to prevent stale responses from overwriting newer state.
  const requestIdRef = useRef(0);

  const search = useCallback(async (rawQuery: string, filters: RequiredFiltersValue) => {
    // Build the candidate payload that preserves every supplied
    // non-empty field. The candidate is the unvalidated shrink-wrap;
    // Express (with the shared schema) is the only thing that
    // decides which of these fields survive. The browser does NOT
    // pre-drop a one-character query or a malformed country code,
    // because that is the silent relaxation the contract forbids.
    const request = buildCandidatePayload(rawQuery.trim(), filters);

    const currentRequest = requestIdRef.current + 1;
    requestIdRef.current = currentRequest;
    setIsLoading(true);
    setError(null);
    setErrorCode(null);
    setFieldErrors([]);

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
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
          // Field-level errors power the per-control validation feedback.
          // The contract caps them at 50 entries; the page renders them
          // beside the named path.
          setFieldErrors(parsedError.data.error.fields ?? []);
          setResults(null);
          return;
        }
        if (requestIdRef.current !== currentRequest) return;
        setError(`Search failed: ${response.statusText || "unknown error"}`);
        setErrorCode("SEARCH_FAILED");
        setRequestId(responseRequestId);
        setFieldErrors([]);
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
        setFieldErrors([]);
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
        setFieldErrors([]);
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
    setFieldErrors([]);
  }, []);

  return { results, isLoading, error, errorCode, fieldErrors, requestId, search, clearResults };
}
