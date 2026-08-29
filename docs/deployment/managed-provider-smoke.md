# BG1 Managed Provider — Bounded Deployed Smoke Procedure

The BG1 Golden Slice requires a **bounded deployed-environment
managed-auth smoke** that proves the managed magic-link
authentication journey is end-to-end functional in the deployed
environment. Per ticket #59 this smoke is an explicit operational
procedure — **not** an application-startup health check. Normal
application startup only validates managed-auth configuration
and constructs the managed adapter; the deployed smoke is run by
an operator against the deployed environment before declaring
the managed path Golden-Slice-ready.

The startup configuration smoke
(`apps/api/src/identity/startup-smoke.ts`) is bounded to the
`/auth/v1/health` endpoint and never requests, consumes, or
revokes a live Supabase OTP. This keeps normal startup fast,
network-bounded, and free of side effects on the managed
provider's email channel.

The deployed smoke procedure below is the **only** mechanism that
proves the deployed managed path is fully functional end-to-end.
Operators cannot declare the managed path Golden-Slice-ready
without successfully completing every step.

## Pre-requisites

- The deployed SoundHub API is reachable.
- The deployed SoundHub web app is reachable.
- The Supabase project has the BG1 magic-link email template
  applied (see
  [`docs/deployment/supabase-magic-link-template.md`](./supabase-magic-link-template.md)).
- The operator has access to a real mailbox that the deployed
  Supabase project can deliver email to (do NOT use a sentinel
  `.example` address — it cannot receive the delivered email and
  the journey cannot be exercised end-to-end).
- The deployed API has the BG1 managed-adapter env vars set
  (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_CALLBACK_URL`).

## Procedure

The procedure proves the deployed managed path end-to-end. Each
step asserts a property of the deployed configuration; a failure
at any step is a deployment defect that must be corrected before
the managed path is declared Golden-Slice-ready.

### Step 1 — Request a new email magic link

From the deployed web app's login page, submit the operator's
real mailbox via the magic-link endpoint
(`POST /api/auth/magic-link` with the operator's email). The
response is a neutral envelope carrying a `requestId` correlation
id; that id is **not** a verification credential. The deployed
Supabase project's OTP endpoint must accept the request and
trigger email delivery.

### Step 2 — Receive the newly delivered email

Confirm the operator's mailbox receives a fresh email from the
deployed Supabase project. The email's action link MUST be of
the form `<AUTH_CALLBACK_URL>?token=<token_hash>` so the browser
can extract the credential from `?token=...`. The Supabase
default magic-link email does NOT embed the raw token hash —
the deployed project MUST use the canonical BG1 template from
`supabase/magic-link-email-template.html`.

### Step 3 — Follow the callback

Open the email's action link in a browser. The browser's
`MagicLinkVerifier` component
(`apps/web/src/app/components/MagicLinkVerifier.tsx`) reads the
credential from `?token=...` and POSTs it to
`/api/auth/verify-token` as `verificationToken`.

### Step 4 — Verify the token hash

The deployed API's `AuthenticationService.verifySignIn` invokes
the managed adapter's `verifySignIn`, which posts the token to
Supabase's `/auth/v1/verify` endpoint with
`{ token_hash, type: "email" }`. Supabase returns the
access-token / session envelope (access_token, token_type,
expires_in, refresh_token, user). The adapter parses the
envelope with a forward-compatible Zod schema and derives
identity from the allow-listed `id` and `email` only.

### Step 5 — Map provider identity to a persisted UserAccount

The deployed `AuthRepository` resolves the verified
`(provider, subject)` tuple to a persisted `UserAccount`
(via `IdentityProvider`). On first sign-in the repository
creates a new `UserAccount` + `IdentityProvider` row, persists
the provider email, and returns the durable account id.

### Step 6 — Establish a SoundHub server-side session

The deployed `AuthenticationService` issues an opaque,
server-validated `AuthSession` row and the API responds with
an `HttpOnly` session cookie. The session id is the ONLY
authoritative identity signal — the cookie is `HttpOnly` so the
client cannot read or replay the session id.

### Step 7 — Authenticated `/me` or dashboard succeeds

With the issued cookie, the operator's browser reaches an
authenticated endpoint (e.g. `/api/auth/session` or the
authenticated dashboard) and the response carries the resolved
public user view (id, email, identity provider, workspaces).
This proves the deployed session boundary round-trips back to
the same UserAccount that was created in Step 5.

### Step 8 — Sign out / revoke

From the authenticated dashboard, sign out. The deployed
`POST /api/auth/sign-out` endpoint revokes the `AuthSession`
row (`revokedAt` set to `now`). The session id is now
explicitly revoked server-side.

### Step 9 — Authenticated lookup subsequently fails

Re-attempt the authenticated endpoint from Step 7 in the same
browser. The revoked session is rejected — the response carries
the public envelope with `user: null` and no workspaces. The
session id cannot be replayed; a fresh sign-in is required.

## Failure modes

| Failure                                       | Likely cause                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Step 1 — no email delivered                   | Supabase project not configured, env vars missing, or rate-limited.                          |
| Step 2 — email's link is missing `?token=...` | Default Supabase magic-link template still in use; re-apply the BG1 template.                |
| Step 4 — Supabase verify returns 4xx          | Stale or already-consumed token; retry with a freshly delivered link.                        |
| Step 4 — Supabase verify returns 5xx          | Managed provider unavailable; the deterministic fallback is the approved deployed emergency. |
| Step 5 — no `UserAccount` row appears         | `AuthRepository` misconfigured or database unreachable.                                      |
| Step 7 — authenticated lookup returns 401     | Session cookie not set, revoked, or expired; re-run Steps 1–6 with a fresh delivery.         |
| Step 9 — authenticated lookup still succeeds  | `revokeSession` not invoked or session row not updated; the revocation path is broken.       |

A failure at any step is a deployment defect — fix the deployed
configuration and re-run the procedure. The managed path is not
Golden-Slice-ready until all nine steps succeed in order against
the deployed environment.

## Notes

- This procedure is intentionally an explicit operator-driven
  smoke rather than an automated application-startup health
  check. The BG1 application startup is bounded to a single
  `/auth/v1/health` HEAD call so a hung network call cannot
  block startup and the startup process never requests,
  consumes, or revokes a live OTP.
- Per ticket #59 the application-startup smoke does NOT bind
  captured tokens to OTP issuance via mutable user metadata —
  end-to-end freshness is proven by the operator initiating a
  new request and following the callback in the same session.
- Deterministic automated tests continue to exercise the
  application contracts (adapter, session seam, authorization)
  without contacting a live provider; they are not a substitute
  for this deployed procedure.
