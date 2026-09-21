"use client";

// Intent selection page (M2 #83).
//
// Background: a freshly-converged Personal Workspace has no
// marketplace capability. The human must explicitly choose
// `Hire talent`, `Offer services`, or `Both` to provision Buyer /
// Seller capability. The intent page renders the three mutually
// exclusive choices as a semantic radio group styled as cards
// plus an explicit Submit button — standard browser keyboard
// semantics (arrow keys move the radio selection, Space/Enter
// activates, Tab moves to Submit). No custom keyboard handlers,
// no custom aria-pressed buttons, no Escape-to-clear.
//
// The page reads `useSession()` and routes unauthenticated users
// back to `/login` (preserving `returnTo`). Authenticated users
// without a Personal Workspace (or in recovery) see a calm
// recovery/explanation surface — the intent page does NOT
// provision capability outside the Personal Workspace boundary.
//
// Server contract (already validated by `intentRequestV1Schema`):
//
//   - `intent`: "Hire" | "Offer" | "Both".
//   - `sellerAcceptance`: required when intent is "Offer" or
//     "Both". The web layer forwards `sellerAcceptance` only
//     when the customer is shown the registered Seller
//     participation terms (out of scope for #83 — the legal
//     blocker surfaces `INTENT_LEGAL_BLOCKED` until registration).
//
// Errors:
//   - INTENT_LEGAL_BLOCKED: the registered Seller participation
//     terms are not yet registered (the explicit product/legal
//     blocker). The page surfaces the neutral retryable copy
//     "Seller setup is temporarily unavailable. Please try again
//     later." with an operable retry control.
//   - INTENT_INVALID: malformed submission.
//   - INTENT_FORBIDDEN: not a current member of the target
//     Workspace.

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "../../components/SessionProvider";
import { Card } from "../../components/ui/Card";
import { Alert } from "../../components/ui/Alert";
import { submitIntent } from "../../lib/auth-client";
import { navigateAfterIntent } from "../../lib/navigate-after-intent";
import type { IntentKindV1, IntentRequestV1 } from "@soundhub/types";

const LEGAL_BLOCKED_COPY = "Seller setup is temporarily unavailable. Please try again later.";

export default function IntentPage() {
  const { user, loading, refresh } = useSession();
  const router = useRouter();
  const [intent, setIntent] = useState<IntentKindV1 | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const personalWorkspace = useMemo(() => {
    if (!user) return null;
    return user.workspaces.find((w) => w.workspaceType === "Personal") ?? null;
  }, [user]);

  const personalWorkspaceId = personalWorkspace?.workspaceId ?? null;

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="intent-loading">
          <Alert role="status" variant="status" title="Loading…">
            Just a moment.
          </Alert>
        </div>
      </div>
    );
  }

  if (!user) {
    void router.replace("/login?return=/workspace/intent");
    return null;
  }

  if (user.setupState === "recovery") {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="intent-recovery">
          <Card variant="recovery">
            <Card.Header>
              <Card.Title>Workspace setup needs your attention</Card.Title>
            </Card.Header>
            <Card.Content>
              <p className="text-base text-muted">
                SoundHub did not guess, merge, or automatically select a Personal Workspace for this
                account. Intent selection is unavailable while Workspace ownership is in recovery.
              </p>
            </Card.Content>
          </Card>
        </div>
      </div>
    );
  }

  if (!personalWorkspaceId) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="intent-no-personal">
          <Card variant="parchment">
            <Card.Header>
              <Card.Title>No Personal Workspace</Card.Title>
            </Card.Header>
            <Card.Content>
              <p className="text-base text-muted">
                Intent selection is available on your Personal Workspace. SoundHub could not find
                one for this account; contact support or return to the dashboard.
              </p>
            </Card.Content>
          </Card>
        </div>
      </div>
    );
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!intent || submitting || !personalWorkspaceId) return;
    setSubmitting(true);
    setError(null);

    const intentBody: IntentRequestV1 = intent === "Hire" ? { intent } : { intent };

    void (async () => {
      try {
        const response = await submitIntent({
          workspaceId: personalWorkspaceId,
          intent: intentBody,
        });
        await refresh();
        navigateAfterIntent({ router, response });
      } catch (err) {
        const apiErr = err as { status?: number; code?: string; message?: string };
        if (apiErr.code === "INTENT_LEGAL_BLOCKED") {
          setError(LEGAL_BLOCKED_COPY);
        } else if (apiErr.code === "INTENT_INVALID") {
          setError("Please choose how you want to use SoundHub.");
        } else if (apiErr.code === "INTENT_FORBIDDEN" || apiErr.status === 403) {
          setError("You are not a current member of this Workspace.");
        } else if (apiErr.message) {
          setError(apiErr.message);
        } else {
          setError("Something went wrong. Please try again.");
        }
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-2xl mx-auto px-6 py-12" data-testid="intent-page">
        <h1 className="text-3xl font-serif text-ink mb-3" data-testid="intent-heading">
          How do you want to use SoundHub?
        </h1>
        <p className="text-base text-muted mb-8" data-testid="intent-summary">
          Choose how you want to use SoundHub. You can add the other capability later from the
          dashboard.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="intent-form">
          <fieldset disabled={submitting} className="space-y-3" data-testid="intent-fieldset">
            <legend className="sr-only">Marketplace intent</legend>
            <IntentChoice
              value="Hire"
              title="Hire talent"
              description="Find Caribbean producers, songwriters, and performers. Send project requests and approve work."
              selected={intent === "Hire"}
              disabled={submitting}
              onSelect={setIntent}
              testId="intent-choice-hire"
            />
            <IntentChoice
              value="Offer"
              title="Offer services"
              description="Publish a profile and one or more services. Receive project requests from buyers."
              selected={intent === "Offer"}
              disabled={submitting}
              onSelect={setIntent}
              testId="intent-choice-offer"
            />
            <IntentChoice
              value="Both"
              title="Both"
              description="Hire talent and offer services from the same Personal Workspace."
              selected={intent === "Both"}
              disabled={submitting}
              onSelect={setIntent}
              testId="intent-choice-both"
            />
          </fieldset>

          <button
            type="submit"
            disabled={submitting || intent === null}
            className="w-full sm:w-auto inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-coral hover:bg-coral-hover rounded disabled:opacity-50 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
            data-testid="intent-submit"
          >
            {submitting ? "Submitting…" : "Continue"}
          </button>
        </form>

        {error && (
          <div className="mt-6" data-testid="intent-error">
            <Alert role="alert" variant="failure" title="Could not submit your choice">
              {error}
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}

interface IntentChoiceProps {
  readonly value: IntentKindV1;
  readonly title: string;
  readonly description: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: (value: IntentKindV1) => void;
  readonly testId: string;
}

function IntentChoice({
  value,
  title,
  description,
  selected,
  disabled,
  onSelect,
  testId,
}: IntentChoiceProps) {
  return (
    <label
      className={`block cursor-pointer rounded-lg border p-4 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-aubergine ${
        selected ? "border-aubergine bg-surface" : "border-borderWarm bg-canvas hover:bg-surface"
      }`}
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
    >
      <div className="flex items-start gap-3">
        <input
          type="radio"
          name="intent"
          value={value}
          checked={selected}
          onChange={() => onSelect(value)}
          disabled={disabled}
          className="mt-1 h-4 w-4 accent-aubergine focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
          data-testid={`${testId}-input`}
        />
        <div>
          <span className="block text-base font-medium text-ink">{title}</span>
          <span className="block text-sm text-muted mt-1">{description}</span>
        </div>
      </div>
    </label>
  );
}
