import type { Bg5GetDealResponseV1 } from "@soundhub/types";

interface DealClientError extends Error {
  readonly code?: string;
}

export interface FindVisibleDealInput {
  readonly dealId: string;
  readonly workspaceIds: readonly string[];
  readonly fetchDeal: (dealId: string, actingWorkspaceId: string) => Promise<Bg5GetDealResponseV1>;
}

export interface VisibleDealResult {
  readonly actingWorkspaceId: string;
  readonly response: Bg5GetDealResponseV1;
}

/**
 * Bootstrap a Deal read before the browser knows which of the
 * authenticated human's current Workspaces is a party to it. Each
 * request still commands one exact acting Workspace and the API remains
 * authoritative for current membership and Deal-party authorization.
 */
export async function findVisibleDeal(input: FindVisibleDealInput): Promise<VisibleDealResult> {
  let lastNotFound: DealClientError | null = null;

  for (const workspaceId of input.workspaceIds) {
    try {
      const response = await input.fetchDeal(input.dealId, workspaceId);
      return { actingWorkspaceId: workspaceId, response };
    } catch (error) {
      const candidate = error instanceof Error ? (error as DealClientError) : null;
      if (candidate?.code !== "DEAL_NOT_FOUND") throw error;
      lastNotFound = candidate;
    }
  }

  if (lastNotFound) throw lastNotFound;
  throw Object.assign(new Error("Deal not found."), { code: "DEAL_NOT_FOUND" });
}
