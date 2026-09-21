"use client";

// Public Talent search surface (M2 #83).
//
// Background: the M2 spec renames the public search route from
// `/` to `/talent`. The component itself (SearchPage) is
// unchanged from BG3; the route move is the only difference.
// The M2 landing page (`/`) replaces the previous root with
// the new Caribbean Studio public landing that surfaces the
// `Find talent` CTA.
//
// The route is accessible to anonymous and authenticated
// users alike; no capability gate.

import { SearchPage } from "../components/SearchPage";

export default function TalentPage() {
  return <SearchPage />;
}
