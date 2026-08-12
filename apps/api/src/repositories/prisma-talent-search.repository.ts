// Prisma implementation of TalentSearchRepository.
//
// This is the only place in the application that issues search Prisma queries
// for the TalentSearchService. The service depends on the interface, so it
// can be exercised with the in-memory adapter for unit tests and exercised
// end-to-end with this adapter for repository integration tests.
//
// Required constraints are applied via Prisma `where` clauses where they
// reduce the candidate set before any rows are materialised. Per-offering
// filters (primaryCategoryKeys, serviceModes, serviceArea) are also
// applied in `toCandidate` to keep eligibility logic symmetric with the
// in-memory adapter.

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
  RepositoryControlledKeys,
  RepositorySearchInput,
  TalentSearchRepository,
} from "./talent-search.repository.js";
import type { SellerProfileStatusV1, ServiceOfferingStatusV1 } from "@soundhub/types";
void (null as unknown as SellerProfileStatusV1 | ServiceOfferingStatusV1);

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
      where: this.buildSellerWhere(input),
      include: sellerProfileInclude,
      orderBy: [{ id: "asc" }],
    });

    return sellers
      .map((seller) => this.toCandidate(seller, input))
      .filter((seller) => seller.offerings.length > 0);
  }

  async getControlledKeys(): Promise<RepositoryControlledKeys> {
    const [categories, specialties, pricingUnits] = await Promise.all([
      this.prisma.serviceCategory.findMany({ select: { key: true } }),
      this.prisma.specialty.findMany({ select: { key: true } }),
      this.prisma.pricingUnit.findMany({ select: { key: true } }),
    ]);
    return {
      serviceCategoryKeys: new Set(categories.map((c) => c.key)),
      specialtyKeys: new Set(specialties.map((s) => s.key)),
      pricingUnitKeys: new Set(pricingUnits.map((u) => u.key)),
    };
  }

  private buildSellerWhere(input: RepositorySearchInput): Prisma.SellerProfileWhereInput {
    const workspaceWhere: Prisma.WorkspaceWhereInput = {
      status: WorkspaceStatus.Active,
      capabilities: { some: { capability: MarketplaceCapability.Seller } },
    };
    if (input.basedIn?.countryCode) {
      workspaceWhere.sellerProfile = {
        basedInCountryCode: input.basedIn.countryCode,
      };
    }

    return {
      status: SellerProfileStatus.Published,
      workspace: { is: workspaceWhere },
    };
  }

  private toCandidate(
    seller: SellerWithRelations,
    input: RepositorySearchInput,
  ): RepositoryCandidateSeller {
    // Hard eligibility first: basedIn city/region must match if provided.
    if (!matchesLocation(seller.basedInCity, seller.basedInRegion, input.basedIn)) {
      return { ...emptyCandidate(seller), offerings: [] };
    }

    const offerings = seller.offerings
      .filter((offering) => offering.status === ServiceOfferingStatus.Active)
      // Hard eligibility: primaryCategory must be a non-bundle-only
      // independently purchasable category, and only then is it eligible
      // for the `independentlyPurchasableServiceKeys` filter.
      .filter((offering) => {
        if (input.independentlyPurchasableServiceKeys.length === 0) return true;
        return (
          !offering.primaryCategory.bundleOnly &&
          input.independentlyPurchasableServiceKeys.includes(offering.primaryCategory.key)
        );
      })
      .filter((offering) =>
        input.primaryCategoryKeys.length === 0
          ? true
          : input.primaryCategoryKeys.includes(offering.primaryCategory.key),
      )
      .filter((offering) =>
        input.serviceModes.length === 0 ? true : input.serviceModes.includes(offering.serviceMode),
      )
      .filter((offering) => matchesAnyServiceArea(offering.serviceAreas, input.serviceArea))
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
            bundleOnly: offering.primaryCategory.bundleOnly,
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

function emptyCandidate(seller: SellerWithRelations): Omit<RepositoryCandidateSeller, "offerings"> {
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
  };
}

function normalize(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toLowerCase();
}

function matchesLocation(
  city: string | null,
  region: string | null,
  filter: RepositorySearchInput["basedIn"],
): boolean {
  if (filter === null) return true;
  if (filter.countryCode !== null) {
    // Country code is enforced at the Prisma workspace filter; the seller
    // must have already been filtered to the right country. Skip the
    // string comparison.
  } else {
    if (filter.city === null && filter.region === null) {
      return true;
    }
  }
  if (filter.city !== null) {
    if (normalize(city) !== filter.city.toLowerCase()) return false;
  }
  if (filter.region !== null) {
    if (normalize(region) !== filter.region.toLowerCase()) return false;
  }
  return true;
}

function matchesAnyServiceArea(
  areas: ReadonlyArray<{ city: string | null; region: string | null; countryCode: string }>,
  filter: RepositorySearchInput["serviceArea"],
): boolean {
  if (filter === null) return true;
  for (const area of areas) {
    let match = true;
    if (filter.countryCode !== null && area.countryCode !== filter.countryCode) {
      match = false;
    }
    if (match && filter.city !== null && normalize(area.city) !== filter.city.toLowerCase()) {
      match = false;
    }
    if (match && filter.region !== null && normalize(area.region) !== filter.region.toLowerCase()) {
      match = false;
    }
    if (match) return true;
  }
  return false;
}
