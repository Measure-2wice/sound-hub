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
// Authorization rules (Codex CHANGES_REQUESTED remediation §4 / P1-001):
//
//   - The page reads `useActingWorkspace()` and ONLY accepts the
//     request when the COMMITTED acting Workspace is the user's
//     Personal Workspace. If the human is acting as an
//     Organization, the page redirects to /workspace/switch
//     with the Personal Workspace as the target so the explicit
//     switch completes BEFORE intent self-service. This closes
//     the "intent can provision a Workspace different from the
//     committed actor" gap.
//
//   - The page reads `user.setupState` for the recovery surface.
//     Recovery renders a calm explanation; intent self-service
//     is unavailable and the page never submits.
//
// Server contract (already validated by `intentRequestV1Schema`):
//
//   - `intent`: "Hire" | "Offer" | "Both".
//   - `sellerAcceptance`: required when intent is "Offer" or
//     "Both". The page fetches `/api/seller-participation-terms`
//     on mount; when the registration seam is null the page
//     renders the neutral retryable copy and disables the
//     Submit button. When non-null, the page renders the
//     verbatim registered text AND an explicit acceptance
//     checkbox the customer must tick before Submit enables.
//   - `returnTo`: optional. The route revalidates it via
//     `safeReturnTo`; the browser consumes only the
//     server-resolved value.
//
// Errors:
//   - INTENT_LEGAL_BLOCKED: the registered Seller participation
//     terms are not yet registered (the explicit product/legal
//     blocker). The page surfaces the neutral retryable copy.
//   - INTENT_INVALID: malformed submission.
//   - INTENT_FORBIDDEN: not a current member of the target
//     Workspace, including the recovery-state refusal and the
//     Personal-Workspace boundary.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useActingWorkspace, useSession } from "../../components/SessionProvider";
import { Card } from "../../components/ui/Card";
import { Alert } from "../../components/ui/Alert";
import { fetchSellerParticipationTerms, submitIntent } from "../../lib/auth-client";
import { navigateAfterIntent } from "../../lib/navigate-after-intent";
import type {
  IntentKindV1,
  IntentRequestV1,
  SellerParticipationAcceptanceV1,
  SellerParticipationTermsReadResponseV1,
} from "@soundhub/types";

const LEGAL_BLOCKED_COPY = "Seller setup is temporarily unavailable. Please try again later.";

