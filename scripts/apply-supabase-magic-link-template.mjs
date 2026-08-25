#!/usr/bin/env node
// Apply the BG1 canonical magic-link email template to the
// configured Supabase project via the Supabase Management API.
//
// Background: ticket #59 P1-002 requires the deployed managed
// magic-link journey to deliver a link of the form
// `<AUTH_CALLBACK_URL>?token=<token_hash>` so the browser's
// `MagicLinkVerifier` component can extract the credential from
// `?token=...` and POST it to `/api/auth/verify-token`. The
// Supabase default magic-link email does NOT append the raw
// token hash to the redirect — operators MUST replace the
// default body with the canonical template committed in this
// branch at `supabase/magic-link-email-template.html`.
//
// Usage:
//
//   SUPABASE_PROJECT_REF=<project-ref> \
//   SUPABASE_MANAGEMENT_TOKEN=<personal-access-token> \
//     node scripts/apply-supabase-magic-link-template.mjs
//
// Reference: https://api.supabase.com/api/v1

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const MANAGEMENT_TOKEN = process.env.SUPABASE_MANAGEMENT_TOKEN;
const TEMPLATE_SUBJECT = process.env.SUPABASE_MAGIC_LINK_SUBJECT ?? "Sign in to SoundHub";
const TEMPLATE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "magic-link-email-template.html",
);

if (!PROJECT_REF) {
  console.error("SUPABASE_PROJECT_REF is required (the Supabase project ref / slug).");
  process.exit(2);
}
if (!MANAGEMENT_TOKEN) {
  console.error("SUPABASE_MANAGEMENT_TOKEN is required (a Supabase personal access token).");
  process.exit(2);
}

const templateBody = readFileSync(TEMPLATE_PATH, "utf8");

const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(PROJECT_REF)}/config/auth`;
const response = await fetch(url, {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${MANAGEMENT_TOKEN}`,
  },
  body: JSON.stringify({
    mailer_subjects_magic_link: TEMPLATE_SUBJECT,
    mailer_templates_magic_link_content: templateBody,
  }),
});
if (!response.ok) {
  const text = await response.text();
  console.error(
    `Supabase Management API rejected the template update (${response.status}): ${text}`,
  );
  process.exit(1);
}

console.log(
  `Applied BG1 magic-link email template to Supabase project ${PROJECT_REF} (subject: "${TEMPLATE_SUBJECT}").`,
);
console.log(
  "Verify the rendered template in Supabase Studio → Authentication → Email Templates → Magic Link before declaring the managed path Golden-Slice-ready.",
);
