// Repository abstraction for the M1 TalentSearchService.
//
// The interface and the internal candidate contract are application-layer
// concerns and live in @soundhub/api per the plan's ownership split. The
// Prisma adapter (apps/api/src/repositories/prisma-talent-search.repository.ts)
// and the in-memory adapter (used by service-level unit tests) both implement
// this interface. Public DTOs are mapped at the service layer; the repository
// never returns Prisma models to the public contract.

import type {
  PricingKindV1,
  SellerProfileStatusV1,
  ServiceOfferingStatusV1,
  ServiceModeV1,
} from "@soundhub/types";

export interface RepositoryLocation {
  readonly city: string | null;
  readonly region: string | null;
  readonly countryCode: string;
}

export interface RepositoryLocationFilter {
  readonly city: string | null;
  readonly region: string | null;
  readonly countryCode: string | null;
}

export interface RepositoryPrimaryCategory {
  readonly key: string;
  readonly name: string;
  readonly bundleOnly: boolean;
}

export interface RepositoryPricing {
  readonly kind: PricingKindV1;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly unitKey: string | null;
}

export interface RepositoryServiceArea {
  readonly city: string | null;
  readonly region: string | null;
  readonly countryCode: string;
}

export interface RepositoryIncludedService {
  readonly key: string;
  readonly name: string;
  readonly purchaseMode: "BundleOnly";
}

export interface RepositoryCandidateOffering {
  readonly offeringId: string;
  readonly sellerId: string;
  readonly title: string;
  readonly description: string;
  readonly status: ServiceOfferingStatusV1;
  readonly serviceMode: ServiceModeV1;
  readonly primaryCategory: RepositoryPrimaryCategory;
  readonly includedServices: readonly RepositoryIncludedService[];
  readonly genreTags: readonly string[];
  readonly serviceAreas: readonly RepositoryServiceArea[];
  readonly pricing: RepositoryPricing | null;
}

export interface RepositoryCandidateSeller {
  readonly sellerId: string;
  readonly workspaceId: string;
  readonly professionalName: string;
  readonly bio: string;
  readonly status: SellerProfileStatusV1;
  readonly basedInCity: string | null;
  readonly basedInRegion: string | null;
  readonly basedInCountryCode: string;
  readonly avatarUrl: string | null;
  readonly specialtyKeys: readonly string[];
  readonly caribbeanAffiliationCodes: readonly string[];
  readonly offerings: readonly RepositoryCandidateOffering[];
}

// RepositorySearchInput carries every required constraint that the service
// applies. Required constraints are exclusionary; preferred constraints
// never reach the repository and only influence ranking, which is owned
// by issue #6.
export interface RepositorySearchInput {
  readonly serviceModes: readonly ServiceModeV1[];
  readonly primaryCategoryKeys: readonly string[];
  readonly independentlyPurchasableServiceKeys: readonly string[];
  readonly basedIn: RepositoryLocationFilter | null;
  readonly serviceArea: RepositoryLocationFilter | null;
}

// Controlled canonical keys resolved from the database. The PostgreSQL
// seed is the canonical source; the repository is the only place that
// reads the keys, and the service uses them to validate stable-key
// fields exposed by the v1 request before executing search.
export interface RepositoryControlledKeys {
  readonly serviceCategoryKeys: ReadonlySet<string>;
  readonly specialtyKeys: ReadonlySet<string>;
  readonly pricingUnitKeys: ReadonlySet<string>;
}

export interface TalentSearchRepository {
  search(input: RepositorySearchInput): Promise<readonly RepositoryCandidateSeller[]>;
  getControlledKeys(): Promise<RepositoryControlledKeys>;
}
