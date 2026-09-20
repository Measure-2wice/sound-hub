"use client";

// Login page testable composition.
//
// Background: Next.js page modules may export only `default` (and
// a small set of route-level exports); the dev-verification
// navigation contract pinned by Tenki review needs behavioural
// coverage that mounts the real React tree so a regression like
// "the correct recovery push executes and then an unconditional
// /dashboard push executes" is observable at the call site.
//
// `LoginPageContent` is the inner component that owns the form
// state, the dev-verification handler, and the in-page Alert.
// Every external dependency (`router`, `verifyAndRefresh`,
// `requestMagicLink`, the return-context reader) is a prop. The
// default `LoginPage` is the production wrapper that reads every
// dependency from the Next runtime / shared session seam and
// mounts this component with the live values.
//
// Why this split: the production wrapper owns the runtime wiring
// (so a regression that drops `useRouter` or `useSession` is still
// a compile error), and the testable component owns the behaviour
// the suite exercises (so the test never has to mock the Next
// router module — it passes a stub `router` prop and observes the
// captured `push` calls directly).
//
// The dev-verification handler delegates the destination decision
// to the shared `navigateAfterVerify` helper so the callback page
// (MagicLinkVerifier) and the dev-verification button cannot
// drift in their recovery-vs-returnTo precedence.

import { useState, type FormEvent } from "react";
import { Card } from "../components/ui/Card";
import { Alert } from "../components/ui/Alert";
import { navigateAfterVerify } from "./navigate-after-verify";
import type { Bg1VerifyTokenRequestV1, Bg1VerifyTokenResponseV1 } from "@soundhub/types";

/**
 * The minimal `SessionProvider` surface the login page consumes.
 * The test injects a stub that resolves `verifyAndRefresh` to the
 * response it wants to assert against.
 */
export interface LoginSession {
  readonly verifyAndRefresh: (input: Bg1VerifyTokenRequestV1) => Promise<Bg1VerifyTokenResponseV1>;
}

/**
 * The minimal Next App Router surface the login page consumes. The
 * test injects a stub whose `push` records calls into an array so a
 * regression that adds an unconditional second `push` is observable
 * directly in the test.
 */
export interface LoginRouter {
  push(href: string): void;
  replace(href: string): void;
}

/**
 * The minimal magic-link submission surface. The submit path is
 * exercised by source-pattern tests; this seam exists so the test
 * can mount the component without stubbing `fetch` globally.
 */
export interface LoginMagicLinkClient {
  readonly requestMagicLink: (input: { email: string; return?: string }) => Promise<{
    devVerificationUrl?: string;
  }>;
}

export interface LoginPageContentProps {
  readonly router: LoginRouter;
  readonly session: LoginSession;
  readonly magicLinkClient: LoginMagicLinkClient;
  /**
   * The validated internal return destination (`?return=<path>`)
   * for the current URL. The production wrapper reads this from
   * `window.location.search`; the test injects it directly so it
   * can assert the navigation contract end-to-end.
   */
  readonly returnTo: string | null;
}

export function LoginPageContent({
  router,
  session,
  magicLinkClient,
  returnTo,
}: LoginPageContentProps) {
  const { verifyAndRefresh } = session;
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [devVerificationUrl, setDevVerificationUrl] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const response = await magicLinkClient.requestMagicLink({
        email,
        ...(returnTo ? { return: returnTo } : {}),
      });
      setStatus("sent");
      if (response.devVerificationUrl) {
        setDevVerificationUrl(response.devVerificationUrl);
      }
    } catch (err) {
      setStatus("error");
      const message = err instanceof Error ? err.message : "Could not request a magic link.";
      setErrorMessage(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDevVerification = async () => {
    if (!devVerificationUrl) return;
    const url = new URL(devVerificationUrl, window.location.origin);
    const verificationToken = url.searchParams.get("token");
    if (!verificationToken) {
      setStatus("error");
      setErrorMessage("Verification URL is missing the verification token.");
      return;
    }
    try {
      const response = await verifyAndRefresh({ verificationToken });
      navigateAfterVerify({ router, response, method: "push" });
    } catch (err) {
      setStatus("error");
      const message = err instanceof Error ? err.message : "Could not verify the magic link.";
      setErrorMessage(message);
    }
  };

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-md mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-ink mb-4">Sign in to SoundHub</h1>
        <p className="text-base text-muted mb-6">
          Enter your email. We&apos;ll send you a one-time link to sign in.
        </p>
        <Card variant="parchment">
          <Card.Content>
            <form
              onSubmit={(e) => {
                handleSubmit(e).catch(() => {
                  /* surfaced via setErrorMessage/setStatus */
                });
              }}
              className="space-y-4"
              data-testid="login-form"
            >
              <label className="block">
                <span className="text-sm font-medium text-ink">Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
                  className="mt-1 block w-full rounded-md border border-borderWarm bg-white px-3 py-2 text-base focus:border-aubergine focus:outline-none focus:ring-1 focus:ring-aubergine"
                  data-testid="login-email"
                  autoComplete="email"
                />
              </label>
              <button
                type="submit"
                disabled={submitting || status === "sent"}
                className="w-full bg-aubergine text-white py-2 px-4 rounded-md text-base font-medium hover:bg-aubergine-hover disabled:opacity-50 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                data-testid="login-submit"
              >
                {submitting ? "Sending…" : status === "sent" ? "Link sent" : "Send magic link"}
              </button>
            </form>
          </Card.Content>
        </Card>

        {status === "sent" && (
          <Card variant="parchment" className="mt-6" data-testid="login-sent">
            <Card.Content>
              <p className="text-base text-muted">
                If the address is registered, a sign-in link is on its way. The link works once and
                expires shortly.
              </p>
              {devVerificationUrl && (
                <button
                  type="button"
                  onClick={() => {
                    void handleDevVerification();
                  }}
                  className="mt-3 inline-flex items-center justify-center min-h-[44px] min-w-[44px] py-2 px-4 rounded-md text-base font-medium text-aubergine hover:text-aubergine-hover border border-gold/40 hover:bg-surface transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
                  data-testid="login-dev-verify"
                >
                  Continue with dev verification URL
                </button>
              )}
            </Card.Content>
          </Card>
        )}

        {status === "error" && errorMessage && (
          <div className="mt-6" data-testid="login-error">
            <Alert role="alert" variant="failure" title="Could not sign in">
              {errorMessage}
            </Alert>
          </div>
        )}
      </div>
    </div>
  );
}
