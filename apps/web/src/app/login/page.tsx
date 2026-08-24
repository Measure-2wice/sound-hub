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

"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { requestMagicLink, verifyToken } from "../lib/auth-client";
import { Card } from "../components/ui/Card";

export default function LoginPage() {
  const router = useRouter();
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
      const response = await requestMagicLink({ email });
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
    // Parse ?request_id=... from the verification URL.
    const url = new URL(devVerificationUrl, window.location.origin);
    const requestId = url.searchParams.get("request_id");
    if (!requestId) {
      setStatus("error");
      setErrorMessage("Verification URL is missing the request id.");
      return;
    }
    try {
      await verifyToken({ requestId });
      router.push("/dashboard");
    } catch (err) {
      setStatus("error");
      const message = err instanceof Error ? err.message : "Could not verify the magic link.";
      setErrorMessage(message);
    }
  };

  return (
    <div className="max-w-md mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold text-gray-900 mb-4">Sign in to SoundHub</h1>
      <p className="text-gray-600 mb-6">
        Enter your email. We&apos;ll send you a one-time link to sign in.
      </p>
      <Card>
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
              <span className="text-sm font-medium text-gray-700">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                data-testid="login-email"
                autoComplete="email"
              />
            </label>
            <button
              type="submit"
              disabled={submitting || status === "sent"}
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              data-testid="login-submit"
            >
              {submitting ? "Sending…" : status === "sent" ? "Link sent" : "Send magic link"}
            </button>
          </form>
        </Card.Content>
      </Card>

      {status === "sent" && (
        <Card className="mt-6" data-testid="login-sent">
          <Card.Content>
            <p className="text-sm text-gray-700">
              If the address is registered, a sign-in link is on its way. The link works once and
              expires shortly.
            </p>
            {devVerificationUrl && (
              <button
                type="button"
                onClick={() => {
                  void handleDevVerification();
                }}
                className="mt-3 inline-flex bg-amber-100 text-amber-900 px-3 py-2 rounded-md text-sm font-medium hover:bg-amber-200 transition-colors"
                data-testid="login-dev-verify"
              >
                Continue with dev verification URL
              </button>
            )}
          </Card.Content>
        </Card>
      )}

      {status === "error" && errorMessage && (
        <Card className="mt-6 border-red-200 bg-red-50" data-testid="login-error">
          <Card.Content>
            <p className="text-sm text-red-800">{errorMessage}</p>
          </Card.Content>
        </Card>
      )}
    </div>
  );
}
