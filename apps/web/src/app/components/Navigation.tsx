"use client";

// Top navigation. Renders the SoundHub title plus a sign-in / sign-out
// affordance backed by the BG1 authentication API.
//
// The Matchmaker entry is Buyer-gated; the Seller requests entry is
// Seller-gated. Both hide themselves for unauthenticated visitors
// and for users whose workspaces do not carry the required
// capability.
//
// SessionStatus owns the visible sign-in / sign-out affordance; the
// Matchmaker and Seller-requests links own their own auth-aware
// visibility because their gating is capability-specific.

import Link from "next/link";
import { useSession } from "./SessionProvider";
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
            <SessionAwareSellerRequestsLink />
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard/audio"
              className="text-sm font-medium text-gray-600 hover:text-gray-900"
              data-testid="nav-audio-samples"
            >
              Audio samples
            </Link>
            <SessionStatus />
          </div>
        </div>
      </div>
    </nav>
  );
}

// Renders the Matchmaker entry only when the signed-in user has at
// least one Buyer-capable Workspace. The server component shell
// never emits the link, so unauthenticated visitors and
// authenticated users without a Buyer Workspace do not see it.
function SessionAwareMatchmakerLink() {
  const { user, loading } = useSession();
  if (loading || !user) return null;
  const hasBuyerWorkspace = user.workspaces.some((w) => w.capabilities.includes("Buyer"));
  if (!hasBuyerWorkspace) return null;
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

// Renders the Seller-requests inbox entry only when the signed-in
// user has at least one Seller-capable Workspace. Mirrors the
// Matchmaker gating pattern so a Buyer-only Workspace never sees
// the inbox link.
function SessionAwareSellerRequestsLink() {
  const { user, loading } = useSession();
  if (loading || !user) return null;
  const hasSellerWorkspace = user.workspaces.some((w) => w.capabilities.includes("Seller"));
  if (!hasSellerWorkspace) return null;
  return (
    <Link
      href="/seller-requests"
      className="text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors"
      data-testid="nav-seller-requests-link"
    >
      Seller inbox
    </Link>
  );
}
