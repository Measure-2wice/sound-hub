# BG7 — Buildathon Golden Slice Deployed-Beta Evidence

> **Status:** Operator checklist. Every item must be completed with
> a concrete artifact path or transcript before BG7 can be marked
> `READY FOR CODEX REVIEW`.

## Acceptance Criteria Evidence

### AC1 — One integrated browser journey against real disposable PostgreSQL

- **Artifact:** `apps/web/e2e/golden-slice.spec.ts`
- **Last run:** `<UTC timestamp>` exit code `<0/1>` —
  `<paste final 10 lines of `pnpm test:e2e -- golden-slice.spec.ts` here>`

### AC2 — Journey crosses the same application interfaces as deployed providers while remaining deterministic

- **Artifact:** `apps/web/playwright.config.ts` `webServer.env`
  contains `BG1_DETERMINISTIC_OPERATOR_MODE: "1"` and
  `BG2_STORAGE_BACKEND: "deterministic"`. The deterministic
  identity / AI / storage / escrow adapters are wired into the same
  composition root as the deployed providers
  (`apps/api/src/index.ts`). No fetch / API / DB / repository mocks
  in the journey.
- **Last run:** `<UTC timestamp>` — `<paste a one-line confirmation
that no mocks were introduced here>`

### AC3 — Active Deal view displays seller consent, both approvals, sandbox funding confirmation, and the terminal message

- **Artifact:** `apps/web/src/app/deals/[dealId]/page.tsx` lines
  511–515 already render the exact copy `Deal Active — escrow
funded; commissioned work may begin.` inside
  `data-testid="deal-active-terminal"`.
- **Live evidence:** `<paste the screenshot / curl output from the
deployed Deal page showing all four elements (seller consent,
both approvals, sandbox funding confirmation, terminal message)
side by side here>`

### AC4 — Managed Supabase authentication and storage smoke passes against deployed environment

- **Artifact:** `docs/deployment/managed-provider-smoke.md`
  (managed Auth, 9-step procedure) — complete transcript attached
  below:
  - Step 1 (request magic link): `<transcript>`
  - Step 2 (receive email): `<transcript>`
  - Step 3 (follow callback): `<transcript>`
  - Step 4 (verify token hash): `<transcript>`
  - Step 5 (map identity → UserAccount): `<transcript>`
  - Step 6 (issue session): `<transcript>`
  - Step 7 (authenticated lookup): `<transcript>`
  - Step 8 (sign out): `<transcript>`
  - Step 9 (post-revocation lookup fails): `<transcript>`
- **Managed Supabase Storage smoke:** `<transcript>`. The
  operator uploads one MP3 via the deployed
  `POST /api/services/:offeringId/audio-samples` route, lists,
  plays, and removes it. Bucket names, signed URLs, and provider
  internals MUST NOT appear in any DTO; the buyer-facing `<audio>`
  `src` must resolve through the SoundHub-owned in-app
  `/play` route.

### AC5 — Deployed beta uses truthful mock/provider and asset/environment labels

- **Live evidence:** `<paste the deployed Deal-page screenshot or
curl transcript showing:>`
  - `data-testid="deal-funding-badge"` text contains `Sandbox · simulated`
  - `data-testid="deal-funding-status"` text contains `simulated-network`
  - `data-testid="deal-funding-status"` text contains `sandbox-USDC`
- **Local deterministic evidence:** the journey spec asserts the
  same three labels at the deployed Deal page
  (`golden-slice.spec.ts` step 10).

### AC6 — Public/counterparty DTOs do not expose provider subjects, private email, session tokens, storage internals, Prisma-only data, or internal AI data

- **Live evidence:** `<paste the deployed Deal-page body text or a
search of every public DTO response confirming the forbidden
strings are absent>`
- **Forbidden strings verified absent:** `paymentIntentId`,
  `correlationId`, `providerReference`, `Supabase signed`,
  `bucket=`, `fail_unsafe`.

### AC7 — Type checking, linting, focused tests, production builds, formatting checks, runtime smoke, and deployed-beta smoke pass

- **Local deterministic gates:** `<paste `pnpm acceptance-gate`
output — every step exit code 0>`. The acceptance gate runs
  forbidden-deps → db-test-cycle → format → lint → type-check →
  tests → build → Playwright e2e → runtime-smoke in dependency
  order; the golden-slice spec rides step 8 (`pnpm test:e2e`).
- **Deployed-beta smoke:** this document, completed.

### AC8 — Optional behavior remains non-blocking and outside BG7

- **Status:** No optional work absorbed. Matchmaker clarification,
  visible terms editing, activity timeline, real Polkadot, and
  all post-buildathon behavior are intentionally outside the
  scope of ticket #65.

---

## Deployed Runtime / API Evidence

### Railway deployed API health smoke — PASS

Command:

`curl -i https://soundhub-api-production.up.railway.app/api/health`

Observed:

- HTTP/2 200
- `status`: `ok`
- `service`: `SoundHub API`
- `version`: `0.1.0`
- `environment`: `production`
- Observed at approximately 2026-09-07T03:17:47Z

Result: PASS — deployed SoundHub API is reachable and healthy in the production Railway environment.

At this point we have live evidence for:

## Branch Push Policy (per the plan's completion contract)

- **Branch:** `feat/bg7-golden-slice`
- **Deployed commit:** `<commit SHA at the time of push>`
- **Deployment source:** `<direct-local-CLI (e.g. flyctl deploy) | GitHub webhook on the pushed branch>`
- **Push command (if applicable):** `<paste the exact push
command used>`

If the deployment platform supports direct-from-local CLI: the
`feat/bg7-golden-slice` branch is NOT pushed until Codex approval.
The local commit SHA recorded above is the de facto artifact.

If the deployment platform requires GitHub: the push happened
ONLY after every local deterministic gate passed, and ONLY to
produce the deployed beta. No PR was opened; no merge was
performed. The push command and the exact branch HEAD SHA
deployed are recorded above.

---

## Operator Sign-off

- **Operator:** `<name>`
- **Date:** `<UTC timestamp>`
- **Deployed beta URL:** `<url>`
- **Outcome:** `READY FOR CODEX REVIEW` or
  `<reason not ready, with remediation plan>`
