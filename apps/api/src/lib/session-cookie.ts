// Session cookie helpers.
//
// Background: BG1 requires the session cookie to be the only
// authoritative identity signal. We use a fixed cookie name, an
// opaque session id as the value, and HttpOnly + SameSite=Lax so the
// browser cannot read or script the value and the cookie auto-rides
// on top-level same-origin requests. `Secure` is enabled outside
// local development; in development we keep it off so the cookie is
// accepted on `http://localhost:3000`.

import type { Response } from "express";

export const SESSION_COOKIE = "soundhub_session";

const ONE_DAY_SECONDS = 24 * 60 * 60;

/**
 * Write the session cookie on the response. The expiresAt argument is
 * the absolute expiry derived from the server's authoritative clock;
 * the route sets it once on session creation and trusts the
 * server-side session row thereafter. The HttpOnly + SameSite=Lax
 * attributes are intentional; the cookie must never be readable from
 * browser JavaScript (the route sets the cookie, the browser sends
 * it, and the server validates it).
 */
export function setSessionCookie(res: Response, sessionId: string, expiresAt: Date): void {
  const isProduction = process.env.NODE_ENV === "production";
  const maxAgeSeconds = Math.max(
    1,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000) || ONE_DAY_SECONDS,
  );
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isProduction) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

/**
 * Clear the session cookie. The Max-Age=0 instructs the browser to
 * drop the cookie immediately; the matching Path is the one we set
 * on creation so the browser actually finds the row to drop.
 */
export function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}
