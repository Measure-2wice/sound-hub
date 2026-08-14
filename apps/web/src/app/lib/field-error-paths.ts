// Single source of truth for which field-error paths the
// `RequiredFilters` panel claims.
//
// Both the panel itself (which renders errors beside the relevant
// control) and the page (which renders everything else in the
// global error list) MUST agree on ownership; otherwise the same
// error renders twice or not at all. This module is the only place
// the partition is defined.

// Field-error paths the `RequiredFilters` panel renders. The page
// renders every other field error in the global panel.
//
// The list intentionally holds ONLY the paths consumed by an actual
// renderer in `RequiredFilters.tsx`. Each control-level path is
// rendered beside its own control; the section-level `required` path
// is rendered at the top of the panel as a section error. Any other
// `required.*` path (for example a future `required.futureField`) is
// NOT claimed here so it falls through to the global panel rather
// than being silently swallowed by an unrendered claim.
//
// Do NOT add `"required"` as a prefix or wildcard. Adding the bare
// path or a wildcard would let the predicate claim paths the panel
// does not render, producing field errors that are removed from the
// global list but never displayed.
export const CONTROLLED_REQUIRED_PATHS = [
  "required",
  "required.primaryCategoryKeys",
  "required.independentlyPurchasableServiceKeys",
  "required.serviceModes",
  "required.basedIn.countryCode",
  "required.basedIn.region",
  "required.basedIn.city",
  "required.serviceArea.countryCode",
  "required.serviceArea.region",
  "required.serviceArea.city",
] as const;

export type ControlledRequiredPath = (typeof CONTROLLED_REQUIRED_PATHS)[number];

// True when `path` is consumed by an actual renderer in the
// required-filters panel. Returns false for any other path so the
// page renders it in the global panel.
//
// A prefix match (`path.startsWith(`${prefix}.`)`) is used for the
// control-level paths so nested errors under the same control (for
// example `required.primaryCategoryKeys.0`) still belong to the
// same control. The section-level `required` path uses exact match
// so it does NOT also claim `required.anything` — unconsumed nested
// paths must fall through to the global panel.
export function isControlledRequiredPath(path: string): boolean {
  return CONTROLLED_REQUIRED_PATHS.some(
    (prefix) => path === prefix || (prefix !== "required" && path.startsWith(`${prefix}.`)),
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
