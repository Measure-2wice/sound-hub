import type { Metadata } from "next";
import { Playfair_Display, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { Shell } from "./components/Shell";
import { SessionProvider } from "./components/SessionProvider";

// Playfair Display + Plus Jakarta Sans, loaded via `next/font/google` so the
// fonts are self-hosted (no Google Fonts runtime request), eliminate FOUT, and
// expose their computed metrics through the CSS variables the Tailwind config
// binds to `font-serif` / `font-sans` / `font-jakarta`.
//
// Weights match the Stitch `soundhub_design_system/DESIGN.md` type stack:
//   - Playfair Display: roman 500/600/700 + italic 400 (literary serif headings).
//   - Plus Jakarta Sans: 400/500/600/700 (UI body / labels / metadata).
const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-playfair",
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jakarta",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SoundHub",
  description: "Discover Caribbean creative talent and the services they offer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${playfair.variable} ${jakarta.variable}`}>
      <body className="min-h-screen bg-canvas font-jakarta">
        {/* SessionProvider is the shared seam every auth-aware
            client component (the Shell, the dashboard, the
            magic-link verifier, the login page's dev verification
            handler, the workspace/intent and workspace/switch
            pages) reads from. It owns the authoritative user
            state, fetches it once from `/api/auth/me`, and
            exposes helpers that re-pull after verify / sign-out
            so the UI stays in lock-step without a full page
            reload. The Shell mounts both the capability-aware
            navigation and the persistent acting-Workspace
            context. */}
        <SessionProvider>
          <Shell />
          <main className="pt-4">{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
