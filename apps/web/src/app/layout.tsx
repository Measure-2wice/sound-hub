import type { Metadata } from "next";
import "./globals.css";
import { Navigation } from "./components/Navigation";
import { SessionProvider } from "./components/SessionProvider";

export const metadata: Metadata = {
  title: "SoundHub Talent",
  description: "Discover Caribbean creative talent and the services they offer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50">
        {/* SessionProvider is the shared seam every auth-aware
            client component (the navigation, the dashboard, the
            magic-link verifier, the login page's dev verification
            handler) reads from. It owns the authoritative user
            state, fetches it once from `/api/auth/me`, and exposes
            helpers that re-pull after verify / sign-out so the UI
            stays in lock-step without a full page reload. */}
        <SessionProvider>
          <Navigation />
          <main className="pt-4">{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
