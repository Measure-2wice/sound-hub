"use client";

import { useCallback, useRef, useState } from "react";
import {
  apiErrorResponseV1Schema,
  talentSearchResponseV1Schema,
  type ApiFieldErrorV1,
  type ServiceModeV1,
  type TalentSearchRequestV1,
  type TalentSearchResponseV1,
} from "@soundhub/types";

// The web's browser-side representation of a buyer-supplied structured
// required filter. Each field is optional and serialised into the v1
// request body when present. The hook is the single source of truth
// for which values are sent over the wire: empty strings are dropped so
// the API never receives a meaningless filter, and the buyer can
// leave any individual filter blank.
export interface RequiredFilters {
  readonly primaryCategoryKey: string;
  readonly customPrimaryCategoryKey: string;
  readonly independentlyPurchasableServiceKey: string;
  readonly serviceModes: readonly ServiceModeV1[];
  readonly basedInCountryCode: string;
  readonly serviceAreaCountryCode: string;
}

// `RequiredFilters` is a flat UI shape; `toRequestCriteria` is the only
// place that converts it to the structured v1 schema. Centralising the
// conversion keeps the UI honest about which keys actually map to the
// contract and prevents the browser from sending a half-empty filter
// object to the API.
function toRequestCriteria(
  filters: RequiredFilters,
): TalentSearchRequestV1["required"] | undefined {
  const primaryCategoryKeys = [
    filters.primaryCategoryKey,
    ...(filters.customPrimaryCategoryKey ? [filters.customPrimaryCategoryKey] : []),
  ].filter((value) => value.length > 0);
  const independentlyPurchasableServiceKeys = filters.independentlyPurchasableServiceKey
    ? [filters.independentlyPurchasableServiceKey]
    : [];
  const basedInCountryCode = filters.basedInCountryCode.trim().toUpperCase();
  const serviceAreaCountryCode = filters.serviceAreaCountryCode.trim().toUpperCase();
  const result: {
    primaryCategoryKeys?: string[];
    independentlyPurchasableServiceKeys?: string[];
    serviceModes?: ServiceModeV1[];
    basedIn?: { countryCode: string };
    serviceArea?: { countryCode: string };
  } = {};
  if (primaryCategoryKeys.length > 0) result.primaryCategoryKeys = primaryCategoryKeys;
  if (independentlyPurchasableServiceKeys.length > 0) {
    result.independentlyPurchasableServiceKeys = independentlyPurchasableServiceKeys;
  }
  if (filters.serviceModes.length > 0) result.serviceModes = [...filters.serviceModes];
  if (basedInCountryCode) result.basedIn = { countryCode: basedInCountryCode };
  if (serviceAreaCountryCode) result.serviceArea = { countryCode: serviceAreaCountryCode };
  if (Object.keys(result).length === 0) return undefined;
  return result;
}

export interface UseSearchReturn {
  results: TalentSearchResponseV1 | null;
  isLoading: boolean;
  error: string | null;
  errorCode: string | null;
  fieldErrors: readonly ApiFieldErrorV1[];
  requestId: string | null;
  search: (query: string, filters: RequiredFilters) => Promise<void>;
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

  const search = useCallback(async (rawQuery: string, filters: RequiredFilters) => {
    const trimmed = rawQuery.trim();
    const request = buildRequest(trimmed, filters);
    if (request === null) {
      // Client-side rejection: trimmed query is too short. Field-level
      // errors are empty here because the v1 schema rejection is
      // single-issue and the buyer-visible message is sufficient.
      setResults(null);
      setError("Please enter at least 2 characters of search criteria.");
      setErrorCode("INVALID_SEARCH_CRITERIA");
      setFieldErrors([]);
      return;
    }

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

// Builds the v1 request from the raw query and the UI filter shape.
// Returns null ONLY when the buyer has supplied no usable criteria at
// all, so the caller can short-circuit with a client-side error rather
// than sending an empty request. The actual value-level validation
// (shape, length, regex, canonical existence) is owned by the API and
// the shared Zod schema; we deliberately do not pre-validate here so
// the buyer sees the canonical safe-envelope errors rather than a
// silent client-side rejection. Empty individual filters collapse out
// so the API never sees them.
function buildRequest(query: string, filters: RequiredFilters): TalentSearchRequestV1 | null {
  const hasQuery = query.length >= 2;
  const hasFilters =
    filters.primaryCategoryKey.length > 0 ||
    filters.customPrimaryCategoryKey.length > 0 ||
    filters.independentlyPurchasableServiceKey.length > 0 ||
    filters.serviceModes.length > 0 ||
    filters.basedInCountryCode.trim().length > 0 ||
    filters.serviceAreaCountryCode.trim().length > 0;
  if (!hasQuery && !hasFilters) return null;

  const request: TalentSearchRequestV1 = {};
  if (hasQuery) request.query = query;
  const required = toRequestCriteria(filters);
  // Drop empty-key objects so the schema's strict mode is satisfied and
  // the request is as small as possible.
  if (required) request.required = required;
  return request;
}
