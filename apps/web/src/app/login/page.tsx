"use client";

// Login page.
//
// Background: the BG1 integrated browser journey signs in by
// submitting an email to the magic-link endpoint, then either
// following the email link or, in the deterministic / test /
// fallback path, the dev verification URL the server returns. The
// page is the single browser entry point for both flows.
//
// Per GS 4 the page must never accept or surface a client-asserted
// UserAccount. The only state the browser maintains is the email
// form value; every authority decision happens server-side after the
// session cookie is set.
//
// M2 (#82) visual-QA remediation: the submit button uses the
// aubergine semantic-action family (authentication actions are
// structural / management). Error surfaces render the in-page
// `Alert` primitive with role="alert" and variant=failure — bounded
// copy, no gold accent (genuine operation failure). The warm
// parchment canvas wrapper is scoped to this #82 page only.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { requestMagicLink, readReturnFromUrl } from "../lib/auth-client";
import { useSession } from "../components/SessionProvider";
import { Card } from "../components/ui/Card";
import { Alert } from "../components/ui/Alert";

export default function LoginPage() {
  const router = useRouter();
  const { verifyAndRefresh } = useSession();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [devVerificationUrl, setDevVerificationUrl] = useState<string | null>(null);

  // M2 (#82): read the validated internal return destination from
  // `?return=<path>` and forward it to the magic-link route. The
  // server is the authoritative validator; invalid destinations are
  // silently dropped so the user never sees an error here.
  const returnTo = readReturnFromUrl();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const response = await requestMagicLink({
        email,
        ...(returnTo ? { return: returnTo } : {}),
      });
      setStatus("sent");
      // Deterministic / test path: the adapter returns a verification
      // URL we can follow directly. In production Supabase the field
      // is absent and the user clicks the email link.
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
    // Parse ?token=... from the verification URL. The
    // deterministic adapter (and the managed callback URL) emit
    // the one-time credential as `token`; the public correlation
    // id `requestId` is NEVER a credential.
    const url = new URL(devVerificationUrl, window.location.origin);
    const verificationToken = url.searchParams.get("token");
    if (!verificationToken) {
      setStatus("error");
      setErrorMessage("Verification URL is missing the verification token.");
      return;
    }
    try {
      await verifyAndRefresh({ verificationToken });
      router.push("/dashboard");
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
