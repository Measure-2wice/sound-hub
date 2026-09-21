import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "./components/Shell";
import { SessionProvider } from "./components/SessionProvider";

export const metadata: Metadata = {
  title: "SoundHub",
  description: "Discover Caribbean creative talent and the services they offer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas">
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
