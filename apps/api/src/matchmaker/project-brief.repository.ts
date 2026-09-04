// ProjectBrief repository contract.
//
// Background: BG3 requires a persistence boundary for ProjectBrief
// and its persisted search results that lives below the
// Matchmaker service. The contract is the only surface the service
// depends on; the Prisma adapter implements it and is the only
// module that touches Prisma directly. Higher layers (the service,
// the route) consume the contract exclusively.
//
// The contract is deliberately minimal: persist a Brief and its
// results, load a Brief back with the persisted results, and load
// the public view (so the route can re-validate the stored JSON
// against the M1 search schema on every read). The route NEVER
// imports a Prisma model.

import type { MatchmakerCriteriaV1, TalentSearchResponseV1 } from "@soundhub/types";

export interface PersistedSearchResult {
  readonly resultPosition: number;
  readonly sellerId: string;
  readonly bestOfferingId: string;
  // The persisted snapshots are free-form JSON objects whose shape
  // is owned by the M1 search contract, not by the brief repository.
  // `unknown` is the correct static type — eslint's
  // `no-redundant-type-constituents` rule fires on `unknown | null`
  // because `unknown` already includes `null`; the explicit
  // `null` here is documentation that the JSON value may be absent.
  readonly sellerSnapshotJson: unknown;
  readonly bestOfferingSnapshotJson: unknown;
  // Up to two additional standalone matching offerings that
  // surfaced alongside the best match. The empty array is a
  // valid value when the seller only had one eligible offering.
  readonly additionalOfferingsJson: readonly unknown[];
  readonly relevanceScore: number;
  readonly matchReason: string;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  readonly preferenceCoverageJson: unknown | null;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  readonly textCoverageJson: unknown | null;
}

export interface PersistedBrief {
  readonly id: string;
  readonly buyerWorkspaceId: string;
  readonly createdByUserId: string;
  readonly briefText: string;
  readonly criteria: MatchmakerCriteriaV1;
  readonly aiProvider: string;
  readonly aiModelId: string | null;
  readonly aiFallbackUsed: boolean;
  readonly createdAt: Date;
  readonly buyerWorkspace: {
    readonly workspaceId: string;
    readonly slug: string;
    readonly name: string;
  };
  readonly results: readonly PersistedSearchResult[];
}

export interface CreateBriefInput {
  readonly buyerWorkspaceId: string;
  readonly createdByUserId: string;
  readonly briefText: string;
  readonly criteria: MatchmakerCriteriaV1;
  readonly searchResponse: TalentSearchResponseV1;
  readonly aiProvider: string;
  readonly aiModelId: string | null;
  readonly aiFallbackUsed: boolean;
}

export interface ProjectBriefRepository {
  /**
   * Persist a Workspace-owned ProjectBrief plus its
   * eligibility-determined search results. The entire write is
   * transactional so a failed result persistence rolls back the
   * Brief (and vice versa). Returns the persisted record with its
   * assigned id and timestamps.
   */
  createBrief(input: CreateBriefInput): Promise<PersistedBrief>;

  /**
   * Load the Brief by id. Returns `null` when the row is absent.
   * The persisted required/preferred criteria are revalidated
   * against the M1 search schema by the application boundary; this
   * method returns the persisted JSON shape verbatim.
   */
  findBriefById(briefId: string): Promise<PersistedBrief | null>;
}
