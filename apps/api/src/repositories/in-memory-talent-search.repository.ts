// In-memory implementation of TalentSearchRepository for service-level unit
// tests. Mirrors the eligibility rules of the Prisma adapter so the service
// can be exercised deterministically without a database.

import {
  type SellerProfileStatusV1,
  type ServiceOfferingStatusV1,
  type WorkspaceStatusV1,
} from "@soundhub/types";
import type {
  RepositoryCandidateOffering,
  RepositoryCandidateSeller,
  RepositoryControlledKeys,
  RepositorySearchInput,
  TalentSearchRepository,
} from "./talent-search.repository.js";

export interface InMemoryFixture {
  sellers: InMemorySeller[];
  /**
   * The canonical set of controlled keys this in-memory adapter
   * considers valid. In production these come from the PostgreSQL
   * seed via the Prisma adapter; the in-memory adapter accepts an
   * explicit set so the service can validate against the same
   * controlled-key surface in unit tests.
   */
  readonly controlledKeys?: {
    readonly serviceCategoryKeys: readonly string[];
    readonly specialtyKeys: readonly string[];
    readonly pricingUnitKeys: readonly string[];
  };
}

export interface InMemorySeller {
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
  readonly workspaceStatus: WorkspaceStatusV1;
  readonly workspaceHasSellerCapability: boolean;
  readonly offerings: readonly InMemoryOffering[];
}

export interface InMemoryOffering {
  readonly offeringId: string;
  readonly title: string;
  readonly description: string;
  readonly status: ServiceOfferingStatusV1;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid";
  readonly primaryCategory: { key: string; name: string; bundleOnly: boolean };
  readonly includedServices: readonly { key: string; name: string; purchaseMode: "BundleOnly" }[];
  readonly genreTags: readonly string[];
  readonly serviceAreas: readonly {
    city: string | null;
    region: string | null;
    countryCode: string;
  }[];
  readonly pricing: {
    kind: "StartingAt" | "Fixed" | "ContactForQuote";
    amountMinor: number | null;
    currency: string | null;
    unitKey: string | null;
  } | null;
}

export class InMemoryTalentSearchRepository implements TalentSearchRepository {
  constructor(private readonly fixture: InMemoryFixture) {}

  async search(input: RepositorySearchInput): Promise<readonly RepositoryCandidateSeller[]> {
    // The async signature is required by the interface; the in-memory
    // implementation is fully synchronous.
    await Promise.resolve();
    return this.fixture.sellers
      .filter((seller) => this.isEligible(seller, input))
      .map((seller) => this.toCandidate(seller, input))
      .sort((a, b) => a.sellerId.localeCompare(b.sellerId));
  }

  async getControlledKeys(): Promise<RepositoryControlledKeys> {
    await Promise.resolve();
    const controlled = this.fixture.controlledKeys;
    if (!controlled) {
      throw new Error(
        "InMemoryTalentSearchRepository requires fixture.controlledKeys to be set",
      );
    }
    return {
      serviceCategoryKeys: new Set(controlled.serviceCategoryKeys),
      specialtyKeys: new Set(controlled.specialtyKeys),
      pricingUnitKeys: new Set(controlled.pricingUnitKeys),
    };
  }

  private isEligible(seller: InMemorySeller, input: RepositorySearchInput): boolean {
    if (seller.status !== "Published") return false;
    if (seller.workspaceStatus !== "Active") return false;
    if (!seller.workspaceHasSellerCapability) return false;
    if (input.basedIn?.countryCode && seller.basedInCountryCode !== input.basedIn.countryCode) {
      return false;
    }
    if (
      input.basedIn?.city &&
      seller.basedInCity?.toLowerCase() !== input.basedIn.city.toLowerCase()
    ) {
      return false;
    }
    if (
      input.basedIn?.region &&
      seller.basedInRegion?.toLowerCase() !== input.basedIn.region.toLowerCase()
    ) {
      return false;
    }
    const hasEligibleOffering = seller.offerings.some((offering) =>
      this.isOfferingEligible(offering, input),
    );
    return hasEligibleOffering;
  }

  private isOfferingEligible(offering: InMemoryOffering, input: RepositorySearchInput): boolean {
    if (offering.status !== "Active") return false;
    if (input.serviceModes.length > 0 && !input.serviceModes.includes(offering.serviceMode)) {
      return false;
    }
    if (
      input.primaryCategoryKeys.length > 0 &&
      !input.primaryCategoryKeys.includes(offering.primaryCategory.key)
    ) {
      return false;
    }
    if (input.independentlyPurchasableServiceKeys.length > 0) {
      if (offering.primaryCategory.bundleOnly) return false;
      if (!input.independentlyPurchasableServiceKeys.includes(offering.primaryCategory.key)) {
        return false;
      }
    }
    if (input.serviceArea !== null) {
      const matches = offering.serviceAreas.some((area) => {
        if (input.serviceArea!.countryCode && area.countryCode !== input.serviceArea!.countryCode) {
          return false;
        }
        if (
          input.serviceArea!.city &&
          area.city?.toLowerCase() !== input.serviceArea!.city.toLowerCase()
        ) {
          return false;
        }
        if (
          input.serviceArea!.region &&
          area.region?.toLowerCase() !== input.serviceArea!.region.toLowerCase()
        ) {
          return false;
        }
        return true;
      });
      if (!matches) return false;
    }
    return true;
  }

  private toCandidate(
    seller: InMemorySeller,
    input: RepositorySearchInput,
  ): RepositoryCandidateSeller {
    const offerings: readonly RepositoryCandidateOffering[] = seller.offerings
      .filter((offering) => this.isOfferingEligible(offering, input))
      .map((offering) => ({
        offeringId: offering.offeringId,
        sellerId: seller.sellerId,
        title: offering.title,
        description: offering.description,
        status: offering.status,
        serviceMode: offering.serviceMode,
        primaryCategory: { ...offering.primaryCategory },
        includedServices: offering.includedServices.map((included) => ({ ...included })),
        genreTags: [...offering.genreTags],
        serviceAreas: offering.serviceAreas.map((area) => ({ ...area })),
        pricing: offering.pricing ? { ...offering.pricing } : null,
      }));
    return {
      sellerId: seller.sellerId,
      workspaceId: seller.workspaceId,
      professionalName: seller.professionalName,
      bio: seller.bio,
      status: seller.status,
      basedInCity: seller.basedInCity,
      basedInRegion: seller.basedInRegion,
      basedInCountryCode: seller.basedInCountryCode,
      avatarUrl: seller.avatarUrl,
      specialtyKeys: [...seller.specialtyKeys],
      caribbeanAffiliationCodes: [...seller.caribbeanAffiliationCodes],
      offerings,
    };
  }
}
