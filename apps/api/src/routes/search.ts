import { Router } from "express";
import type { Request, Response } from "express";
import type { IQueryResponse } from "@soundhub/types";
import { RagService } from "../services/rag-service.js";

export const searchRoutes: Router = Router();
const ragService = new RagService();

interface SearchResponse {
  results: IQueryResponse[];
  metadata: {
    query: string;
    totalResults: number;
    processingTimeMs: number;
  };
}

function isSearchRequest(value: unknown): value is { query: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "query" in value &&
    typeof value.query === "string"
  );
}

async function handleSearch(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    const body = req.body as unknown;

    if (!isSearchRequest(body) || body.query.trim().length === 0) {
      res.status(400).json({
        error: "Invalid request",
        message: "Query is required and must be a non-empty string",
      });
      return;
    }

    const query = body.query.trim();

    console.log(`🔍 Searching for: "${query}"`);

    // Use RAG service to find matching producers
    const results = await ragService.searchProducers(query);

    const response: SearchResponse = {
      results,
      metadata: {
        query,
        totalResults: results.length,
        processingTimeMs: Date.now() - startTime,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({
      error: "Search failed",
      message: "Unable to process search request",
    });
  }
}

searchRoutes.post("/", (req, res) => {
  void handleSearch(req, res);
});
