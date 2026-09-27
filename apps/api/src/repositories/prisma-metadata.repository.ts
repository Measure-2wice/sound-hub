// Prisma implementation of MetadataRepository.
//
// This is the only place in the application that issues Prisma queries
// against the ServiceCategory / Specialty tables for the public
// metadata seam. The route depends on the interface so the HTTP layer
// never reaches into Prisma directly, satisfying the contract rule
// that routes never query Prisma.

import { type PrismaClient } from "@soundhub/db";
import {
  SUPPORTED_CARIBBEAN_AFFILIATION_CODES,
  SUPPORTED_CARIBBEAN_AFFILIATION_NAMES,
} from "@soundhub/types";
import type {
  MetadataRepository,
  RepositoryCaribbeanAffiliationMetadata,
  RepositoryCategoryMetadata,
  RepositorySpecialtyMetadata,
} from "./metadata.repository.js";

export class PrismaMetadataRepository implements MetadataRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getCanonicalCategories(): Promise<readonly RepositoryCategoryMetadata[]> {
    const rows = await this.prisma.serviceCategory.findMany({
      orderBy: [{ id: "asc" }],
      select: { key: true, name: true },
    });
    return rows.map((row) => ({ key: row.key, name: row.name }));
  }

  async getCanonicalSpecialties(): Promise<readonly RepositorySpecialtyMetadata[]> {
    const rows = await this.prisma.specialty.findMany({
      orderBy: [{ key: "asc" }],
      select: { key: true, name: true },
    });
    return rows.map((row) => ({ key: row.key, name: row.name }));
  }

  getCanonicalCaribbeanAffiliationCodes(): Promise<
    readonly RepositoryCaribbeanAffiliationMetadata[]
  > {
    // Closed-list join — no DB read. Mirrors the Prisma adapter
    // pattern for closed enums (the const is the source of truth;
    // the repository is the application-layer boundary).
    const namesByCode = new Map(
      SUPPORTED_CARIBBEAN_AFFILIATION_NAMES.map((entry) => [entry.code, entry.name]),
    );
    return Promise.resolve(
      SUPPORTED_CARIBBEAN_AFFILIATION_CODES.map((code) => ({
        code,
        name: namesByCode.get(code) ?? code,
      })),
    );
  }
}
