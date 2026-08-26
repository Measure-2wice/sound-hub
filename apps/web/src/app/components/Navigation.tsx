// Top navigation. Renders the SoundHub title plus a sign-in / sign-out
// affordance backed by the BG1 authentication API. The nav is a
// server component for the title (so it renders statically) and a
// client component for the auth state. The split keeps the server-
// rendered title in the static HTML while letting the auth widget
// revalidate via the session-info endpoint.
//
// The Matchmaker link is only rendered for authenticated buyers.
// The session-aware SessionStatus widget owns the visibility
// signal; the link itself stays a static server component so
// it does not double-render during hydration.

import Link from "next/link";
import { SessionStatus } from "./SessionStatus";

export function Navigation() {
  return (
    <nav className="bg-white shadow-lg border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-2xl font-bold text-blue-600">
              🎧 SoundHub Talent
            </Link>
            <SessionAwareMatchmakerLink />
          </div>
          <div className="flex items-center gap-4">
            <SessionStatus />
          </div>
        </div>
      </div>
    </nav>
  );
}

// Renders the Matchmaker entry only when a user is signed in.
// Server-rendered as a placeholder so the static markup includes
// the link shell; the SessionProvider on the client hydrates it
// with the actual signed-in state.
function SessionAwareMatchmakerLink() {
  return (
    <Link
      href="/matchmaker"
      className="text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors"
      data-testid="nav-matchmaker-link"
    >
      Matchmaker
    </Link>
  );
}
