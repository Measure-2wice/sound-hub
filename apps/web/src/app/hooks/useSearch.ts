"use client";

// Browser-side search hook. The browser builds a candidate v1 request
// payload from the buyer's inputs and parses it with the shared
// `talentSearchRequestV1Schema` before sending it. The schema is the
// executable contract; the browser MUST NOT silently drop or relax
// fields, and MUST surface malformed input as a field-level error
// envelope rather than converting it into a successful request.
//
// Earlier revisions of this hook manually constructed a request and
// dropped a one-character query when any required filter was supplied.
// That silently violated the rule that required constraints are never
// "saved" by relaxing or dropping a query. The build-the-payload-then-
// parse-the-payload flow sends only schema-valid data, and a one-
// character query now produces a field-level error envelope that the
// page renders beside the text control.

import { useCallback, useRef, useState } from "react";
import type { ZodError, ZodIssue } from "zod";
import {
  apiErrorResponseV1Schema,
  talentSearchRequestV1Schema,
  talentSearchResponseV1Schema,
  type ApiFieldErrorV1,
  type TalentSearchRequestV1,
  type TalentSearchResponseV1,
} from "@soundhub/types";
import {
  buildCandidatePayload,
  hasUsableCriteria,
  type RequiredFiltersValue,
} from "../lib/talent-search-request-builder";

// Re-export the shared type and helpers so other browser modules
// continue to import everything from this hook. The page and the
// filter component both consume these definitions; the hook remains
// the single surface for the browser.
export { buildCandidatePayload, hasUsableCriteria };
export type { RequiredFiltersValue };

// Map a Zod issue path to the public request path. The schema uses
// `[]` for empty root paths, which the contract renders as `<root>`.
function zodIssuesToFieldErrors(issues: readonly ZodIssue[]): readonly ApiFieldErrorV1[] {
  return issues.map((issue) => ({
    path: issue.path.length === 0 ? "<root>" : issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

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
    const trimmed = rawQuery.trim();

    // Phase 1: build the candidate payload that preserves every
    // supplied non-empty field. The candidate is the unvalidated
    // shrink-wrap; the schema is the only thing that decides which
    // of these fields survive. We deliberately do NOT pre-drop a
    // one-character query or a malformed country code here, because
    // that is exactly the silent relaxation the contract forbids.
    const candidate = buildCandidatePayload(trimmed, filters);

    // Phase 2: parse the candidate with the shared schema. Any
    // failure here is a CLIENT-side rejection; we surface it through
    // the same field-error envelope the API uses so the buyer sees
    // actionable feedback without the round trip.
    const parsed = talentSearchRequestV1Schema.safeParse(candidate);
    if (!parsed.success) {
      const issues = (parsed.error as ZodError).issues;
      const firstIssue = issues[0];
      const isNoCriteria =
        issues.length === 1 &&
        firstIssue !== undefined &&
        firstIssue.message.includes(
          "at least one of query, required, or preferred must contain criteria",
        );
      setResults(null);
      setError(
        isNoCriteria
          ? "Please enter at least 2 characters of search criteria or a required filter."
          : "Search request failed validation.",
      );
      setErrorCode("INVALID_SEARCH_CRITERIA");
      setFieldErrors(isNoCriteria ? [] : zodIssuesToFieldErrors(issues));
      setRequestId(null);
      return;
    }

    const request: TalentSearchRequestV1 = parsed.data;

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
