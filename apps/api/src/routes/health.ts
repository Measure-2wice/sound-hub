import { Router } from "express";

export const healthRoutes: Router = Router();

healthRoutes.get("/", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "SoundHub API",
    version: "0.1.0",
    environment: process.env.NODE_ENV ?? "development",
  });
});

healthRoutes.get("/ready", (req, res) => {
  // Milestone 1 has no external runtime dependencies beyond PostgreSQL.
  // The readiness probe reports the bare service state; deeper dependency
  // probes belong to a later observability milestone.
  res.json({
    status: "ready",
    timestamp: new Date().toISOString(),
    service: "SoundHub API",
    version: "0.1.0",
    environment: process.env.NODE_ENV ?? "development",
  });
});
