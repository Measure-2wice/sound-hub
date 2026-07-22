export { PrismaClient } from "../dist/generated/index.js";
export type * from "../dist/generated/index.js";

// Re-export types from the shared types package
export type {
  UUID,
  ISODateString,
  Role,
  Money,
  IUser,
  IProducerProfile,
  IMusicTrack,
  IQueryResponse,
  createUUID,
  createISODateString
} from "@soundhub/types";