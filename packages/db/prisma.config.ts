import "dotenv/config";
import { defineConfig, env } from "prisma/config";

function resolveDatabaseUrl(): string {
  try {
    return env("DATABASE_URL");
  } catch {
    // Prisma Client generation does not require a live database or connection string.
    return "postgresql://localhost/soundhub_unconfigured";
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Commands that access PostgreSQL will report a connection error until DATABASE_URL
    // is configured; generation can safely use the fallback URL.
    url: resolveDatabaseUrl(),
  },
});
