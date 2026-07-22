import { Router } from "express";

export const healthRoutes = Router();

healthRoutes.get("/", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "SoundHub API",
    version: "0.1.0",
    environment: process.env.NODE_ENV || "development",
  });
});

healthRoutes.get("/ready", (req, res) => {
  // In a real app, you'd check database connectivity, etc.
  res.json({
    status: "ready",
    timestamp: new Date().toISOString(),
    checks: {
      database: "ok", // Would check actual DB connection
      ai_service: "ok", // Would check OpenAI API
      vector_db: "ok", // Would check Pinecone connection
    },
  });
});