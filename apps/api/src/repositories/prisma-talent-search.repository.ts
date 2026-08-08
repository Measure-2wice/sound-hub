// Prisma implementation of TalentSearchRepository.
//
// This is the only place in the application that issues search Prisma queries
// for the TalentSearchService. The service depends on the interface, so it
// can be exercised with the in-memory adapter for unit tests and exercised
// end-to-end with this adapter for repository integration tests.
//
// Filters are applied in two stages:
//   1. Prisma `where` clauses for hard, indexed filters (status, workspace
//      status, capability, basedIn, Caribbean affiliation). These reduce
//      the candidate set before any rows are materialised.
//   2. Application-level filters in `toCandidate` for criteria that apply
//      per-offering and that we want to evaluate uniformly with the
//      in-memory adapter (service mode, primary category key, service area).
//      This keeps the contract test surface symmetric across adapters.

import {
  type Prisma,
  type PrismaClient,
  MarketplaceCapability,
  SellerProfileStatus,
  ServiceOfferingStatus,
  WorkspaceStatus,
} from "@soundhub/db";
import type {
  RepositoryCandidateOffering,
  RepositoryCandidateSeller,
  RepositorySearchInput,
  TalentSearchRepository,
} from "./talent-search.repository.js";

const sellerProfileInclude = {
  workspace: true,
  specialties: { include: { specialty: true } },
  caribbeanAffiliations: true,
  offerings: {
    include: {
      primaryCategory: true,
      includedServices: { include: { category: true } },
      serviceAreas: true,
      pricing: { include: { unit: true } },
    },
    orderBy: [{ id: "asc" }],
  },
} satisfies Prisma.SellerProfileInclude;

type SellerWithRelations = Prisma.SellerProfileGetPayload<{
  include: typeof sellerProfileInclude;
}>;

export class PrismaTalentSearchRepository implements TalentSearchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async search(input: RepositorySearchInput): Promise<readonly RepositoryCandidateSeller[]> {
    const sellers = await this.prisma.sellerProfile.findMany({
      where: {
        status: SellerProfileStatus.Published,
        workspace: {
          is: {
            status: WorkspaceStatus.Active,
            capabilities: { some: { capability: MarketplaceCapability.Seller } },
            ...(input.basedInCountryCodes.length > 0
              ? { sellerProfile: { basedInCountryCode: { in: [...input.basedInCountryCodes] } } }
              : {}),
          },
        },
        ...(input.caribbeanAffiliationCodes.length > 0
          ? {
              caribbeanAffiliations: {
                some: { countryCode: { in: [...input.caribbeanAffiliationCodes] } },
              },
            }
          : {}),
      },
      include: sellerProfileInclude,
      orderBy: [{ id: "asc" }],
    });

    return sellers
      .map((seller) => this.toCandidate(seller, input))
      .filter((seller) => seller.offerings.length > 0);
  }

  private toCandidate(
    seller: SellerWithRelations,
    input: RepositorySearchInput,
  ): RepositoryCandidateSeller {
    const offerings = seller.offerings
      .filter((offering) => offering.status === ServiceOfferingStatus.Active)
      .filter((offering) =>
        input.primaryCategoryKeys.length === 0
          ? true
          : input.primaryCategoryKeys.includes(offering.primaryCategory.key),
      )
      .filter((offering) =>
        input.serviceModes.length === 0 ? true : input.serviceModes.includes(offering.serviceMode),
      )
      .filter((offering) =>
        input.serviceAreaCountryCodes.length === 0
          ? true
          : offering.serviceAreas.some((area) =>
              input.serviceAreaCountryCodes.includes(area.countryCode),
            ),
      )
      .map(
        (offering): RepositoryCandidateOffering => ({
          offeringId: offering.id,
          sellerId: seller.id,
          title: offering.title,
          description: offering.description,
          status: offering.status,
          serviceMode: offering.serviceMode,
          primaryCategory: {
            key: offering.primaryCategory.key,
            name: offering.primaryCategory.name,
          },
          includedServices: offering.includedServices.map((included) => ({
            key: included.category.key,
            name: included.category.name,
            purchaseMode: "BundleOnly" as const,
          })),
          genreTags: offering.genreTags,
          serviceAreas: offering.serviceAreas.map((area) => ({
            city: area.city,
            region: area.region,
            countryCode: area.countryCode,
          })),
          pricing: offering.pricing
            ? {
                kind: offering.pricing.kind,
                amountMinor: offering.pricing.amountMinor,
                currency: offering.pricing.currency,
                unitKey: offering.pricing.unit?.key ?? null,
              }
            : null,
        }),
      );

    return {
      sellerId: seller.id,
      workspaceId: seller.workspaceId,
      professionalName: seller.professionalName,
      bio: seller.bio,
      status: seller.status,
      basedInCity: seller.basedInCity,
      basedInRegion: seller.basedInRegion,
      basedInCountryCode: seller.basedInCountryCode,
      avatarUrl: seller.avatarUrl,
      specialtyKeys: seller.specialties.map((row) => row.specialty.key),
      caribbeanAffiliationCodes: seller.caribbeanAffiliations.map((row) => row.countryCode),
      offerings,
    };
  }
}
