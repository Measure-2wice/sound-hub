import assert from "node:assert/strict";
import test from "node:test";
import { RagService } from "./rag-service.js";

void test("searchProducers returns a matching producer with bounded scores", async () => {
  const service = new RagService();

  const results = await service.searchProducers("dark electronic industrial beats");

  assert.ok(results.length > 0);
  assert.ok(results.some((result) => result.producerProfile.id === "producer-1"));
  assert.ok(results.every((result) => !("vibeEmbeddingVector" in result.producerProfile)));
  assert.ok(
    results.every(
      (result) =>
        result.userQuery === "dark electronic industrial beats" &&
        result.matchScore !== undefined &&
        result.matchScore >= 0 &&
        result.matchScore <= 1,
    ),
  );
});
