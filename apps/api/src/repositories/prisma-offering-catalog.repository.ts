// Prisma adapter for the canonical offering catalog repository.
//
// Background: per ticket #61 follow-up Standards review (P2-001),
// the catalog read/filter moves into the repository seam; the route
// is responsible only for HTTP handling and the validated allow-
// listed output.

import {
  SellerProfileStatus,
  ServiceOfferingStatus,
  WorkspaceStatus,
  type PrismaClient,
} from "@soundhub/db";
import type {
  OfferingCatalogRepository,
  RepositorySellerSummary,
} from "./offering-catalog.repository.js";

export class PrismaOfferingCatalogRepository implements OfferingCatalogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getCanonicalCatalog(): Promise<readonly RepositorySellerSummary[]> {
    const profiles = await this.prisma.sellerProfile.findMany({
      where: {
        status: SellerProfileStatus.Published,
        workspace: { is: { status: WorkspaceStatus.Active } },
      },
      include: {
        workspace: true,
        offerings: {
          orderBy: [{ id: "asc" }],
        },
      },
      orderBy: [{ id: "asc" }],
    });
    return profiles.map((profile) => ({
      sellerId: profile.id,
      professionalName: profile.professionalName,
      workspaceId: profile.workspaceId,
      workspaceName: profile.workspace.name,
      offerings: profile.offerings
        .filter((offering) => offering.status === ServiceOfferingStatus.Active)
        .map((offering) => ({
          offeringId: offering.id,
          title: offering.title,
          status: offering.status,
        })),
    }));
  }
}
