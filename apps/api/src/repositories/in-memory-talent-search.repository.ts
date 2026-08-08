// In-memory implementation of TalentSearchRepository for service-level unit
// tests. Mirrors the eligibility rules of the Prisma adapter so the service
// can be exercised deterministically without a database.

import { SellerProfileStatus, ServiceOfferingStatus, WorkspaceStatus } from "@soundhub/db";
import type {
  RepositoryCandidateOffering,
  RepositoryCandidateSeller,
  RepositorySearchInput,
  TalentSearchRepository,
} from "./talent-search.repository.js";

export interface InMemoryFixture {
  sellers: InMemorySeller[];
}

export interface InMemorySeller {
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
  readonly workspaceStatus: WorkspaceStatus;
  readonly workspaceHasSellerCapability: boolean;
  readonly offerings: readonly InMemoryOffering[];
}

export interface InMemoryOffering {
  readonly offeringId: string;
  readonly title: string;
  readonly description: string;
  readonly status: ServiceOfferingStatus;
  readonly serviceMode: "Remote" | "InPerson" | "Hybrid";
  readonly primaryCategory: { key: string; name: string };
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

  private isEligible(seller: InMemorySeller, input: RepositorySearchInput): boolean {
    if (seller.status !== SellerProfileStatus.Published) return false;
    if (seller.workspaceStatus !== WorkspaceStatus.Active) return false;
    if (!seller.workspaceHasSellerCapability) return false;
    if (
      input.basedInCountryCodes.length > 0 &&
      !input.basedInCountryCodes.includes(seller.basedInCountryCode)
    ) {
      return false;
    }
    if (
      input.caribbeanAffiliationCodes.length > 0 &&
      !seller.caribbeanAffiliationCodes.some((code) =>
        input.caribbeanAffiliationCodes.includes(code),
      )
    ) {
      return false;
    }
    const hasEligibleOffering = seller.offerings.some((offering) =>
      this.isOfferingEligible(offering, input),
    );
    return hasEligibleOffering;
  }

  private isOfferingEligible(offering: InMemoryOffering, input: RepositorySearchInput): boolean {
    if (offering.status !== ServiceOfferingStatus.Active) return false;
    if (input.serviceModes.length > 0 && !input.serviceModes.includes(offering.serviceMode)) {
      return false;
    }
    if (
      input.primaryCategoryKeys.length > 0 &&
      !input.primaryCategoryKeys.includes(offering.primaryCategory.key)
    ) {
      return false;
    }
    if (
      input.serviceAreaCountryCodes.length > 0 &&
      !offering.serviceAreas.some((area) =>
        input.serviceAreaCountryCodes.includes(area.countryCode),
      )
    ) {
      return false;
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
        primaryCategory: { key: offering.primaryCategory.key, name: offering.primaryCategory.name },
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
