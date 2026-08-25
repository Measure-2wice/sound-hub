# Deploying the BG1 Supabase magic-link email template

The BG1 managed authentication journey requires the hosted Supabase
project's **Magic Link** email template to embed the raw
`token_hash` directly in the redirect URL, so the browser's
`MagicLinkVerifier` component (`apps/web/src/app/components/MagicLinkVerifier.tsx`)
can read the credential from `?token=...` and POST it to
`/api/auth/verify-token` as `verificationToken`.

The Supabase **default** magic-link email does **not** append the
raw token hash to the redirect URL — it uses an implicit-grant
session fragment that the browser cannot hand to a server-side
boundary. The deployed Golden Slice therefore requires the
operator to replace the default template body with the canonical
version committed in this branch.

## What the template must look like

The deployed template's action link MUST be of the form:

```text
{{ .SiteURL }}/auth/callback?token={{ .TokenHash }}
```

The canonical HTML body is at
[`supabase/magic-link-email-template.html`](../../supabase/magic-link-email-template.html).

The matching verify `type` posted by the server to Supabase's
`/auth/v1/verify` endpoint (`MANAGED_VERIFY_TYPE` env var,
default `magiclink`) MUST match the email template's declared
type so the verification call accepts the captured credential.

## Applying the template

The Supabase Studio is the authoritative configuration surface
for email templates. Operators apply the template once per
project.

1. Sign in to the [Supabase dashboard](https://supabase.com/dashboard)
   and select the deployed project.
2. Navigate to **Authentication → Email Templates → Magic Link**.
3. Replace the **Message (HTML)** body with the contents of
   `supabase/magic-link-email-template.html`. The template uses
   `{{ .SiteURL }}` and `{{ .TokenHash }}` template variables
   which Supabase fills in at delivery time.
4. Save the template.

### Programmatic application (optional)

`scripts/apply-supabase-magic-link-template.mjs` updates the
template via the Supabase Management API. Operators who prefer
a reproducible, reviewable, version-controlled deployment can
run:

```bash
SUPABASE_PROJECT_REF=<project-ref> \
SUPABASE_MANAGEMENT_TOKEN=<personal-access-token> \
  node scripts/apply-supabase-magic-link-template.mjs
```

The script performs a `PATCH` against
`https://api.supabase.com/v1/projects/{ref}/config/auth` with the
canonical template body and subject. Operators should still
verify the Studio view after the script runs to confirm the
template rendered correctly.

## Verifying the deployed template (bounded deployed smoke)

The BG1 startup smoke (`apps/api/src/identity/startup-smoke.ts`)
proves the managed path is Golden-Slice-ready only when ALL of:

- The configured smoke mailbox (`BG1_SMOKE_MAILBOX`) is reachable
  via the deployed Supabase project (the OTP endpoint accepts a
  request addressed to that mailbox).
- The captured magic-link token resolves through the
  `AuthenticationService` boundary into a persisted UserAccount
  AND a SoundHub AuthSession (the session probe).
- The **verified provider email** equals the configured smoke
  mailbox — proving the captured credential was actually issued
  for the smoke mailbox (not a stale token for some other
  account).

When `BG1_SMOKE_MAILBOX` is unset, the smoke reports
`session-coverage-incomplete` and the factory selects the
deterministic fallback as the approved deployed emergency path.
Operators cannot declare the managed path Golden-Slice-ready
without exercising the delivered-link journey.

The bounded smoke cannot directly read the deployed template's
content (Supabase does not expose email template bodies via
API), but the mailbox-correlation assertion proves the
delivered credential was issued for the configured mailbox —
which is what the browser will receive when it follows the
deployed template's link.
