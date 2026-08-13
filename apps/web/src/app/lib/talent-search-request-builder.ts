// Pure helpers for building the v1 talent-search request payload.
//
// These helpers are intentionally React-free so they can be unit-tested
// under the Node test runner without spinning up a renderer. The hook
// in `useSearch.ts` composes them to produce the outbound payload.
//
// The shape never changes at the React boundary; the same helpers
// power the form's "usable criteria" decision and the request
// construction that the shared Zod schema validates.

import { type ServiceModeV1 } from "@soundhub/types";

export interface RequiredFiltersValue {
  readonly primaryCategoryKey: string;
  readonly independentlyPurchasableServiceKey: string;
  readonly serviceModes: readonly ServiceModeV1[];
  readonly basedInCountryCode: string;
  readonly serviceAreaCountryCode: string;
}

// A buyer request has "usable" criteria when at least one of the
// trimmed query or any structured filter has a non-empty value.
export function hasUsableCriteria(query: string, filters: RequiredFiltersValue): boolean {
  if (query.trim().length >= 2) return true;
  if (filters.primaryCategoryKey.length > 0) return true;
  if (filters.independentlyPurchasableServiceKey.length > 0) return true;
  if (filters.serviceModes.length > 0) return true;
  if (filters.basedInCountryCode.trim().length > 0) return true;
  if (filters.serviceAreaCountryCode.trim().length > 0) return true;
  return false;
}

// Build a candidate v1 payload that preserves every supplied non-empty
// field. The candidate is then parsed by the shared schema; the schema
// is the only thing that decides which of these fields survive.
export function buildCandidatePayload(
  query: string,
  filters: RequiredFiltersValue,
): Record<string, unknown> {
  const candidate: Record<string, unknown> = {};
  if (query.length > 0) candidate.query = query;
  const required: Record<string, unknown> = {};
  if (filters.primaryCategoryKey.length > 0) {
    required.primaryCategoryKeys = [filters.primaryCategoryKey];
  }
  if (filters.independentlyPurchasableServiceKey.length > 0) {
    required.independentlyPurchasableServiceKeys = [filters.independentlyPurchasableServiceKey];
  }
  if (filters.serviceModes.length > 0) {
    required.serviceModes = [...filters.serviceModes];
  }
  const basedInCountryCode = filters.basedInCountryCode.trim().toUpperCase();
  if (basedInCountryCode.length > 0) {
    required.basedIn = { countryCode: basedInCountryCode };
  }
  const serviceAreaCountryCode = filters.serviceAreaCountryCode.trim().toUpperCase();
  if (serviceAreaCountryCode.length > 0) {
    required.serviceArea = { countryCode: serviceAreaCountryCode };
  }
  if (Object.keys(required).length > 0) candidate.required = required;
  return candidate;
}
