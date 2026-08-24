// Top navigation. Renders the SoundHub title plus a sign-in / sign-out
// affordance backed by the BG1 authentication API. The nav is a
// server component for the title (so it renders statically) and a
// client component for the auth state. The split keeps the server-
// rendered title in the static HTML while letting the auth widget
// revalidate via the session-info endpoint.

import Link from "next/link";
import { SessionStatus } from "./SessionStatus";

export function Navigation() {
  return (
    <nav className="bg-white shadow-lg border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <div className="flex-shrink-0">
            <Link href="/" className="text-2xl font-bold text-blue-600">
              🎧 SoundHub Talent
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <SessionStatus />
          </div>
        </div>
      </div>
    </nav>
  );
}
