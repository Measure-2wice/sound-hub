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

// The browser's representation of the contract's `LocationFilter`
// sub-block (`{ city?, region?, countryCode? }`). The UI form has a
// controlled text input for every named field; the countryCode is
// upper-cased as the buyer types so the schema sees `JM` rather
// than `jm`. Both `basedIn` and `serviceArea` use this same shape
// so the request construction never has to repeat the trim/omit
// logic — `toLocationFilterPayload` is the single owner.
//
// Trimming and omission rules:
// - Each sub-field is trimmed.
// - A sub-field whose trimmed value is empty is omitted from the
//   wire payload so individual inputs can be left blank without
//   "poisoning" the others.
// - The resulting `LocationFilter` object is emitted only when at
//   least one sub-field is non-empty after trimming.
export interface LocationFilterValue {
  readonly city: string;
  readonly region: string;
  readonly countryCode: string;
}

export const EMPTY_LOCATION_FILTER_VALUE: LocationFilterValue = {
  city: "",
  region: "",
  countryCode: "",
};

// Convert a UI `LocationFilterValue` into the on-the-wire shape
// (the contract's `LocationFilter`). The shared Zod schema is the
// authoritative validator of the result; this helper only mirrors
// the form-state representation into the wire format.
//
// Returns `undefined` when every sub-field is empty after trimming so
// callers can decide whether to emit the parent block.
export function toLocationFilterPayload(
  value: LocationFilterValue,
): { city?: string; region?: string; countryCode?: string } | undefined {
  const payload: { city?: string; region?: string; countryCode?: string } = {};
  const city = value.city.trim();
  if (city.length > 0) payload.city = city;
  const region = value.region.trim();
  if (region.length > 0) payload.region = region;
  // Country codes are stored upper-cased on input; the schema requires
  // an ISO 3166-1 alpha-2 code, so we never lower-case on the way out.
  const countryCode = value.countryCode.trim().toUpperCase();
  if (countryCode.length > 0) payload.countryCode = countryCode;
  if (Object.keys(payload).length === 0) return undefined;
  return payload;
}

// True when a `LocationFilterValue` carries at least one usable
// (non-empty after trimming) sub-field. Used by `hasUsableCriteria`
// to evaluate `basedIn` and `serviceArea` through the same predicate.
export function isLocationFilterValueNonEmpty(value: LocationFilterValue): boolean {
  return (
    value.countryCode.trim().length > 0 ||
    value.region.trim().length > 0 ||
    value.city.trim().length > 0
  );
}

export interface RequiredFiltersValue {
  readonly primaryCategoryKey: string;
  readonly independentlyPurchasableServiceKey: string;
  readonly serviceModes: readonly ServiceModeV1[];
  readonly basedIn: LocationFilterValue;
  readonly serviceArea: LocationFilterValue;
}

// A buyer request has "usable" criteria when at least one of the
// trimmed query or any structured filter has a non-empty value.
export function hasUsableCriteria(query: string, filters: RequiredFiltersValue): boolean {
  if (query.trim().length >= 2) return true;
  if (filters.primaryCategoryKey.length > 0) return true;
  if (filters.independentlyPurchasableServiceKey.length > 0) return true;
  if (filters.serviceModes.length > 0) return true;
  if (isLocationFilterValueNonEmpty(filters.basedIn)) return true;
  if (isLocationFilterValueNonEmpty(filters.serviceArea)) return true;
  return false;
}

// Build a candidate v1 payload that preserves every supplied non-empty
// field. The candidate is then parsed by the shared schema; the schema
// is the only thing that decides which of these fields survive.
//
// `LocationFilter` sub-blocks go through `toLocationFilterPayload` so
// the trim/omit logic exists in exactly one place — the precedent set
// by the M1.4 review (P2-001) was that two parallel country/region/city
// triplets duplicated that logic and would inevitably drift.
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
  const basedInPayload = toLocationFilterPayload(filters.basedIn);
  if (basedInPayload !== undefined) required.basedIn = basedInPayload;
  const serviceAreaPayload = toLocationFilterPayload(filters.serviceArea);
  if (serviceAreaPayload !== undefined) required.serviceArea = serviceAreaPayload;
  if (Object.keys(required).length > 0) candidate.required = required;
  return candidate;
}
