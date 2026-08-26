// Matchmaker form submit test seam.
//
// Background: Next.js page modules may export only `default` and a
// small set of route-level exports; arbitrary named exports cause
// type errors against `next/types`. To keep the buyer-page submit
// path testable without coupling to React state, the runtime body
// of the page's onSubmit handler lives here as a pure function
// that the page delegates to. The focused UI test exercises this
// function with a controlled fetch so the runtime wiring
// (workspace + brief text payload, response state, error state,
// submitting flag) is verified end to end.
//
// The page's onSubmit handler delegates to this function. Tests
// may inject a `submit` override to assert the payload contract
// without exercising the network.

import type { Bg3SubmitBriefResponseV1 } from "@soundhub/types";
import { submitBrief } from "../lib/matchmaker-client";

export interface SubmitBriefFromFormInput {
  readonly actingWorkspaceId: string;
  readonly briefText: string;
  readonly setError: (message: string | null) => void;
  readonly setResponse: (response: Bg3SubmitBriefResponseV1 | null) => void;
  readonly setSubmitting: (value: boolean) => void;
  /**
   * Optional injection for tests. Defaults to the page's own
   * `submitBrief` so production wiring is unchanged.
   */
  readonly submit?: typeof submitBrief;
}

export async function submitBriefFromForm(input: SubmitBriefFromFormInput): Promise<void> {
  input.setError(null);
  input.setResponse(null);
  if (!input.actingWorkspaceId) {
    input.setError("Pick an acting Workspace before submitting a brief.");
    return;
  }
  if (input.briefText.trim().length < 8) {
    input.setError("Brief text must be at least 8 characters after trimming.");
    return;
  }
  input.setSubmitting(true);
  try {
    const fn = input.submit ?? submitBrief;
    const result = await fn({
      actingWorkspaceId: input.actingWorkspaceId,
      briefText: input.briefText.trim(),
    });
    input.setResponse(result);
  } catch (err) {
    input.setError(err instanceof Error ? err.message : "Could not submit the brief.");
  } finally {
    input.setSubmitting(false);
  }
}