export default function IntentPage() {
  const { user, loading, refresh } = useSession();
  const { actingWorkspace } = useActingWorkspace();
  const router = useRouter();
  const [intent, setIntent] = useState<IntentKindV1 | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terms, setTerms] = useState<SellerParticipationTermsReadResponseV1 | null>(null);
  const [termsLoaded, setTermsLoaded] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Fetch the registered Seller participation terms on mount.
  // The customer must read AND accept the registered text
  // before Submit enables for Offer/Both. When the registration
  // seam is null, the page renders the legal-blocked copy and
  // disables the Submit button.
  useEffect(() => {
    if (!user || user.setupState === "recovery") return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchSellerParticipationTerms();
        if (cancelled) return;
        setTerms(result);
        setTermsLoaded(true);
      } catch {
        if (cancelled) return;
        setTermsError("Could not load Seller participation terms.");
        setTermsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const personalWorkspace = useMemo(() => {
    if (!user) return null;
    return user.workspaces.find((w) => w.workspaceType === "Personal") ?? null;
  }, [user]);

  // Read the COMMITTED acting Workspace (P1-001). The intent page
  // is Personal-Workspace-only; if the actor is not Personal,
  // redirect to the switch interstitial with the Personal
  // Workspace as the explicit target.
  const personalActor =
    actingWorkspace && actingWorkspace.workspaceType === "Personal" ? actingWorkspace : null;

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

  // Recovery state: render only. Intent self-service is
  // unavailable and the server's INTENT_FORBIDDEN refusal
  // makes sure no mutation can occur even if the user submits
  // the form via curl.
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

  // No Personal Workspace accessible — render the calm empty
  // state and stop. (Server convergence classifies this as
  // recovery normally; reaching this branch means the user has
  // no Personal membership at all.)
  if (!personalWorkspace) {
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
                one for this account.
              </p>
            </Card.Content>
          </Card>
        </div>
      </div>
    );
  }

  // P1-001: actor is not Personal → require an EXPLICIT switch
  // BEFORE intent. The user lands here after choosing Offer/Both
  // while acting as an Organization. Surface the switch
  // interstitial so the human makes the acting-Workspace choice
  // consciously; do NOT use the first Personal Workspace path
  // id as a fallback.
  if (!personalActor) {
    return (
      <div className="min-h-screen bg-canvas">
        <div className="max-w-2xl mx-auto px-6 py-12" data-testid="intent-not-personal-actor">
          <Card variant="parchment">
            <Card.Header>
              <Card.Title>Switch to your Personal Workspace</Card.Title>
            </Card.Header>
            <Card.Content>
              <p className="text-base text-muted mb-4">
                Intent selection is Personal-only. You are currently acting as{" "}
                <span className="font-medium text-ink" data-testid="intent-current-actor-name">
                  {actingWorkspace?.name ?? "another Workspace"}
                </span>
                . Switch to your Personal Workspace to choose how you want to use SoundHub as an
                individual.
              </p>
              <a
                href={`/workspace/switch?target=${encodeURIComponent(personalWorkspace.workspaceId)}`}
                className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-3 px-6 text-base font-medium text-white bg-aubergine hover:bg-aubergine-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                data-testid="intent-switch-to-personal"
              >
                Switch to your Personal Workspace
              </a>
            </Card.Content>
          </Card>
        </div>
      </div>
    );
  }

  const personalWorkspaceId = personalActor.workspaceId;

  // `Offer` and `Both` paths require Seller participation terms
  // to be registered AND the customer to have explicitly accepted
  // them. Without either condition, Submit is disabled.
  const sellerAcceptanceRequired = intent === "Offer" || intent === "Both";
  const sellerBlocked =
    sellerAcceptanceRequired && (!termsLoaded || !terms?.registered || !termsAccepted);
  const submitDisabled = intent === null || submitting || sellerBlocked;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (intent === null || submitting || !personalWorkspaceId) return;
    if (sellerAcceptanceRequired && (!terms || !terms.registered || !termsAccepted)) return;
    setSubmitting(true);
    setError(null);

    const intentBody: IntentRequestV1 =
      intent === "Hire"
        ? { intent }
        : terms && terms.registered && terms.version && terms.contentHash
          ? {
              intent,
              sellerAcceptance: {
                termsVersion: terms.version,
                termsContentHash: terms.contentHash,
              } satisfies SellerParticipationAcceptanceV1,
            }
          : { intent };

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

          {sellerAcceptanceRequired && (
            <div
              className="mt-4 border border-borderWarm rounded-lg p-4 bg-surface"
              data-testid="intent-seller-terms-block"
            >
              <h2 className="text-lg font-medium text-ink mb-2" data-testid="intent-terms-heading">
                Seller participation terms
              </h2>
              {!termsLoaded && (
                <p
                  className="text-base text-muted"
                  data-testid="intent-terms-loading"
                  role="status"
                >
                  Loading the current terms…
                </p>
              )}
              {termsLoaded && termsError !== null && (
                <Alert
                  role="alert"
                  variant="failure"
                  title="Could not load terms"
                  data-testid="intent-terms-error"
                >
                  {termsError}
                </Alert>
              )}
              {termsLoaded && termsError === null && !terms?.registered && (
                <Alert
                  role="status"
                  variant="status"
                  title="Seller setup is unavailable"
                  data-testid="intent-terms-unavailable"
                >
                  {LEGAL_BLOCKED_COPY}
                </Alert>
              )}
              {termsLoaded && termsError === null && terms?.registered && (
                <>
                  <pre
                    className="text-sm text-ink whitespace-pre-wrap max-h-80 overflow-auto p-3 bg-canvas border border-borderWarm rounded"
                    data-testid="intent-terms-content"
                    data-terms-version={terms.version ?? undefined}
                    data-terms-content-hash={terms.contentHash ?? undefined}
                  >
                    {terms.content}
                  </pre>
                  <p className="mt-2 text-xs text-muted" data-testid="intent-terms-meta">
                    Version <span data-testid="intent-terms-version">{terms.version}</span> ·
                    SHA-256 <code data-testid="intent-terms-contenthash">{terms.contentHash}</code>
                  </p>
                  <label
                    className="mt-3 flex items-start gap-2"
                    data-testid="intent-terms-accept-label"
                  >
                    <input
                      type="checkbox"
                      checked={termsAccepted}
                      onChange={(e) => setTermsAccepted(e.currentTarget.checked)}
                      disabled={submitting}
                      className="mt-1 h-4 w-4 accent-aubergine focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                      data-testid="intent-terms-accept-input"
                    />
                    <span className="text-sm text-ink" data-testid="intent-terms-accept-text">
                      I have read and accept the Seller participation terms above.
                    </span>
                  </label>
                </>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={submitDisabled}
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
