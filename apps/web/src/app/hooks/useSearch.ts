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
//
// Concurrency and cancellation (M1.6):
// - The hook owns a monotonically increasing request counter (`requestIdRef`).
//   Every state mutation is guarded by `requestIdRef.current === currentRequest`
//   so a response (or error) that arrives after a newer request has started
//   is dropped without touching React state. The same guard protects the
//   loading state: `setIsLoading(false)` only fires when no newer request
//   has taken over, so a stale resolution can never clear the active
//   loading indicator.
// - Each in-flight `fetch` is tied to its own `AbortController`. When the
//   buyer starts a new search (or retries), the previous controller is
//   aborted so the browser stops reading the body and frees the socket.
//   The route handler honours `req.on("close")` indirectly via the
//   abort signal; combined with the requestId guard, no stale response
//   can corrupt UI state.
// - `retry()` re-submits the most recent (query, filters) tuple. The
//   tuple is captured before the fetch starts so the retry button can
//   rebuild the same payload even after the response has been rendered.
//   `retry()` is a no-op until at least one search has been issued.

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

// HTTP error codes whose responses are retriable by the buyer. The
// contract pins 503 SEARCH_UNAVAILABLE to a retriable state; 500
// SEARCH_FAILED is also retriable because the failure is recoverable
// by re-submission once the underlying issue (which never surfaces in
// the safe envelope) clears. Non-retriable failures (validation 4xx,
// media-type 415, rate-limit 429) are surfaced without a retry affordance.
const RETRIABLE_ERROR_CODES: ReadonlySet<string> = new Set(["SEARCH_UNAVAILABLE", "SEARCH_FAILED"]);

export interface UseSearchReturn {
  results: TalentSearchResponseV1 | null;
  isLoading: boolean;
  error: string | null;
  errorCode: string | null;
  fieldErrors: readonly ApiFieldErrorV1[];
  requestId: string | null;
  search: (query: string, filters: RequiredFiltersValue) => Promise<void>;
  retry: () => Promise<void>;
  clearResults: () => void;
}

export function useSearch(): UseSearchReturn {
  const [results, setResults] = useState<TalentSearchResponseV1 | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<readonly ApiFieldErrorV1[]>([]);
  const [requestId, setRequestId] = useState<string | null>(null);

  // Monotonic request counter. Every async resolution checks
  // `requestIdRef.current === currentRequest` before mutating React
  // state so a late-arriving response can never overwrite newer state.
  const requestIdRef = useRef(0);

  // Active fetch's AbortController. Replaced on every new search so the
  // previous in-flight request is cancelled at the browser level.
  const abortControllerRef = useRef<AbortController | null>(null);

  // Most recent submitted (query, filters) tuple. Captured before
  // the fetch starts so retry can rebuild the exact same request.
  const lastRequestRef = useRef<{ query: string; filters: RequiredFiltersValue } | null>(null);

  const search = useCallback(async (rawQuery: string, filters: RequiredFiltersValue) => {
    // Build the candidate payload that preserves every supplied
    // non-empty field. The candidate is the unvalidated shrink-wrap;
    // Express (with the shared schema) is the only thing that
    // decides which of these fields survive. The browser does NOT
    // pre-drop a one-character query or a malformed country code,
    // because that is the silent relaxation the contract forbids.
    const request = buildCandidatePayload(rawQuery.trim(), filters);

    // Cancel the previous in-flight request, if any. The previous
    // controller may have already settled; calling `abort()` on a
    // settled controller is a no-op, so this is safe unconditionally.
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const currentRequest = requestIdRef.current + 1;
    requestIdRef.current = currentRequest;

    // Remember the most recent (rawQuery, filters) tuple for retry.
    // The raw (untrimmed) query is stored so the retry UI can present
    // the buyer's original input verbatim.
    lastRequestRef.current = { query: rawQuery, filters };

    setIsLoading(true);
    setError(null);
    setErrorCode(null);
    setFieldErrors([]);

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: abortController.signal,
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
      // An aborted fetch is the expected outcome when the buyer starts
      // a new search. Treat it as a silent no-op so the new request's
      // loading state stays intact; the new request's own success or
      // error path will set the terminal state.
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
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
      // Only clear the loading indicator if no newer request has taken
      // over. A stale resolution must never clear the loading state of
      // the active request, satisfying the "stale responses cannot
      // clear the current loading state" contract.
      if (requestIdRef.current === currentRequest) {
        setIsLoading(false);
      }
    }
  }, []);

  const retry = useCallback(async () => {
    const last = lastRequestRef.current;
    if (last === null) return;
    await search(last.query, last.filters);
  }, [search]);

  const clearResults = useCallback(() => {
    // Cancel any in-flight request so its late resolution cannot touch
    // the cleared state.
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    requestIdRef.current += 1;
    setResults(null);
    setError(null);
    setErrorCode(null);
    setRequestId(null);
    setFieldErrors([]);
    setIsLoading(false);
  }, []);

  return {
    results,
    isLoading,
    error,
    errorCode,
    fieldErrors,
    requestId,
    search,
    retry,
    clearResults,
  };
}

// True when the error code permits a buyer-driven retry. Exposed so
// the page can render the retry affordance without duplicating the
// code set. Kept as a free function so unit tests can target it
// directly without rendering React.
export function isRetriableErrorCode(code: string | null): boolean {
  if (code === null) return false;
  return RETRIABLE_ERROR_CODES.has(code);
}
