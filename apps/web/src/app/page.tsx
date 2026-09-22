"use client";

// Public landing page (M2 #83 + post-#83 visual-parity pass).
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
// Post-#83 visual-parity pass: the landing composition is
// translated from the Stitch `soundhub_landing_page_desktop/code.html`
// export — hero (eyebrow chip + headline + 2 CTAs + specs strip +
// documentary studio photograph), discovery section with two
// illustrative service-category cards, audio audition section with
// category-only labels (no fictional creators — #83 excludes
// uploads), alignment section, methodology section, seller CTA
// section, and footer. The Stitch's "Seller Participation Terms"
// block is intentionally NOT ported (the authoritative M2 spec
// removed generic Seller participation acceptance at capability-
// provisioning time, per the intent surface's source-pattern tests).
//
// Client component: the landing reads the existing `useSession()`
// seam so signed-in users see the right CTA without flashing the
// public CTA first. Anonymous users see the canonical public CTA
// pair.

import Image from "next/image";
import Link from "next/link";
import { useSession } from "./components/SessionProvider";
import { SoundHubLogo } from "./components/SoundHubLogo";

// Tailwind utility aliases the Stitch `space-*` tokens to Tailwind's
// own spacing scale. The constants below keep the section grid
// rhythm legible without importing the Stitch config wholesale.
const STITCH_SECTION_GAP = "py-12 md:py-16 lg:py-20";
const STITCH_CONTAINER = "max-w-[1440px] mx-auto px-6 lg:px-12";

