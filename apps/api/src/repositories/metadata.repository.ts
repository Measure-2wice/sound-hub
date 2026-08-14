// Repository abstraction for the public metadata seam.
//
// The M1.4 metadata route returns the canonical category catalog so the
// browser can populate its required-filter selects without holding a
// second, independently deployable list. Per the contract, the
// repository owns Prisma queries and the route is responsible only for
// HTTP concerns and safe error mapping. This module defines the
// application-layer surface; the Prisma adapter lives next to it.

export interface RepositoryCategoryMetadata {
  readonly key: string;
  readonly name: string;
}

export interface MetadataRepository {
  // Return the canonical category catalog allow-list-mapped from the
  // database. The repository is the only place that reads the keys;
  // the route maps the records through the shared metadata response
  // schema before serializing.
  getCanonicalCategories(): Promise<readonly RepositoryCategoryMetadata[]>;
}
