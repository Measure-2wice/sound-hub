import type {
  Bg5DealApprovalPublicV1,
  Bg6PublicFundingFailureReasonCodeV1,
  Bg6PublicFundingStatusV1,
  DealStatusV1,
} from "@soundhub/types";

export type DealPartySide = "Buyer" | "Seller";

export interface ApprovalStatusRow {
  readonly side: DealPartySide;
  readonly approvedAt: string | null;
}

export function buildDealSummaryCopy(status: DealStatusV1): {
  readonly title: string;
  readonly description: string;
} {
  if (status === "Active") {
    return {
      title: "Deal Active",
      description: "Escrow funded; commissioned work may begin.",
    };
  }
  return {
    title: "Deal terms",
    description: `Status: ${status}. Created from an accepted project request.`,
  };
}

export function buildFundingBadgeLabel(): string {
  return "Sandbox · simulated";
}

export function buildPublicFundingStatusCopy(
  status: Bg6PublicFundingStatusV1,
  sanitizedReason: Bg6PublicFundingFailureReasonCodeV1 | null,
): string {
  if (status === "Confirmed") return "Funding confirmed (sandbox)";
  if (status === "AwaitingConfirmation") return "Awaiting sandbox confirmation";
  // Failed — render the closed sanitized code only; never raw text.
  return sanitizedReason ? `Funding failed (${sanitizedReason})` : "Funding failed";
}

export function getDealPartySide(input: {
  readonly workspaceId: string;
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
}): DealPartySide | null {
  if (input.workspaceId === input.buyerWorkspaceId) return "Buyer";
  if (input.workspaceId === input.sellerWorkspaceId) return "Seller";
  return null;
}

export function buildApprovalSuccessCopy(side: DealPartySide, version: number): string {
  return `${side} approved TermsVersion ${version}.`;
}

export function buildApprovalStatusRows(input: {
  readonly buyerWorkspaceId: string;
  readonly sellerWorkspaceId: string;
  readonly approvals: readonly Bg5DealApprovalPublicV1[];
}): readonly ApprovalStatusRow[] {
  const approvedAtFor = (workspaceId: string): string | null =>
    input.approvals.find((approval) => approval.workspaceId === workspaceId)?.approvedAt ?? null;

  return [
    { side: "Buyer", approvedAt: approvedAtFor(input.buyerWorkspaceId) },
    { side: "Seller", approvedAt: approvedAtFor(input.sellerWorkspaceId) },
  ];
}

export function buildAiDraftStatusLabel(rows: readonly ApprovalStatusRow[]): string {
  const approvedCount = rows.filter((row) => row.approvedAt !== null).length;
  if (approvedCount === 0) return "AI-drafted · unapproved";
  if (approvedCount === rows.length) return "AI-drafted · approved by both parties";

  const pendingSide = rows.find((row) => row.approvedAt === null)?.side;
  return pendingSide
    ? `AI-drafted · awaiting ${pendingSide.toLowerCase()} approval`
    : "AI-drafted · awaiting remaining approval";
}
