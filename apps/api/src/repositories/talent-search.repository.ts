// Repository abstraction for the M1 TalentSearchService.
//
// The interface and the internal candidate contract are application-layer
// concerns and live in @soundhub/api per the plan's ownership split. The
// Prisma adapter (apps/api/src/repositories/prisma-talent-search.repository.ts)
// and the in-memory adapter (used by service-level unit tests) both implement
// this interface. Public DTOs are mapped at the service layer; the repository
// never returns Prisma models to the public contract.

import type {
  ServiceMode,
  PricingKind,
  SellerProfileStatus,
  ServiceOfferingStatus,
} from "@soundhub/db";

export interface RepositoryLocation {
  readonly city: string | null;
  readonly region: string | null;
  readonly countryCode: string;
}

export interface RepositoryPrimaryCategory {
  readonly key: string;
  readonly name: string;
}

export interface RepositoryPricing {
  readonly kind: PricingKind;
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
  readonly status: ServiceOfferingStatus;
  readonly serviceMode: ServiceMode;
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
  readonly status: SellerProfileStatus;
  readonly basedInCity: string | null;
  readonly basedInRegion: string | null;
  readonly basedInCountryCode: string;
  readonly avatarUrl: string | null;
  readonly specialtyKeys: readonly string[];
  readonly caribbeanAffiliationCodes: readonly string[];
  readonly offerings: readonly RepositoryCandidateOffering[];
}

export interface RepositorySearchInput {
  // Empty means "any". The service is responsible for normalizing and applying
  // required vs preferred semantics; the repository only fetches the eligible
  // candidate set.
  readonly serviceModes: readonly ServiceMode[];
  readonly basedInCountryCodes: readonly string[];
  readonly serviceAreaCountryCodes: readonly string[];
  readonly primaryCategoryKeys: readonly string[];
  readonly caribbeanAffiliationCodes: readonly string[];
}

export interface TalentSearchRepository {
  search(input: RepositorySearchInput): Promise<readonly RepositoryCandidateSeller[]>;
}
