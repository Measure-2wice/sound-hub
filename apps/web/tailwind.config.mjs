/** @type {import('tailwindcss').Config} */
// Caribbean Studio palette tokens (M2 #82).
//
// Background: the M2 UX addendum (`docs/specs/milestone-2-reconciled-ux.md:253-267`)
// locks the Caribbean Studio visual character. #82 owns the warm parchment canvas,
// warm restrained surface, warm neutral borders, ink/muted typography, the aubergine
// semantic-action family, and a restrained gold accent reserved for genuine recovery.
//
// Additive only. The legacy `primary` blue family is preserved in the config because
// unrelated surfaces still reference it; it is intentionally NOT migrated to aubergine
// in this pass (#82 only owns the surfaces called out in the visual-QA remediation).
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
      },
    },
  },
  plugins: [],
};
