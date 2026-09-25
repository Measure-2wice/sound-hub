/** @type {import('tailwindcss').Config} */
// Caribbean Studio palette + typography tokens (M2 #82 + #83, plus the post-#83
// visual-parity pass).
//
// Background: the M2 UX addendum (`docs/specs/milestone-2-reconciled-ux.md:253-267`)
// locks the Caribbean Studio visual character. #82 owns the warm parchment canvas,
// warm restrained surface, warm neutral borders, ink/muted typography, the aubergine
// semantic-action family, and a restrained gold accent reserved for genuine recovery.
// #83 extends the palette with coral (marketplace progression only — `Find talent`,
// `Send project request`, `Publish profile`, `Activate service`) and sea-glass
// (supporting state — selected controls, readiness, availability, audio/progress).
//
// The post-#83 visual-parity pass binds `font-serif` to Playfair Display (loaded
// via `next/font/google` in `apps/web/src/app/layout.tsx`) and `font-sans` to Plus
// Jakarta Sans, matching the Stitch `soundhub_design_system/DESIGN.md` type stack.
// It also darkens `coral.DEFAULT` from the Stitch `#E05A47` to `#C04A35` so white
// text on the coral CTA surface meets WCAG 2.1 AA (≥ 4.5:1) — computed contrast on
// #C04A35 = 4.91:1; on the previous #E05A47 = 3.67:1 (FAILS). The hover variant is
// `#A03E2A` (6.53:1, AAA for large text) so the :hover/:focus-visible state stays
// distinguishable from the rest state.
//
// Additive only. The legacy `primary` blue family is preserved in the config because
// unrelated surfaces still reference it; it is intentionally NOT migrated to aubergine
// in this pass (#82/#83 only own the surfaces called out in the visual-QA remediation).
export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Bound to the Playfair Display + Plus Jakarta Sans CSS variables exposed by
        // `next/font/google` in `apps/web/src/app/layout.tsx`. Every existing
        // `font-serif` Tailwind class (used by the dashboard heading, intent page,
        // workspace switch page, and landing page) automatically picks up Playfair.
        serif: ["var(--font-playfair)", "Georgia", "serif"],
        jakarta: ["var(--font-jakarta)", "system-ui", "sans-serif"],
        sans: ["var(--font-jakarta)", "system-ui", "sans-serif"],
      },
      colors: {
        // Legacy primary blue — preserved for surfaces outside #82.
        primary: {
          50: "#eff6ff",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
        },
        // Caribbean Studio — see header comment.
        canvas: "#FAF7F2",
        surface: "#F4EFEA",
        borderWarm: "#E8DFD5",
        ink: "#19151D",
        muted: "#4D444B",
        aubergine: {
          DEFAULT: "#3B1E3E",
          hover: "#5a3061",
        },
        gold: "#A8763E",
        // M2 (#83): marketplace progression. Coral means progression
        // into or through marketplace participation — `Find talent`,
        // `Send project request`, `Publish profile`, `Activate
        // service`. Must not be applied merely because a button is
        // important or visually dominant.
        //
        // The post-#83 visual-parity pass darkens DEFAULT/hover from
        // the Stitch `#E05A47` so white text on the coral CTA surface
        // meets WCAG 2.1 AA. See the file header for the contrast math.
        coral: {
          DEFAULT: "#C04A35",
          hover: "#A03E2A",
        },
        // M2 (#83): supporting state — selected controls, readiness
        // and completion, marketplace availability, audio/progress.
        // Sea-glass is NOT one universal `success` state; meanings
        // remain distinct through labels, icons, component anatomy,
        // and surrounding copy.
        seaGlass: {
          DEFAULT: "#5C9E94",
          hover: "#4d887f",
        },
      },
    },
  },
  plugins: [],
};
