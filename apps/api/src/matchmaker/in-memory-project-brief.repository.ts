// In-memory ProjectBrief repository for unit tests.
//
// Background: the Matchmaker service tests run without a database.
// The in-memory adapter mirrors the Prisma adapter's contract
// surface so tests can substitute it without changing the service
// or route code. It is intentionally simple — the Prisma adapter
// is the canonical implementation; this is for unit tests only.

import { randomUUID } from "node:crypto";
import type {
  CreateBriefInput,
  PersistedBrief,
  PersistedSearchResult,
  ProjectBriefRepository,
} from "./project-brief.repository.js";

export class InMemoryProjectBriefRepository implements ProjectBriefRepository {
  private readonly briefs = new Map<string, PersistedBrief>();

  createBrief(input: CreateBriefInput): Promise<PersistedBrief> {
    const id = `brief-${randomUUID()}`;
    const createdAt = new Date();
    const results: PersistedSearchResult[] = input.searchResponse.results.map((result, index) => ({
      resultPosition: index + 1,
      sellerId: result.seller.sellerId,
      bestOfferingId: result.bestMatchingOffering.offeringId,
      sellerSnapshotJson: result.seller,
      bestOfferingSnapshotJson: result.bestMatchingOffering,
      relevanceScore: result.relevanceScore,
      matchReason: result.matchReason,
      preferenceCoverageJson: result.preferenceCoverage ?? null,
      textCoverageJson: result.textCoverage ?? null,
    }));
    const persisted: PersistedBrief = {
      id,
      buyerWorkspaceId: input.buyerWorkspaceId,
      createdByUserId: input.createdByUserId,
      briefText: input.briefText,
      criteria: input.criteria,
      aiProvider: input.aiProvider,
      aiModelId: input.aiModelId,
      aiFallbackUsed: input.aiFallbackUsed,
      createdAt,
      buyerWorkspace: {
        workspaceId: input.buyerWorkspaceId,
        slug: `ws-${input.buyerWorkspaceId}`,
        name: `Workspace ${input.buyerWorkspaceId}`,
      },
      results,
    };
    this.briefs.set(id, persisted);
    return Promise.resolve(persisted);
  }

  findBriefById(briefId: string): Promise<PersistedBrief | null> {
    return Promise.resolve(this.briefs.get(briefId) ?? null);
  }
}
