// Prisma implementation of MetadataRepository.
//
// This is the only place in the application that issues Prisma queries
// against the ServiceCategory table for the public metadata seam. The
// route depends on the interface so the HTTP layer never reaches into
// Prisma directly, satisfying the contract rule that routes never
// query Prisma.

import { type PrismaClient } from "@soundhub/db";
import type { MetadataRepository, RepositoryCategoryMetadata } from "./metadata.repository.js";

export class PrismaMetadataRepository implements MetadataRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getCanonicalCategories(): Promise<readonly RepositoryCategoryMetadata[]> {
    const rows = await this.prisma.serviceCategory.findMany({
      orderBy: [{ id: "asc" }],
      select: { key: true, name: true },
    });
    return rows.map((row) => ({ key: row.key, name: row.name }));
  }
}
