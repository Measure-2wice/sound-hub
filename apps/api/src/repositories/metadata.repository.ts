// Repository abstraction for the public metadata seam.
//
// The M1.4 metadata route returns the canonical category catalog so the
// browser can populate its required-filter selects without holding a
// second, independently deployable list. M2 (#84) extends the seam
// with `getCanonicalSpecialties` and `getCanonicalCaribbeanAffiliationCodes`
// so the Professional Profile editor and publication review can populate
// their controlled-value pickers from the same canonical source.
//
// Per the contract, the repository owns Prisma queries and the route is
// responsible only for HTTP concerns and safe error mapping. This module
// defines the application-layer surface; the Prisma adapter lives next
// to it.

export interface RepositoryCategoryMetadata {
  readonly key: string;
  readonly name: string;
}

export interface RepositorySpecialtyMetadata {
  readonly key: string;
  readonly name: string;
}

export interface RepositoryCaribbeanAffiliationMetadata {
  readonly code: string;
  readonly name: string;
}

export interface MetadataRepository {
  // Return the canonical category catalog allow-list-mapped from the
  // database. The repository is the only place that reads the keys;
  // the route maps the records through the shared metadata response
  // schema before serializing.
  getCanonicalCategories(): Promise<readonly RepositoryCategoryMetadata[]>;

  // M2 (#84): return the canonical Specialty catalog ordered by
  // `key` (NOT by `id`). The repository is the only place that reads
  // the Specialty table; the route maps the records through the
  // shared metadata response schema before serializing.
  getCanonicalSpecialties(): Promise<readonly RepositorySpecialtyMetadata[]>;

  // M2 (#84): return the closed Caribbean affiliation code list with
  // display names. The codes are sourced from the closed
  // SUPPORTED_CARIBBEAN_AFFILIATION_CODES const in @soundhub/types;
  // the display names are sourced from the closed
  // SUPPORTED_CARIBBEAN_AFFILIATION_NAMES const in the same package.
  // The repository joins the two closed lists and returns the pair;
  // the route maps the records through the shared metadata response
  // schema before serializing.
  getCanonicalCaribbeanAffiliationCodes(): Promise<
    readonly RepositoryCaribbeanAffiliationMetadata[]
  >;
}
