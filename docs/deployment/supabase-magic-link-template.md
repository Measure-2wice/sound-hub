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
`/auth/v1/verify` endpoint is `email` — Supabase's current
wire-level type for token-hash verification (the user-facing
product is still email magic-link authentication; `type: "email"`
is Supabase's wire-level discriminator). The serving adapter
(`apps/api/src/identity/managed-identity-adapter.ts`) pins this
value internally. Per ticket #59 the BG1 adapter has no runtime
switch — BG1 only supports this verification type, so the email
template MUST be the Supabase magic-link template (Studio →
Authentication → Email Templates → Magic Link). The template
variables `{{ .TokenHash }}` and `{{ .SiteURL }}` are the ones
the BG1 adapter consumes; the verify call's pinned
`type: "email"` matches the magic-link template contract.

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

## Verifying the deployed template

Per ticket #59 the application-startup configuration smoke
(`apps/api/src/identity/startup-smoke.ts`) only validates that
the configured Supabase project's `/auth/v1/health` endpoint
responds 2xx within the bounded timeout — it does NOT request,
consume, or revoke a live Supabase OTP. End-to-end managed
email verification is validated by the explicit bounded
operational smoke procedure documented at
[`docs/deployment/managed-provider-smoke.md`](./managed-provider-smoke.md).
Operators cannot declare the managed path Golden-Slice-ready
without successfully completing that procedure.
