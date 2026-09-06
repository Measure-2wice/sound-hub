// Prisma client factory and generated type re-exports for the Milestone 1
// foundation. This package exposes the canonical Prisma client and the
// generated Prisma types only. The TalentSearchRepository interface and the
// service-layer DTOs live in @soundhub/api per the plan's ownership split.
//
// BG7 also re-exports the canonical audio-sample fixture constants from
// the prisma/ folder so the storage adapter (apps/api) can recognize
// the single canonical BG7 fixture row and hydrate its bytes on first
// playback. The fixture is a seed/UI concern; the re-export keeps
// `apps/api` from importing from `packages/db/prisma/` directly.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

export type { PrismaClient } from "./generated/client.js";
export { Prisma } from "./generated/client.js";
export * from "./generated/enums.js";

export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to create a Prisma client");
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

// BG7 fixture re-exports. The fixture bytes are produced by the same
// header the existing `mp3FrameBytes()` test helper emits, so any code
// path that validates MPEG-1 Layer III accepts the bytes unchanged.
// Importing this from `@soundhub/db` keeps the prisma folder internal
// to the package and lets apps/api depend on a single package surface.
export {
  buildDeterministicMp3Fixture,
  BG7_FIXTURE_OFFERING_ID,
  BG7_FIXTURE_STORAGE_REF,
  BG7_FIXTURE_LABEL,
} from "./audio-sample-fixture.js";
