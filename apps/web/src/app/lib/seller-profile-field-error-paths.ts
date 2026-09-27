// Single source of truth for which seller-profile field-error
// paths the editor renders beside their controls vs. in the
// global error summary.
//
// Mirrors the pattern at apps/web/src/app/lib/field-error-paths.ts
// (the search/required-filters surface). The editor renders
// errors for the controlled paths inline; everything else
// (unconsumed paths) falls through to the global `ErrorSummary`.

export const SELLER_PROFILE_CONTROLLED_PATHS = [
  "identity.professionalName",
  "identity.bio",
  "basedIn.countryCode",
  "basedIn.region",
  "basedIn.city",
  "disciplines.specialtyKeys",
  "disciplines.caribbeanAffiliationCodes",
  "publication.confirmation",
] as const;

export type SellerProfileControlledPath = (typeof SELLER_PROFILE_CONTROLLED_PATHS)[number];

export function isSellerProfileControlledPath(path: string): boolean {
  return SELLER_PROFILE_CONTROLLED_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  );
}

export interface SellerProfileFieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export function partitionSellerProfileFieldErrors<T extends SellerProfileFieldError>(
  errors: readonly T[],
): { readonly controlled: readonly T[]; readonly unmatched: readonly T[] } {
  const controlled: T[] = [];
  const unmatched: T[] = [];
  for (const err of errors) {
    if (isSellerProfileControlledPath(err.path)) controlled.push(err);
    else unmatched.push(err);
  }
  return { controlled, unmatched };
}
