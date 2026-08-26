// Prisma adapter for ProjectBriefRepository.
//
// Background: this module is the only place the Matchmaker boundary
// touches Prisma. Higher layers depend on `ProjectBriefRepository`;
// tests can swap in the in-memory adapter without changing the
// service or route code.
//
// The write is a single transaction so a failed BriefSearchResult
// row rolls back the Brief and vice versa. The persisted
// `requiredCriteriaJson` / `preferredCriteriaJson` columns carry the
// M1-validated criteria verbatim; the application layer
// re-validates them against the M1 search schema on read so a
// tampered or drifted row cannot pass.

import type { PrismaClient } from "@soundhub/db";
import {
  bg3MatchmakerCriteriaV1Schema,
  talentSearchPreferredCriteriaV1Schema,
  talentSearchRequiredCriteriaV1Schema,
  type Bg3MatchmakerCriteriaV1,
} from "@soundhub/types";
import type {
  CreateBriefInput,
  PersistedBrief,
  PersistedSearchResult,
  ProjectBriefRepository,
} from "./project-brief.repository.js";

export class PrismaProjectBriefRepository implements ProjectBriefRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createBrief(input: CreateBriefInput): Promise<PersistedBrief> {
    const brief = await this.prisma.$transaction(async (tx) => {
      const created = await tx.projectBrief.create({
        data: {
          buyerWorkspaceId: input.buyerWorkspaceId,
          createdByUserId: input.createdByUserId,
          originalText: input.briefText,
          requiredCriteriaJson: input.criteria.required,
          // Persist the criteria `query` axis alongside required /
          // preferred / non-search so a brief whose validated
          // criteria carry only a query (e.g. the deterministic
          // fallback when the buyer named no recognised category /
          // location / mode) round-trips through the BG3 schema
          // without dropping the axis. Without this column the
          // toPersistedBrief reconstruction produces an object
          // that fails bg3MatchmakerCriteriaV1Schema's usability
          // superRefine and POST / GET /api/matchmaker/brief return
          // MATCHMAKER_FAILED for query-only briefs.
          criteriaQueryJson: input.criteria.query ?? undefined,
          preferredCriteriaJson: input.criteria.preferred ?? undefined,
          nonSearchRequirementsJson: input.criteria.nonSearchRequirements ?? undefined,
          aiProvider: input.aiProvider,
          aiModelId: input.aiModelId,
          aiFallbackUsed: input.aiFallbackUsed,
        },
      });
      // Persist the eligibility-determined search results in
      // position order so the buyer can re-render without a
      // follow-up search and so the later ProjectRequest step can
      // revalidate against the same evidence.
      const resultRows = input.searchResponse.results.map((result, index) => ({
        briefId: created.id,
        resultPosition: index + 1,
        sellerId: result.seller.sellerId,
        sellerSnapshotJson: result.seller,
        bestOfferingId: result.bestMatchingOffering.offeringId,
        bestOfferingSnapshotJson: result.bestMatchingOffering,
        // Persist up to two additional standalone matching
        // offerings so the buyer sees the full eligibility
        // evidence and the later ProjectRequest step can
        // revalidate against the same context.
        additionalOfferingsJson: [...result.additionalMatchingOfferings],
        relevanceScore: result.relevanceScore,
        matchReason: result.matchReason,
        preferenceCoverageJson: result.preferenceCoverage ?? undefined,
        textCoverageJson: result.textCoverage ?? undefined,
      }));
      if (resultRows.length > 0) {
        await tx.briefSearchResult.createMany({ data: resultRows });
      }
      return created;
    });
    return this.toPersistedBrief(await this.findBriefByIdOrThrow(brief.id));
  }

  async findBriefById(briefId: string): Promise<PersistedBrief | null> {
    const row = await this.prisma.projectBrief.findUnique({
      where: { id: briefId },
      include: {
        buyerWorkspace: true,
        searchResults: { orderBy: { resultPosition: "asc" } },
      },
    });
    if (!row) return null;
    return this.toPersistedBrief(row);
  }

  private async findBriefByIdOrThrow(briefId: string) {
    const row = await this.prisma.projectBrief.findUnique({
      where: { id: briefId },
      include: {
        buyerWorkspace: true,
        searchResults: { orderBy: { resultPosition: "asc" } },
      },
    });
    if (!row) {
      throw new Error(`ProjectBrief ${briefId} missing after persistence`);
    }
    return row;
  }

  private toPersistedBrief(row: {
    readonly id: string;
    readonly buyerWorkspaceId: string;
    readonly createdByUserId: string;
    readonly originalText: string;
    readonly requiredCriteriaJson: unknown;
    readonly criteriaQueryJson: unknown;
    readonly preferredCriteriaJson: unknown;
    readonly nonSearchRequirementsJson: unknown;
    readonly aiProvider: string;
    readonly aiModelId: string | null;
    readonly aiFallbackUsed: boolean;
    readonly createdAt: Date;
    readonly buyerWorkspace: { readonly id: string; readonly slug: string; readonly name: string };
    readonly searchResults: ReadonlyArray<{
      readonly resultPosition: number;
      readonly sellerId: string;
      readonly bestOfferingId: string;
      // The Prisma `JsonValue` shape is exactly `unknown` here; the
      // explicit `unknown` types mirror the public repository
      // contract and let the application layer validate the JSON
      // against the M1 search schema on read.
      readonly sellerSnapshotJson: unknown;
      readonly bestOfferingSnapshotJson: unknown;
      readonly additionalOfferingsJson: unknown;
      readonly relevanceScore: number;
      readonly matchReason: string;
      // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
      readonly preferenceCoverageJson: unknown | null;
      // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
      readonly textCoverageJson: unknown | null;
    }>;
  }): PersistedBrief {
    // The persisted JSON must round-trip through the M1 search
    // schema. A tampered or drifted row fails closed instead of
    // crossing the boundary into the search service.
    const required = talentSearchRequiredCriteriaV1Schema.parse(row.requiredCriteriaJson);
    const preferred =
      row.preferredCriteriaJson === null || row.preferredCriteriaJson === undefined
        ? undefined
        : talentSearchPreferredCriteriaV1Schema.parse(row.preferredCriteriaJson);
    const criteria: Bg3MatchmakerCriteriaV1 = {
      required,
      // Restore the query axis so a query-only brief still validates
      // against bg3MatchmakerCriteriaV1Schema. The persisted value is
      // already normalised by the time it lands here (the schema was
      // applied at write time), but we still re-validate the
      // reconstructed criteria below to fail closed on drift.
      ...(typeof row.criteriaQueryJson === "string" && row.criteriaQueryJson.length > 0
        ? { query: row.criteriaQueryJson }
        : {}),
      ...(preferred ? { preferred } : {}),
      ...(row.nonSearchRequirementsJson !== null && row.nonSearchRequirementsJson !== undefined
        ? { nonSearchRequirements: row.nonSearchRequirementsJson as Record<string, string> }
        : {}),
    };
    // Re-validate the reconstructed criteria as a single unit so a
    // tampered or drifted row fails closed before the application
    // layer hands it to the route DTO mapper.
    bg3MatchmakerCriteriaV1Schema.parse(criteria);
    const results: PersistedSearchResult[] = row.searchResults.map((r) => ({
      resultPosition: r.resultPosition,
      sellerId: r.sellerId,
      bestOfferingId: r.bestOfferingId,
      sellerSnapshotJson: r.sellerSnapshotJson,
      bestOfferingSnapshotJson: r.bestOfferingSnapshotJson,
      additionalOfferingsJson: Array.isArray(r.additionalOfferingsJson)
        ? (r.additionalOfferingsJson as readonly unknown[])
        : [],
      relevanceScore: r.relevanceScore,
      matchReason: r.matchReason,
      preferenceCoverageJson: r.preferenceCoverageJson,
      textCoverageJson: r.textCoverageJson,
    }));
    return {
      id: row.id,
      buyerWorkspaceId: row.buyerWorkspaceId,
      createdByUserId: row.createdByUserId,
      briefText: row.originalText,
      criteria,
      aiProvider: row.aiProvider,
      aiModelId: row.aiModelId,
      aiFallbackUsed: row.aiFallbackUsed,
      createdAt: row.createdAt,
      buyerWorkspace: {
        workspaceId: row.buyerWorkspace.id,
        slug: row.buyerWorkspace.slug,
        name: row.buyerWorkspace.name,
      },
      results,
    };
  }
}
