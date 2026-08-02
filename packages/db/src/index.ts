import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

export type * from "./generated/client.js";

export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to create a Prisma client");
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

// Re-export types from the shared types package
export type {
  UUID,
  ISODateString,
  Role,
  Money,
  IUser,
  IProducerProfile,
  PublicProducerProfile,
  IMusicTrack,
  IQueryResponse,
} from "@soundhub/types";

export { createUUID, createISODateString } from "@soundhub/types";
