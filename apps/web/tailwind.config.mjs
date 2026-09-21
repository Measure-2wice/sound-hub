/** @type {import('tailwindcss').Config} */
// Caribbean Studio palette tokens (M2 #82 + #83).
//
// Background: the M2 UX addendum (`docs/specs/milestone-2-reconciled-ux.md:253-267`)
// locks the Caribbean Studio visual character. #82 owns the warm parchment canvas,
// warm restrained surface, warm neutral borders, ink/muted typography, the aubergine
// semantic-action family, and a restrained gold accent reserved for genuine recovery.
// #83 extends the palette with coral (marketplace progression only — `Find talent`,
// `Send project request`, `Publish profile`, `Activate service`) and sea-glass
// (supporting state — selected controls, readiness, availability, audio/progress).
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
        coral: {
          DEFAULT: "#E05A47",
          hover: "#c64d3c",
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
