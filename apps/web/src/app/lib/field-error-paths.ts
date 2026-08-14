// Single source of truth for which field-error paths the
// `RequiredFilters` panel claims.
//
// Both the panel itself (which renders errors beside the relevant
// control) and the page (which renders everything else in the
// global error list) MUST agree on ownership; otherwise the same
// error renders twice or not at all. This module is the only place
// the partition is defined.

// Path prefixes that the required-filters panel renders beside a
// control. The page renders every other field error in the global
// panel. The list deliberately includes both the specific field
// paths (e.g. `required.basedIn.countryCode`) and the broader
// `required.*` / `required` paths so any error produced by the
// shared schema for the required section is owned by exactly one
// renderer.
export const CONTROLLED_REQUIRED_PATHS = [
  "required.primaryCategoryKeys",
  "required.independentlyPurchasableServiceKeys",
  "required.serviceModes",
  "required.basedIn",
  "required.serviceArea",
  "required",
] as const;

export type ControlledRequiredPath = (typeof CONTROLLED_REQUIRED_PATHS)[number];

// True when `path` matches one of the controlled prefixes (the
// error is owned by the required-filters panel). Returns false for
// every other path so the page renders it in the global panel.
export function isControlledRequiredPath(path: string): boolean {
  return CONTROLLED_REQUIRED_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  );
}

// Partition the input `errors` into the subset the required-filters
// panel renders beside a control and the subset the page renders in
// the global error list. Centralised here so the panel and the page
// cannot disagree on ownership.
export function partitionFieldErrors<T extends { readonly path: string }>(
  errors: readonly T[],
): { readonly controlled: readonly T[]; readonly unmatched: readonly T[] } {
  const controlled: T[] = [];
  const unmatched: T[] = [];
  for (const err of errors) {
    if (isControlledRequiredPath(err.path)) controlled.push(err);
    else unmatched.push(err);
  }
  return { controlled, unmatched };
}
