// Matchmaker AI adapter contract.
//
// Background: BG3 requires that AI operates behind a strict
// provider-neutral boundary. The adapter accepts a buyer brief plus
// the acting Workspace identifier and returns a candidate Matchmaker
// criteria payload that the application parses through
// `bg3MatchmakerCriteriaV1Schema` before any value touches the
// search service. The adapter NEVER receives Prisma models, raw
// session tokens, or storage keys, and it NEVER returns free-form
// text that crosses the response boundary.
//
// The contract is intentionally narrow so the AI cannot influence
// eligibility decisions, authorization, payments, or Deal state.
// All consequential writes are owned by the application service,
// not by the adapter.

import type { Bg3AiInterpretInputV1, Bg3AiInterpretOutputV1 } from "@soundhub/types";

export interface AiAdapter {
  /**
   * Interpret a natural-language brief into a candidate Matchmaker
   * criteria payload. The candidate is validated by the application
   * service against `bg3MatchmakerCriteriaV1Schema`; any adapter
   * that returns malformed output fails the validation step and
   * falls through to the deterministic adapter.
   */
  interpretBrief(input: Bg3AiInterpretInputV1): Promise<Bg3AiInterpretOutputV1>;
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export class AiInvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiInvalidOutputError";
  }
}
