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
  readonly basedInRegion: string;
  readonly basedInCity: string;
  readonly serviceAreaCountryCode: string;
  readonly serviceAreaRegion: string;
  readonly serviceAreaCity: string;
}

// A buyer request has "usable" criteria when at least one of the
// trimmed query or any structured filter has a non-empty value.
export function hasUsableCriteria(query: string, filters: RequiredFiltersValue): boolean {
  if (query.trim().length >= 2) return true;
  if (filters.primaryCategoryKey.length > 0) return true;
  if (filters.independentlyPurchasableServiceKey.length > 0) return true;
  if (filters.serviceModes.length > 0) return true;
  if (filters.basedInCountryCode.trim().length > 0) return true;
  if (filters.basedInRegion.trim().length > 0) return true;
  if (filters.basedInCity.trim().length > 0) return true;
  if (filters.serviceAreaCountryCode.trim().length > 0) return true;
  if (filters.serviceAreaRegion.trim().length > 0) return true;
  if (filters.serviceAreaCity.trim().length > 0) return true;
  return false;
}

// Build a candidate v1 payload that preserves every supplied non-empty
// field. The candidate is then parsed by the shared schema; the schema
// is the only thing that decides which of these fields survive.
//
// The `LocationFilter` sub-block is emitted whenever any of its three
// sub-fields (city, region, countryCode) is non-empty after trimming.
// A sub-field whose trimmed value is empty is omitted so the buyer
// can leave individual inputs blank without poisoning the others.
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
  const basedIn: Record<string, string> = {};
  const basedInCountryCode = filters.basedInCountryCode.trim().toUpperCase();
  if (basedInCountryCode.length > 0) basedIn.countryCode = basedInCountryCode;
  const basedInRegion = filters.basedInRegion.trim();
  if (basedInRegion.length > 0) basedIn.region = basedInRegion;
  const basedInCity = filters.basedInCity.trim();
  if (basedInCity.length > 0) basedIn.city = basedInCity;
  if (Object.keys(basedIn).length > 0) required.basedIn = basedIn;
  const serviceArea: Record<string, string> = {};
  const serviceAreaCountryCode = filters.serviceAreaCountryCode.trim().toUpperCase();
  if (serviceAreaCountryCode.length > 0) serviceArea.countryCode = serviceAreaCountryCode;
  const serviceAreaRegion = filters.serviceAreaRegion.trim();
  if (serviceAreaRegion.length > 0) serviceArea.region = serviceAreaRegion;
  const serviceAreaCity = filters.serviceAreaCity.trim();
  if (serviceAreaCity.length > 0) serviceArea.city = serviceAreaCity;
  if (Object.keys(serviceArea).length > 0) required.serviceArea = serviceArea;
  if (Object.keys(required).length > 0) candidate.required = required;
  return candidate;
}
