import { Router } from "express";
import type { IQueryResponse } from "@soundhub/types";
import { RagService } from "../services/rag-service.js";

export const searchRoutes = Router();
const ragService = new RagService();

interface SearchRequest {
  query: string;
}

interface SearchResponse {
  results: IQueryResponse[];
  metadata: {
    query: string;
    totalResults: number;
    processingTimeMs: number;
  };
}

searchRoutes.post("/", async (req, res) => {
  const startTime = Date.now();

  try {
    const { query }: SearchRequest = req.body;

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return res.status(400).json({
        error: "Invalid request",
        message: "Query is required and must be a non-empty string",
      });
    }

    console.log(`🔍 Searching for: "${query}"`);

    // Use RAG service to find matching producers
    const results = await ragService.searchProducers(query);

    const response: SearchResponse = {
      results,
      metadata: {
        query: query.trim(),
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
});