// Prisma client factory and generated type re-exports for the Milestone 1
// foundation. This package exposes the canonical Prisma client and the
// generated Prisma types only. The TalentSearchRepository interface and the
// service-layer DTOs live in @soundhub/api per the plan's ownership split.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

export type { PrismaClient, Prisma } from "./generated/client.js";
export * from "./generated/enums.js";

export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to create a Prisma client");
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
