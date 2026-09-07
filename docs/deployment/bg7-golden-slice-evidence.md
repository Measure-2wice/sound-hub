# BG7 — Buildathon Golden Slice Deployed-Beta Evidence

> **Status:** Final BG7 deployed-beta evidence record. Every
> claim below is anchored to an artifact, code path, or operator
> observation that already exists in the repository or in the
> production Railway deployment.
>
> **Architectural distinction (per the spec):**
>
> - There is **one** integrated product Golden Slice browser
>   journey, implemented by Playwright against real disposable
>   PostgreSQL using the deterministic adapters for auth, AI,
>   storage, and escrow. That journey is the local
>   `golden-slice.spec.ts` run; it is described in `AC1`–`AC3`
>   below.
> - The deployed-beta smoke is **not** a second complete product
>   journey. It is provider verification: managed Supabase
>   Auth + managed Supabase Storage + deployed runtime/API
>   reachability. It is described in `AC4`, `AC5` (live), and
>   `AC7` (live runtime / API evidence) below.
>
> No claim below relies on evidence that was not observed.

## Acceptance Criteria Evidence

### AC1 — One integrated browser journey against real disposable PostgreSQL

- **Spec artifact:** `apps/web/e2e/golden-slice.spec.ts` —
  the single integrated BG7 (ticket #65) browser journey.
  Exercises the complete buyer → Active Deal sequence against
  real disposable PostgreSQL via the Next.js dev server + the
  Express API + Prisma, with the deterministic adapters wired
  through `webServer.env` (see `AC2`).
- **Spec coverage:** Step 1 buyer sign-in via deterministic
  magic-link; Step 2 natural-language brief through
  Matchmaker to validated PostgreSQL `TalentSearchService`
  results; Step 3 inline `<audio>` preview reaching a usable
  media state; Step 4 `ProjectRequest` creation with
  `Pending` state; Step 5 seller sign-in; Step 6 explicit
  ProjectRequest acceptance creating exactly one `Negotiating`
  Deal; Step 7 Deal discovery through the shipped `/deals`
  row click flow (ticket #74); Step 8 AI-drafted immutable
  `TermsVersion 1` + seller approval; Step 9 buyer sign-in,
  approval, and explicit sandbox funding activating the Deal;
  Step 10 terminal Active copy + truthful labels + DTO
  privacy asserts.
- **Reproducibility:** any reviewer can re-run the journey
  locally with `pnpm test:e2e -- golden-slice.spec.ts`. The
  spec, fixtures, and `webServer.env` are the durable
  artifact. The runtime pre-requisites (PostgreSQL on
  `localhost:5433`, deterministic seed, web on `:3000`, API
  on `:4000`) match the standard local-development setup
  documented in `CLAUDE.md`.

### AC2 — Journey crosses the same application interfaces as deployed providers while remaining deterministic

- **Composition-root wiring:** the two flags below are the
  only **adapter-selection** overrides set by
  `apps/web/playwright.config.ts` `webServer.env`. They both
  select a real adapter implementation wired through the same
  factory + composition root (`apps/api/src/index.ts`) that
  selects the managed adapters in production — the journey
  crosses the same Next.js → same-origin proxy → Express →
  runtime-validated contract → authorization service → Prisma
  repository → disposable PostgreSQL path that the deployed
  providers do.
  - `BG1_DETERMINISTIC_OPERATOR_MODE: "1"` — selects the
    deterministic identity adapter so its dev verification
    URL surfaces inside the browser.
  - `BG2_STORAGE_BACKEND: "deterministic"` — selects the
    in-process storage adapter so the audio fixture is
    hydrated by the adapter rather than a managed bucket.
- **Other `webServer.env` overrides (NOT adapter-selection):**
  `PORT`, `API_URL`, `DATABASE_URL`, `TEST_DATABASE_URL`,
  `NODE_ENV`, `FRONTEND_URL`, `PUBLIC_FIXTURE_ORIGIN`,
  `PUBLIC_API_BASE_URL`, `PORT_WEB`. These are local-dev
  wiring (database URL, ports, CORS origin, deterministic
  fixture origin) and do not change which adapter the
  factory selects.
- **No mocks in the Golden Slice journey:** the only env
  overrides that affect application behavior are the two
  adapter-selection flags above. No `page.route()` stub
  intercepts the application traffic. The `chromium` project
  ignores the dedicated `chromium-outage` fault-injection
  spec by design (outage is covered separately, and the
  outage project runs only after `chromium` succeeds — see
  the comment block at the top of
  `apps/web/playwright.config.ts`).

### AC3 — Active Deal view displays seller consent, both approvals, sandbox funding confirmation, and the terminal message

The spec acceptance criterion (buildathon-golden-slice.md §27)
requires five Active-Deal evidence elements. The journey spec
asserts each at the surface it actually renders on; the
deployed smoke does **not** exercise a second Active Deal
journey.

| Required element                                        | Where it is rendered/asserted in the journey                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Seller consent** (explicit ProjectRequest acceptance) | Persisted as `ProjectRequest.sellerConsentAt`, projected through the narrow `sellerConsent` field on the public Deal view, and rendered on the Active Deal page as `Seller consent: Accepted` in `data-testid="deal-seller-consent"`. `golden-slice.spec.ts` Step 10 asserts the indicator is visible, contains the accepted copy, and carries `data-consent-status="Accepted"`.                                                 |
| **Buyer approval**                                      | Asserted on the Deal page. Step 9 clicks `deal-approve-button` and asserts `deal-terms-ai-badge` transitions to `/approved/i`. The row is rendered by `apps/web/src/app/deals/[dealId]/page.tsx` lines 678–687 as `data-testid="deal-approvals"` with rows `data-testid="deal-approval"` ("Buyer: Approved at …" or "Pending"). Built by `buildApprovalStatusRows` in `apps/web/src/app/deals/deal-summary-copy.ts` lines 67–79. |
| **Seller approval**                                     | Same `deal-approvals` rows on the Deal page (Step 8: seller clicks `deal-approve-button`; assertion is on the `Seller:` row transitioning to "Approved at …"). Built by the same `buildApprovalStatusRows` helper.                                                                                                                                                                                                               |
| **Sandbox funding confirmation**                        | Asserted on the Deal page. The funding surface is rendered by `apps/web/src/app/deals/[dealId]/page.tsx` lines 449–515 (`data-testid="deal-funding-card"`). After `deal-fund-button` is clicked in Step 9, the spec asserts the Active terminal appears — i.e., the deterministic activation invariant fired and the funding confirmation is persisted.                                                                          |
| **Terminal message**                                    | `apps/web/src/app/deals/[dealId]/page.tsx` line 512 renders the exact copy `Deal Active — escrow funded; commissioned work may begin.` inside `data-testid="deal-active-terminal"`. Asserted by Step 10 line 247 (`toHaveText(TERMINAL_ACTIVE_COPY)`, defined line 45).                                                                                                                                                          |

**Scope note:** the Deployed Beta smoke (`AC4`, `AC7`) is
intentionally provider verification. It does not exercise a
second Active Deal journey; this AC is proven solely by the
local deterministic Playwright spec running against real
disposable PostgreSQL.

### AC4 — Managed Supabase authentication and storage smoke passes against deployed environment

**Procedure reference:** `docs/deployment/managed-provider-smoke.md`
(9-step BG1 managed Auth procedure + bounded managed Storage
verification). Every step was exercised by the operator against
the deployed Railway environment using real SoundHub email
delivery.

#### Managed Supabase Auth smoke — PASS

The 9-step procedure defined in
`docs/deployment/managed-provider-smoke.md` was exercised by
the operator against the deployed Railway environment. Each
row below records the procedure step and the operator
observation. Operator transcripts (browser screenshots, copied
clipboard values, etc.) are **not retained in the repository**;
the procedure document IS the bound on the procedure, and the
table below IS the bound on what was observed.

| Step | Procedure (per `managed-provider-smoke.md`)                                                                                         | Operator observation                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | Submit operator's real mailbox via the deployed `POST /api/auth/magic-link` from the deployed login page                            | The deployed Supabase project's `/auth/v1/otp` accepted the request and triggered email delivery.             |
| 2    | Real email delivered through deployed Supabase; the action link is `<AUTH_CALLBACK_URL>?token=<token_hash>`                         | A real SoundHub email arrived at the operator mailbox with the BG1 magic-link action link carrying `?token=`. |
| 3    | Browser opens the action link; `MagicLinkVerifier` reads `?token=…` and POSTs it to `/api/auth/verify-token` as `verificationToken` | The browser navigated through the deployed SoundHub callback and reached the post-verify state.               |
| 4    | Deployed `AuthenticationService.verifySignIn` exchanges the token at `POST /auth/v1/verify` with `{ token_hash, type: "email" }`    | Supabase returned a 2xx access-token / session envelope; the managed adapter parsed the verified envelope.    |
| 5    | Deployed `AuthRepository` resolves `(provider, subject)` to a persisted `UserAccount` + `IdentityProvider` row                      | A new `UserAccount` row was created (or reused) and the provider email was persisted.                         |
| 6    | Deployed `AuthenticationService` issues an opaque `AuthSession` row and an `HttpOnly` session cookie                                | The browser received the session cookie and reached the authenticated dashboard.                              |
| 7    | Authenticated `GET /api/auth/me` returns the resolved public user view                                                              | The response carried the resolved public user view; the provider key was `managed-magic-link`.                |
| 8    | Operator signed out via `POST /api/auth/sign-out`                                                                                   | The `AuthSession` row was revoked server-side (`revokedAt` set).                                              |
| 9    | Re-attempt of the authenticated endpoint from Step 7 in the same browser                                                            | The browser landed on the signed-out page rendering `You are not signed in. Sign in to continue.`             |

**Result:** PASS — every step of the 9-step managed Auth smoke
procedure succeeded against the deployed environment. The
acting Workspace `Creole Beats Brooklyn` (Seller capability)
appeared in the authenticated view after the production
deterministic seed (see `AC7`).

#### Managed Supabase Storage smoke — PASS

The operator used the deployed SoundHub UI acting through the
seeded Seller-capable Workspace `Creole Beats Brooklyn` and
the canonical seeded `ServiceOffering`
`Haitian dancehall single production — remote`. The operator
performed each step against the deployed
`POST /api/services/:offeringId/audio-samples` route via the
deployed seller UI:

| Step | Procedure                               | Observed                                                                                                             |
| ---- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1    | Select acting Workspace                 | `Creole Beats Brooklyn` selected; the seller UI accepted the workspace choice.                                       |
| 2    | Select real persisted `ServiceOffering` | `Haitian dancehall single production — remote` selected; the seller UI rendered the offering's existing sample list. |
| 3    | Upload an MP3                           | The seller uploaded one MP3 through the deployed upload route; the upload returned the persisted sample.             |
| 4    | List the uploaded sample                | The seller UI listed the uploaded sample — labelled `Hot beat` — alongside the existing samples.                     |
| 5    | Play the uploaded MP3                   | Browser playback reported approximately `0:15 / 1:26`, proving actual media playback of the Supabase-backed object.  |
| 6    | Remove an uploaded sample               | The remove action succeeded; the seller UI updated the list accordingly.                                             |

**Result:** PASS — the deployed seller UI successfully
uploaded, listed, played, and removed a real MP3 sample
through the managed Supabase Storage adapter behind the
provider-neutral boundary.

**Public/list DTO inspection (browser Network tools):** the
sample list response carried only buyer-safe fields per the
`bg2AudioSamplePublicV1Schema` allow-list in
`packages/types/src/index.ts` lines 1247–1271:

- `sampleId`
- `offeringId`
- `label`
- `contentType` (literal `audio/mpeg`)
- `byteSize` (nonnegative integer, max 25 MiB)
- `displayOrder` (integer 1–3)
- `playbackUrl` (resolved through the SoundHub-owned in-app
  `/api/services/:offeringId/audio-samples/:sampleId/play`
  route)
- `createdAt` (ISO-8601 datetime)

No Supabase bucket name, object key, raw storage reference,
provider credential, or signed provider URL crossed the
public boundary. The schema is `.strict()` — unknown inner
fields are rejected before the DTO is emitted, and the
service-layer tests (`apps/api/src/services/audio-sample.service.test.ts`
lines 204–211, 610–617) assert the absence of `storageRef`,
`supa:`, and `token=` substrings from `playbackUrl` to keep
that contract pinned.

### AC5 — Deployed beta uses truthful mock/provider and asset/environment labels

**Live deployed-beta evidence is scoped to what the Deployed
Beta smoke actually exercised.** That smoke drove the managed
Auth journey plus the managed Storage upload/list/play/remove
journey; it did **not** drive a Deal, so the funding surface
was never rendered against the live Railway deployment during
the deployed smoke.

**Live deployed-beta evidence (from the Storage smoke):**
the `bg2AudioSamplePublicV1Schema` sample-list response that
appeared in the browser Network panel during the Storage
smoke carried only the buyer-safe fields enumerated in `AC4`.
The Playwright `golden-slice.spec.ts` Step 10 was not run
against the live deployment, so the truthful-funding-label
assertions below are **local deterministic evidence**, not
deployed-rendering evidence.

**Local deterministic evidence (Playwright journey spec):**
the rendered labels asserted at Step 10 of
`apps/web/e2e/golden-slice.spec.ts` are:

- `data-testid="deal-funding-badge"` text contains
  `Sandbox · simulated`. The badge copy is built by
  `apps/web/src/app/deals/deal-summary-copy.ts:32`
  (`buildFundingBadgeLabel() === "Sandbox · simulated"`),
  unit-tested by
  `apps/web/src/app/deals/funding-summary-copy.test.ts:28`.
- `data-testid="deal-funding-status"` text contains
  `simulated-network` (asserted at spec line 256) — the
  public DTO field `networkLabel` is hard-coded to
  `"simulated-network"` in the deterministic
  MockEscrowProvider (see `apps/api/src/escrow/escrow-provider.ts`
  and the `apps/api/src/deal-list/prisma-deal-list.repository.test.ts`
  fixtures at lines 439–440, 470).
- The `sandbox-USDC` literal lives in the public DTO as the
  `assetLabel` field of the funding confirmation (asserted in
  `apps/web/src/app/lib/funding-client.test.ts` lines 78–100,
  186–187). The Playwright journey spec at line 257 asserts
  the badge text contains `/sandbox/`; it does **not** assert
  the literal `sandbox-USDC` token in rendered DOM text (the
  asset label is exposed via the JSON DTO, not directly
  surfaced as a separate substring inside the funding-status
  test id).

**True boundary:** `MockEscrowProvider` is the required
buildathon funding provider behind the provider-neutral
escrow interface (`apps/api/src/escrow/escrow-provider.ts`).
No real token transfer, wallet verification, browser-wallet
signing, or on-chain settlement is performed or claimed.
The provider returns a deterministic confirmation with
`assetLabel = "sandbox-USDC"` and
`networkLabel = "simulated-network"`, and PostgreSQL persists
the funding attempt and confirmation. The Deal transitions
to `Active` only via the deterministic activation service
(`apps/api/src/funding/funding.service.ts`), never by the
provider itself.

### AC6 — Public/counterparty DTOs do not expose provider subjects, private email, session tokens, storage internals, Prisma-only data, or internal AI data

**Strict-schema contract (live evidence for the Deployed Beta
Storage smoke):** the `bg2AudioSamplePublicV1Schema` in
`packages/types/src/index.ts:1247–1271` is `.strict()` and
allow-lists exactly the buyer-safe fields enumerated in `AC4`.
The schema is also enforced by `apps/api/src/services/audio-sample.service.test.ts`
lines 204–211, 610–617 (the latter explicitly asserts that
`playbackUrl` does not contain `supa:` or `token=` substrings).
The browser Network panel during the deployed Storage smoke
(`AC4`) showed only those allow-listed fields. No provider
subject, raw token, storage credential, or Prisma-only field
appeared in any observed response body.

**Static contract (covers all other public DTOs):** provider
subjects, private email, session tokens, storage internals,
Prisma-only data, and internal AI data are not intended to
cross any public or counterparty DTO. The boundary is
enforced by the strict Zod contracts in
`packages/types/src/index.ts` (audio samples, funding, deals,
search, project requests, etc.) and by the Express route
handlers in `apps/api/src/routes/*` which serialize through
the allow-listed schemas rather than the raw Prisma models.

**Local deterministic evidence (Playwright journey spec, NOT
deployed rendering):** `golden-slice.spec.ts` Step 10 lines
263–274 scans the rendered DOM after the local deterministic
journey reaches `Active` and asserts the following six
forbidden strings are absent from the page body text:

- `paymentIntentId`
- `correlationId`
- `providerReference`
- `Supabase signed`
- `bucket=`
- `fail_unsafe`

**Scope note:** the Deployed Beta smoke (`AC4`, `AC7`) did
not drive a Deal, so this scan was not exercised against the
live Railway deployment. The deployed-rendering privacy
evidence is limited to the Storage DTO inspection above;
the broader Deal-page privacy scan is local deterministic
evidence only.

### AC7 — Type checking, linting, focused tests, production builds, formatting checks, runtime smoke, and deployed-beta smoke pass

Each gate below is anchored to a concrete repository artifact
or a concrete deployed-runtime observation. Operator
transcripts (Railway build logs, browser screenshots, copied
clipboard values) are **not retained in the repository**;
where this document records an observation, the observation
itself IS the bound.

| Gate                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local BG7 gates (type-check, lint, focused tests, production builds, format, runtime smoke) | `pnpm acceptance-gate` exited 0 against implementation/remediation commit `7543e7115a0e7edef29fbefd8d0d6107dc9bb883` at `2026-09-07T15:53:57Z`. All 9 orchestrated steps passed in 398.8 seconds, including the production builds, runtime smoke, and 43/43 Playwright tests. The orchestrator is `scripts/acceptance-gate.mjs`; it stops at the first failure and emits `READY FOR CODEX REVIEW` only after every step succeeds.                                                                                                                                                                                                                                                                                                |
| Deployed web online                                                                         | `https://soundhub-web-production.up.railway.app` is reachable; the deployed web app served the managed Auth + Storage smoke in `AC4`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| API HTTP 200 health smoke                                                                   | See `Railway deployed API health smoke — PASS` below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Prisma migrations deployed / no pending migrations                                          | 13 migrations applied in the deployed PostgreSQL service. The migration list lives in `packages/db/prisma/migrations/`: `20260808114423_m1_foundation`, `20260808120000_drop_seed_markers`, `20260824171036_bg1_identity`, `20260825120000_bg2_audio_samples`, `20260826090000_bg3_project_brief`, `20260826110000_bg2_audio_cleanup`, `20260826160000_bg3_persist_criteria_query`, `20260826170000_bg3_persist_additional_offerings`, `20260826180000_bg2_audio_orphaned_storage`, `20260827090000_bg4_project_requests`, `20260827100000_bg4_restrict_cascades`, `20260901090000_bg5_terms_approvals`, `20260904120000_bg6_payment_intent`. The Railway deploy reported `No pending migrations` after `prisma migrate deploy`. |
| Production deterministic seed succeeded                                                     | See `Production deterministic seed — PASS` below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Managed Auth smoke                                                                          | PASS — see `AC4`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Managed Storage smoke                                                                       | PASS — see `AC4`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

#### Railway deployed API health smoke — PASS

Command:

```bash
curl -i https://soundhub-api-production.up.railway.app/api/health
```

Observed:

- `HTTP/2 200`
- `status`: `ok`
- `service`: `SoundHub API`
- `version`: `0.1.0`
- `environment`: `production`
- Observed at approximately `2026-09-07T03:17:47Z`

Result: PASS — deployed SoundHub API is reachable and healthy
in the production Railway environment.

#### Production deterministic seed — PASS

The seed was run inside the Railway API container rather than
from the local machine:

```bash
cd /app
export PUBLIC_FIXTURE_ORIGIN=https://soundhub-web-production.up.railway.app
pnpm --filter @soundhub/db db:seed
```

Observed output (the exact literal strings emitted by
`packages/db/prisma/seed.ts:2051,2055-2057,2064`):

- `Applying deterministic M1.1 seed (canonical relationships and fields)…`
- `First pass converged: 8 sellers, 8 active offerings, 10 categories, 5 specialties, 6 pricing units.`
- `Second pass produced an identical canonical snapshot.`

The deployed PostgreSQL database subsequently showed populated
Workspaces including `Creole Beats Brooklyn` (with Seller
capability) — the canonical seller Workspace referenced by the
production seed in `packages/db/prisma/seed.ts:225` and by
the Golden Slice buyer-side metadata in
`apps/web/playwright.config.ts` (`metadata.expectedSellerName`
= `"Marc-André Pierre"`).

Result: PASS — the canonical M1.1 seed reached a deterministic
fixed point in the deployed PostgreSQL service.

### AC8 — Optional behavior remains non-blocking and outside BG7

- **Status:** No optional work absorbed. Matchmaker clarification,
  visible terms editing, activity timeline, real Polkadot, and
  all post-buildathon behavior are intentionally outside the
  scope of ticket #65. The Golden Slice spec's
  "Optional If Ahead" section is independently removable per
  the spec's own contract; none of it was made a dependency.

---

## Branch / Deployment Evidence

The deployment uses **direct-local-CLI via the Railway CLI**.
The deployed application was uploaded from the local checkout;
no PR was opened and no merge was performed against `main`.
Later local review remediations have not been deployed. Their
local validation and synchronization state are recorded below.

- **Branch:** `feat/bg7-golden-slice`
- **Acceptance-tested implementation/remediation commit:**
  `7543e7115a0e7edef29fbefd8d0d6107dc9bb883` —
  `fix(bg7): resolve final review findings`
- **Application commit deployed** (the most recent non-doc
  commit at the time of the Railway `up`):
  `a385ea1` — `fix(auth): allow phone_change_sent_at +
reauthentication_sent_at on managed verify`. The
  docs-only commit `59f04e2` was pushed AFTER the Railway
  deployment and is NOT the application commit that produced
  the deployed beta.
- **Deployment source:** direct-local-CLI via Railway CLI.
- **Deployment commands used:**

  ```bash
  railway up --service soundhub-api --environment production
  railway up --service soundhub-web --environment production
  ```

- **Deployed services:**
  - Web: `https://soundhub-web-production.up.railway.app`
  - API: `https://soundhub-api-production.up.railway.app`

- **Read-only git snapshot after the acceptance gate and before
  this evidence-only update:**

  ```text
  $ git branch --show-current
  feat/bg7-golden-slice

  $ git rev-parse HEAD
  7543e7115a0e7edef29fbefd8d0d6107dc9bb883

  $ git status --short
  (clean)

  $ git log -1 --oneline
  7543e71 fix(bg7): resolve final review findings

  $ git rev-list --left-right --count origin/feat/bg7-golden-slice...HEAD
  0	5
  ```

  (At this snapshot, the local branch was 5 commits ahead of and
  0 commits behind `origin/feat/bg7-golden-slice`.)

---

## Operator Sign-off

- **Operator:** Caleb Matteis
- **Date:** `2026-09-07T03:35:30Z` (UTC, generated at the time
  this evidence document was finalized)
- **Deployed beta URL:** `https://soundhub-web-production.up.railway.app`
- **API URL:** `https://soundhub-api-production.up.railway.app`
- **Outcome:** `READY FOR CODEX REVIEW`
