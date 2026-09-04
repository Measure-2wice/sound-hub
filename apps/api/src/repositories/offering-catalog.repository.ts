// Repository abstraction for the canonical offering catalog seam.
//
// Background: ticket #61 introduces the seller management UI which
// needs a public canonical list of eligible seller/offering tuples
// so the page does not duplicate the seed. The buyer already trusts
// the canonical list — the search results emit the same shape. Per
// the Standards review, the catalog read/filter lives in this
// repository; the route is responsible only for HTTP concerns and
// safe error mapping.

export interface RepositoryOfferingSummary {
  readonly offeringId: string;
  readonly title: string;
  readonly status: string;
}

export interface RepositorySellerSummary {
  readonly sellerId: string;
  readonly professionalName: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly offerings: readonly RepositoryOfferingSummary[];
}

export interface OfferingCatalogRepository {
  /**
   * Return the canonical seller + offering catalog filtered to
   * eligible (Published profile + Active Workspace + Active
   * offering) tuples. The repository owns the eligibility filter;
   * the route maps the records through the public response shape.
   */
  getCanonicalCatalog(): Promise<readonly RepositorySellerSummary[]>;
}
