"use client";

// Public landing page (M2 #83).
//
// Background: the M2 UX addendum replaces the previous SearchPage
// root with the canonical Caribbean Studio landing composition.
// The landing positions SoundHub through the sequence:
//   discover talent → hear work → send a request → agree on terms
//
// Copy rules (from the M2 UX addendum):
//
//   - Global navigation noun: "Talent".
//   - Public and dashboard call to action: "Find talent".
//   - Public/landing CTAs:
//       `Find talent`            → `/talent` (anonymous discovery).
//       `Offer your services`   → anonymous: `/login?return=/workspace/intent`
//                                 → signed-in without Seller:
//                                    `/workspace/intent`
//                                 → signed-in with Seller:
//                                    `/dashboard`
//   - Landing content does NOT market sandbox funding or escrow
//     publicly; does NOT make verification, legal, security,
//     studio-quality, booking, chat, public-directory, or
//     similar Stitch-generated claims.
//   - Generated or mock imagery is acceptable as design evidence
//     and must not block M2 implementation.
//
// Client component: the landing reads the existing `useSession()`
// seam so signed-in users see the right CTA without flashing the
// public CTA first. Anonymous users see the canonical public CTA
// pair.

import Link from "next/link";
import { useSession } from "./components/SessionProvider";

export default function LandingPage() {
  const { user } = useSession();

  // CTA `Offer your services` target selection.
  // Anonymous: route through `/login?return=/workspace/intent`.
  // Signed-in: route to `/workspace/intent` — the intent page
  // reads the user's capabilities and routes onward (to
  // `/dashboard` if Seller is already provisioned, otherwise it
  // renders the choice). The intent service revalidates current
  // membership on every call so the safe path is preserved.
  const offerYourServicesHref = user ? "/workspace/intent" : "/login?return=/workspace/intent";

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-3xl mx-auto px-6 py-16 sm:py-24" data-testid="landing-page">
        <p className="text-base font-medium text-muted mb-3" data-testid="landing-eyebrow">
          Caribbean creative services
        </p>
        <h1
          className="text-4xl sm:text-5xl font-serif text-ink mb-6 leading-tight"
          data-testid="landing-heading"
        >
          Discover Caribbean talent.
        </h1>
        <p className="text-lg sm:text-xl text-muted mb-10 max-w-2xl" data-testid="landing-summary">
          Find producers, songwriters, and performers across the Caribbean. Listen to their work,
          send a project request, and agree on terms — all in one place.
        </p>

        <div className="flex flex-col sm:flex-row gap-4" data-testid="landing-cta-row">
          <Link
            href="/talent"
            className="inline-flex items-center justify-center min-h-[44px] px-6 py-3 text-base font-medium text-white bg-coral hover:bg-coral-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
            data-testid="landing-find-talent"
          >
            Find talent
          </Link>
          <Link
            href={offerYourServicesHref}
            className="inline-flex items-center justify-center min-h-[44px] px-6 py-3 text-base font-medium text-aubergine hover:text-aubergine-hover border border-aubergine rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
            data-testid="landing-offer-services"
          >
            Offer your services
          </Link>
        </div>

        <p className="mt-10 text-sm text-muted" data-testid="landing-secondary">
          {user ? (
            <>Signed in. Use Sign out in the navigation above when you&apos;re done.</>
          ) : (
            <>
              Already have an account?{" "}
              <Link
                href="/login"
                className="text-aubergine hover:text-aubergine-hover font-medium focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
                data-testid="landing-sign-in-link"
              >
                Sign in
              </Link>
              .
            </>
          )}
        </p>
      </div>
    </div>
  );
}