// Audio waveform bar geometry — matches the Stitch `Audition`
// composition (10 played-progress bars in sea-glass, 10
// unplayed bars in the warm neutral outline color). The array
// lengths are FIXED at 20 to match the visual evidence.
const AUDITION_BARS_PLAYED = [12, 20, 28, 16, 32, 24, 12, 20, 28, 16] as const;
const AUDITION_BARS_UNPLAYED = [32, 16, 24, 20, 28, 8, 24, 16, 20, 12] as const;

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
    <div className="min-h-screen bg-canvas" data-testid="landing-page">
      {/* ============== HERO ============== */}
      <section className={`${STITCH_CONTAINER} ${STITCH_SECTION_GAP}`} data-testid="landing-hero">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
          <div className="lg:col-span-6 flex flex-col gap-6">
            <div
              className="inline-flex items-center gap-2 self-start px-3 py-1.5 rounded-full bg-surface border border-borderWarm text-label-sm uppercase tracking-wider text-muted"
              data-testid="landing-hero-eyebrow"
            >
              <span aria-hidden="true" className="w-2 h-2 rounded-full bg-seaGlass" />
              Caribbean Creative Talent &amp; Services
            </div>
            <h1
              className="font-serif text-4xl md:text-5xl lg:text-[48px] leading-tight text-ink"
              data-testid="landing-heading"
            >
              Caribbean creative talent, easier to discover and hire.
            </h1>
            <p className="text-lg text-muted max-w-xl" data-testid="landing-summary">
              Discover creative services, hear real work samples, send a project request, and agree
              on clear terms before work begins.
            </p>
            <div className="flex flex-wrap items-center gap-4 pt-2" data-testid="landing-cta-row">
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
            <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-2 text-sm text-muted">
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="text-seaGlass">
                  ◆
                </span>
                Vocalists, songwriters, producers &amp; musicians
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="text-seaGlass">
                  ◆
                </span>
                Direct audio work samples
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="text-seaGlass">
                  ◆
                </span>
                Clear project terms upfront
              </li>
            </ul>
          </div>

          <div className="lg:col-span-6 relative">
            <div className="relative rounded-xl overflow-hidden bg-surface border border-borderWarm shadow-sm">
              <Image
                src="/brand/studio-documentary.png"
                alt="Two Caribbean recording artists and sound engineers collaborating in a warm, wood-paneled audio studio with a vintage mixing console."
                width={1376}
                height={768}
                className="w-full h-auto object-cover aspect-[16/9]"
                priority
                data-testid="landing-hero-image"
              />
              <div
                className="absolute bottom-4 left-4 right-4 sm:right-auto bg-surface/95 backdrop-blur-sm p-3.5 rounded-lg border border-borderWarm shadow-sm flex items-center gap-3"
                data-testid="landing-hero-stamp"
              >
                <div
                  aria-hidden="true"
                  className="w-9 h-9 rounded-full bg-seaGlass/15 flex items-center justify-center text-seaGlass shrink-0"
                >
                  ♪
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-base font-medium text-ink truncate">
                    Songwriting &amp; Production
                  </span>
                  <span className="text-xs uppercase tracking-wider text-muted">
                    Creative Collaboration · Caribbean &amp; Diaspora
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============== DISCOVERY ============== */}
      <section
        className={`${STITCH_CONTAINER} ${STITCH_SECTION_GAP}`}
        data-testid="landing-discovery"
      >
        <div className="max-w-3xl mb-10">
          <span className="text-xs uppercase tracking-wider text-seaGlass font-semibold">
            Creative Services Marketplace
          </span>
          <h2 className="font-serif text-3xl md:text-[36px] leading-tight text-ink mt-2">
            A space calibrated for creative collaboration
          </h2>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-5 flex flex-col gap-3">
            <span className="text-xs uppercase tracking-wider text-coral font-semibold">
              01 / Discovery
            </span>
            <h3 className="font-serif text-[28px] leading-tight text-ink">
              Discover people and services
            </h3>
            <p className="text-lg text-muted">
              Connect directly with creative professionals across songwriting, vocal performance,
              production, composition, and sound design. Browse creator profiles and explore
              services tailored to your project.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {[
                "Songwriting & Topline",
                "Vocal Arrangement",
                "Steel Pan & Percussion",
                "Music Production",
                "Film Scoring",
                "Session Musicians",
              ].map((tag) => (
                <span
                  key={tag}
                  className="px-3 py-1.5 rounded-md bg-surface border border-borderWarm text-sm text-aubergine"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <DiscoveryCard
              badge="Songwriter & Arranger"
              badgeTone="seaGlass"
              iconGlyph="♪"
              title="Tenor Pan & Melodic Arrangement"
              body="Original arrangements, acoustic tracking, and harmonic scoring across Caribbean and contemporary musical styles."
              meta="Project request"
              metaRight="San Fernando, TT"
              testId="landing-discovery-card-1"
            />
            <DiscoveryCard
              badge="Producer & Sound Designer"
              badgeTone="aubergine"
              iconGlyph="◇"
              title="Production, Rhythm & Sonic Design"
              body="Full track production, authentic rhythmic textures, and dynamic sound design for records, media, and sync."
              meta="Project Collaboration"
              metaRight="Kingston, JM"
              testId="landing-discovery-card-2"
            />
          </div>
        </div>
      </section>

      {/* ============== AUDITION (illustrative — no fictional creators) ============== */}
      <section
        className={`${STITCH_CONTAINER} ${STITCH_SECTION_GAP}`}
        data-testid="landing-audition"
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-5 flex flex-col gap-3">
            <span className="text-xs uppercase tracking-wider text-coral font-semibold">
              02 / Audition
            </span>
            <h3 className="font-serif text-[28px] leading-tight text-ink">
              Hear real work samples
            </h3>
            <p className="text-lg text-muted">
              Listen directly to creator-uploaded audio samples — from vocal arrangements and rough
              takes to finished productions — so you can evaluate style and fit before reaching out.
            </p>
            <div className="p-4 rounded-lg bg-surface border border-borderWarm">
              <p className="text-base text-ink">
                &ldquo;Listen to authentic creative work samples provided directly by creators to
                find the exact sound your project needs.&rdquo;
              </p>
            </div>
          </div>
          <div className="lg:col-span-7 flex flex-col gap-4">
            <AuditionCard
              title="Vocal sample preview"
              meta="Audio uploads publish with seller profiles"
              badge="Original composition · Film score excerpt"
              playedBars={AUDITION_BARS_PLAYED}
              unplayedBars={AUDITION_BARS_UNPLAYED}
              timeStart="01:14"
              timeEnd="03:45"
              testId="landing-audition-card-1"
            />
            <AuditionCard
              title="Production sample preview"
              meta="Audio uploads publish with seller profiles"
              badge="Vocal harmony · Arrangement sample"
              playedBars={AUDITION_BARS_UNPLAYED}
              unplayedBars={AUDITION_BARS_PLAYED}
              timeStart="00:00"
              timeEnd="02:18"
              testId="landing-audition-card-2"
            />
            <p className="text-sm text-muted pt-1" data-testid="landing-audition-meta">
              Audio previews unlock when sellers publish work samples.
            </p>
          </div>
        </div>
      </section>

      {/* ============== ALIGNMENT ============== */}
      <section
        className={`${STITCH_CONTAINER} ${STITCH_SECTION_GAP}`}
        data-testid="landing-alignment"
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-5 flex flex-col gap-3">
            <span className="text-xs uppercase tracking-wider text-coral font-semibold">
              03 / Alignment
            </span>
            <h3 className="font-serif text-[28px] leading-tight text-ink">
              Agree on the work before it begins
            </h3>
            <p className="text-lg text-muted">
              Creative projects run smoothly when expectations are clear. Outline deliverables,
              milestones, and usage terms before work starts.
            </p>
            <div className="flex items-center gap-2 text-sm text-muted">
              <span aria-hidden="true" className="text-seaGlass">
                ✓
              </span>
              Clear project terms and collaborative delivery milestones
            </div>
          </div>
          <div className="lg:col-span-7 bg-surface border border-borderWarm rounded-xl p-6 md:p-8 flex flex-col gap-3">
            <div className="flex items-center justify-between pb-3 border-b border-borderWarm">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="w-3 h-3 rounded-full bg-seaGlass" />
                <span className="text-base font-medium text-ink">Project Alignment Outline</span>
              </div>
              <span className="px-2.5 py-1 rounded-md bg-canvas border border-borderWarm text-xs uppercase tracking-wider text-seaGlass font-semibold">
                Scope Confirmed
              </span>
            </div>
            <AlignmentItem
              title="Deliverables & Formats"
              body="Outline expected tracks, agreed file formats, and delivery timelines upfront."
              testId="landing-alignment-item-1"
            />
            <AlignmentItem
              title="Milestones & Review Passes"
              body="Agree on review checkpoints and revision rounds so both sides stay aligned throughout the project."
              testId="landing-alignment-item-2"
            />
            <AlignmentItem
              title="Project Terms & Credits"
              body="Clarify credit attribution, usage scope, and project expectations before creative work begins."
              testId="landing-alignment-item-3"
            />
          </div>
        </div>
      </section>

      {/* ============== METHODOLOGY ============== */}
      <section
        className={`${STITCH_CONTAINER} ${STITCH_SECTION_GAP}`}
        data-testid="landing-methodology"
      >
        <div className="max-w-2xl mb-10">
          <span className="text-xs uppercase tracking-wider text-seaGlass font-semibold">
            Methodology
          </span>
          <h2 className="font-serif text-3xl md:text-[36px] leading-tight text-ink mt-2">
            How SoundHub operates
          </h2>
          <p className="text-lg text-muted mt-2">
            A clear, collaborative process to discover talent, review work samples, and align on
            project terms before work begins.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <MethodologyStep
            n={1}
            title="Describe what you need"
            body="Share your creative vision, timeline, and reference material for your record, commercial, or event."
            meta="Project brief builder"
            testId="landing-methodology-step-1"
          />
          <MethodologyStep
            n={2}
            title="Compare talent and hear samples"
            body="Explore creator profiles across Caribbean disciplines, and listen to work samples to find the right collaborator."
            meta="Browse work samples"
            testId="landing-methodology-step-2"
          />
          <MethodologyStep
            n={3}
            title="Send a project request"
            body="Connect directly with creative talent using your project brief to align on timeline and direction."
            meta="Structured briefing"
            testId="landing-methodology-step-3"
          />
          <MethodologyStep
            n={4}
            title="Agree on terms"
            body="Confirm deliverables, revision rounds, and project terms before creative production kicks off."
            meta="Align before work begins"
            testId="landing-methodology-step-4"
          />
        </div>
      </section>

      {/* ============== SELLER CTA ============== */}
      <section
        className={`${STITCH_CONTAINER} ${STITCH_SECTION_GAP}`}
        data-testid="landing-seller-cta"
      >
        <div className="relative bg-aubergine text-canvas rounded-xl p-8 md:p-12 overflow-hidden">
          <div className="relative max-w-3xl flex flex-col gap-4">
            <span className="px-3 py-1.5 rounded-full bg-canvas/10 text-xs uppercase tracking-wider font-semibold self-start">
              For Caribbean creative professionals
            </span>
            <h2 className="font-serif text-3xl md:text-[36px] leading-tight">
              Share your sound with the world
            </h2>
            <p className="text-lg text-canvas/85 max-w-2xl">
              Build a creator profile, showcase your services, upload audio work samples, and
              collaborate with productions and clients looking for Caribbean creative talent.
            </p>
            <div className="flex flex-wrap items-center gap-4 pt-2">
              <Link
                href={offerYourServicesHref}
                className="inline-flex items-center justify-center min-h-[44px] px-8 py-3.5 text-base font-medium text-white bg-coral hover:bg-coral-hover rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral"
                data-testid="landing-seller-cta-offer"
              >
                Offer your services
              </Link>
              <span className="text-sm text-canvas/70">
                Connect with global projects · Collaborate on your terms
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ============== FOOTER ============== */}
      <footer
        className={`${STITCH_CONTAINER} py-12 mt-8 border-t border-borderWarm`}
        data-testid="landing-footer"
      >
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          <div className="flex flex-col gap-2 max-w-md">
            <SoundHubLogo size="md" />
            <p className="text-sm text-muted">
              Connecting Caribbean creative talent — vocalists, songwriters, producers, and
              musicians — with projects and opportunities worldwide.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link
              href="/talent"
              className="text-sm font-medium text-muted hover:text-ink focus-visible:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
              data-testid="landing-footer-find-talent"
            >
              Find talent
            </Link>
            <Link
              href={offerYourServicesHref}
              className="text-sm font-medium text-muted hover:text-ink focus-visible:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine rounded"
              data-testid="landing-footer-offer-services"
            >
              Offer your services
            </Link>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mt-8 text-xs uppercase tracking-wider text-muted/80">
          <span>© SoundHub Technologies. All rights reserved.</span>
          <span>A curated marketplace for Caribbean sound.</span>
        </div>
      </footer>

      {/* ============== EXISTING SIGN-IN LINK (preserved copy) ============== */}
      <div className={`${STITCH_CONTAINER} pb-12`}>
        <p className="text-sm text-muted" data-testid="landing-secondary">
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

// ----- Local subcomponents (visual evidence → React) -----

interface DiscoveryCardProps {
  readonly badge: string;
  readonly badgeTone: "seaGlass" | "aubergine";
  readonly iconGlyph: string;
  readonly title: string;
  readonly body: string;
  readonly meta: string;
  readonly metaRight: string;
  readonly testId: string;
}

function DiscoveryCard({
  badge,
  badgeTone,
  iconGlyph,
  title,
  body,
  meta,
  metaRight,
  testId,
}: DiscoveryCardProps) {
  const badgeClasses =
    badgeTone === "seaGlass" ? "bg-seaGlass/10 text-seaGlass" : "bg-aubergine/10 text-aubergine";
  return (
    <article
      className="bg-surface border border-borderWarm rounded-xl p-5 flex flex-col gap-4"
      data-testid={testId}
    >
      <div className="flex items-center justify-between">
        <span
          className={`px-2.5 py-1 rounded-md text-xs uppercase tracking-wider font-semibold ${badgeClasses}`}
        >
          {badge}
        </span>
        <span aria-hidden="true" className="text-muted text-xl">
          {iconGlyph}
        </span>
      </div>
      <h4 className="font-serif text-xl text-ink leading-tight">{title}</h4>
      <p className="text-sm text-muted">{body}</p>
      <div className="flex items-center justify-between pt-2 mt-auto border-t border-borderWarm text-xs uppercase tracking-wider text-muted">
        <span>{meta}</span>
        <span className="text-seaGlass font-semibold">{metaRight}</span>
      </div>
    </article>
  );
}

interface AuditionCardProps {
  readonly title: string;
  readonly meta: string;
  readonly badge: string;
  readonly playedBars: readonly number[];
  readonly unplayedBars: readonly number[];
  readonly timeStart: string;
  readonly timeEnd: string;
  readonly testId: string;
}

function AuditionCard({
  title,
  meta,
  badge,
  playedBars,
  unplayedBars,
  timeStart,
  timeEnd,
  testId,
}: AuditionCardProps) {
  return (
    <article
      className="bg-surface border border-borderWarm rounded-xl p-5 flex flex-col gap-3"
      data-testid={testId}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <div className="text-base font-medium text-ink">{title}</div>
          <div className="text-sm text-muted">{meta}</div>
        </div>
        <span className="px-2.5 py-1 rounded-md bg-canvas border border-borderWarm text-xs uppercase tracking-wider text-muted self-start sm:self-center">
          {badge}
        </span>
      </div>
      <div className="flex items-center gap-3 mt-2">
        <button
          type="button"
          aria-label={`Play ${title}`}
          // Honest disabled affordance: #83 excludes audio uploads, so the
          // play control is non-functional until sellers publish samples.
          aria-disabled="true"
          disabled
          className="w-11 h-11 rounded-full bg-aubergine text-canvas flex items-center justify-center shrink-0 opacity-60 cursor-not-allowed focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aubergine"
        >
          <span aria-hidden="true" className="text-lg">
            ▶
          </span>
        </button>
        <div className="flex-1 flex flex-col gap-1" aria-hidden="true">
          <div className="h-8 flex items-center gap-1 overflow-hidden">
            {playedBars.map((h, i) => (
              <span
                key={`p-${i}`}
                style={{ height: `${h}px` }}
                className="w-1 rounded-full bg-seaGlass"
              />
            ))}
            {unplayedBars.map((h, i) => (
              <span
                key={`u-${i}`}
                style={{ height: `${h}px` }}
                className="w-1 rounded-full bg-borderWarm"
              />
            ))}
          </div>
          <div className="flex justify-between text-xs uppercase tracking-wider text-muted">
            <span>{timeStart}</span>
            <span>{timeEnd}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

interface AlignmentItemProps {
  readonly title: string;
  readonly body: string;
  readonly testId: string;
}

function AlignmentItem({ title, body, testId }: AlignmentItemProps) {
  return (
    <div
      className="p-3 rounded-lg bg-canvas border border-borderWarm flex items-start gap-3"
      data-testid={testId}
    >
      <span aria-hidden="true" className="text-aubergine text-lg shrink-0 mt-0.5">
        ✓
      </span>
      <div className="flex flex-col">
        <span className="text-base font-medium text-ink">{title}</span>
        <span className="text-sm text-muted">{body}</span>
      </div>
    </div>
  );
}

interface MethodologyStepProps {
  readonly n: number;
  readonly title: string;
  readonly body: string;
  readonly meta: string;
  readonly testId: string;
}

function MethodologyStep({ n, title, body, meta, testId }: MethodologyStepProps) {
  return (
    <article
      className="bg-surface border border-borderWarm rounded-xl p-5 flex flex-col gap-4"
      data-testid={testId}
    >
      <div>
        <div className="w-10 h-10 rounded-lg bg-canvas border border-borderWarm flex items-center justify-center font-serif text-xl text-aubergine mb-3">
          {n}
        </div>
        <h3 className="font-serif text-lg text-ink leading-tight">{title}</h3>
        <p className="text-sm text-muted mt-2">{body}</p>
      </div>
      <div className="mt-auto pt-2 border-t border-borderWarm text-xs uppercase tracking-wider text-seaGlass font-semibold flex items-center gap-1">
        {meta}
        <span aria-hidden="true">→</span>
      </div>
    </article>
  );
}
