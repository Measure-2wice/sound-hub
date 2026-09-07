# SoundHub

SoundHub is an AI-assisted Caribbean creative-services marketplace. It lets a buyer describe a
creative need, receive real Matchmaker-recommended ServiceOfferings persisted in PostgreSQL, and
walk a seller through explicit consent, immutable terms, and sandbox-funded deal activation.

The repository currently holds a verified Buildathon Golden Slice built on top of the completed
Milestone 1 search foundation. The full Milestone 2 (authenticated Workspaces + seller onboarding)
and later milestones are partially implemented; Buyer/Seller onboarding, delivery, disputes, and
real Polkadot escrow are not yet complete.

> See [`CONTEXT.md`](./CONTEXT.md) for canonical terminology, the accepted ADRs in [`docs/adr/`](./docs/adr/)
> for architecture decisions, [`docs/specs/`](./docs/specs/) for the governing specifications,
> and [`docs/deployment/`](./docs/deployment/) for the deployed-beta evidence record.

## What SoundHub is

A buyer describes a creative need in natural language. SoundHub's Matchmaker translates it into
validated search criteria, calls the existing PostgreSQL-backed `TalentSearchService`, and returns
real Active `ServiceOffering` recommendations. Each step of the engagement is governed by explicit,
audited authority:

- A buyer describes a need
- The Matchmaker recommends real persisted `ServiceOffering`s (no fabricated supply)
- A seller must **explicitly** accept the `ProjectRequest` before negotiation can start
- AI may **draft** a `TermsVersion`; it can never approve one
- Buyer and seller independently approve the **same** `TermsVersion`
- The buyer explicitly initiates sandbox escrow funding through a labeled `MockEscrowProvider`
- A deterministic application service moves the `Deal` to `Active` only after seller consent, both
  approvals, and a matching funding confirmation are all present for the current version

## Current Golden Slice

The verified Golden Slice (`docs/specs/buildathon-golden-slice.md`,
`docs/deployment/bg7-golden-slice-evidence.md`) implements:

- Managed magic-link authentication (Supabase Auth) with a deterministic fallback adapter
- Acting-`Workspace` authorization on every consequential command
- PostgreSQL-backed talent and `ServiceOffering` search (`TalentSearchService`)
- Seller audio upload, list, play, and remove (`ServiceOfferingAudioSample`) over Supabase Storage
- AI Matchmaker with deterministic fallback, structured-output validation, and required-constraint
  preservation
- `ProjectRequest` creation with revalidation and seller consent (Accept / Decline)
- Immutable `TermsVersion` with monotonic version numbers and approval invalidation on edit
- Explicit `DealApprover` authorization per Workspace
- Buyer and seller approvals persisted independently
- A labeled sandbox `PaymentIntent` flow and `MockEscrowProvider` escrow adapter
- Deterministic `Deal` activation only when all required state is satisfied

The single integrated browser journey
(`apps/web/e2e/golden-slice.spec.ts`) crosses the same application interfaces as the deployed
providers while running against real disposable PostgreSQL. The deployed beta on Railway was
verified end-to-end (managed Auth + managed Storage + runtime health + deterministic seed).

## Architecture

SoundHub is a pnpm monorepo with two apps, two packages, and shared root configuration:

- **Web** — Next.js 15 App Router frontend (`apps/web`)
- **API** — Express TypeScript API with runtime-validated Zod contracts (`apps/api`)
- **Shared types** — Strict Zod contracts inferred as TypeScript types (`packages/types`)
- **Database** — Prisma schema, migrations, and deterministic seed (`packages/db`)

Infrastructure seams:

- **Identity** — Supabase Auth (managed magic link) behind a provider-neutral adapter; a
  deterministic local adapter covers tests and operator-mode deployment
- **Storage** — Supabase Storage (managed MP3 buckets) behind a provider-neutral adapter;
  deterministic storage fixture covers tests
- **AI / Matchmaker** — Managed AI adapter (Impala / `qwen3.6-27b`) plus a deterministic fallback
  that crosses the same validation boundary
- **Escrow** — `MockEscrowProvider` behind a provider-neutral interface; intended for later
  replacement with real Polkadot escrow
- **Auth email delivery** — Delegated to the managed Supabase Auth project's email channel; the
  repository does not own SMTP credentials. Email delivery is verified by the bounded deployed
  smoke in `docs/deployment/managed-provider-smoke.md`.

Deployed services:

- Web: `https://soundhub-web-production.up.railway.app`
- API: `https://soundhub-api-production.up.railway.app`
- PostgreSQL: managed Supabase (13 applied migrations; no pending migrations)
- Object storage: managed Supabase Storage
- Deploys use the Railway CLI (`railway up --service …`)

## Important domain and security invariants

SoundHub's domain rules are enforced at the application boundary and at the database, not by the
UI alone:

- **`WorkspaceMembership` authorizes acting as a `Workspace`**; `Workspace.ownerUserId` alone must
  not authorize (the legacy owner pointer may remain structurally present but is never read as an
  authorization source for Golden Slice commands)
- **`MarketplaceCapability` and human approval authority are separate concepts** — being an Owner
  or having Buyer/Seller capability does not itself record a `DealApprover` approval
- **`DealApprover` is explicit** — only an explicitly authorized member may approve a
  `TermsVersion` for a `Workspace`
- **AI may draft but never approve** — every AI-drafted `TermsVersion` is visibly labeled as a
  draft until both humans independently approve it
- **Seller consent is explicit** — AI or buyer intent cannot manufacture consent; acceptance of
  a `ProjectRequest` is a separate, terminal decision
- **Both parties approve the same `TermsVersion`** — material edits create a new version and
  invalidate earlier approvals
- **Confirmed funding gates the `Active` state** — the deterministic activation service checks
  seller consent, both approvals, and matching sandbox funding all at once
- **Public DTOs never leak provider or private internals** — Prisma models, provider subjects,
  emails, session tokens, storage keys, embeddings, and internal AI data stay out of the shared
  Zod schemas
- **PostgreSQL is canonical application state** — caches, vector projections, and provider
  metadata are derived; failures fail closed

See [`CONTEXT.md`](./CONTEXT.md) for the canonical glossary and [`docs/adr/`](./docs/adr/) for the
accepted decisions behind these invariants.

## Repository structure

```text
sound-hub/
├── apps/
│   ├── web/                 Next.js 15 App Router frontend
│   │   ├── src/app/         Routes, components, hooks, page logic
│   │   ├── e2e/             Playwright browser journeys (incl. golden-slice.spec.ts)
│   │   └── playwright.config.ts
│   └── api/                 Express + TypeScript API
│       └── src/
│           ├── routes/            HTTP route handlers (search, auth, matchmaker, audio-samples,
│           │                      project-requests, deal-terms, deal-list, funding, health)
│           ├── services/          Domain services (TalentSearchService, AuthenticationService,
│           │                      WorkspaceAuthorizationService, AudioSampleService,
│           │                      MatchmakerService)
│           ├── identity/          Auth adapters (managed / deterministic)
│           ├── matchmaker/        AI adapters and persisted project-brief repository
│           ├── storage/           Object-storage adapters (Supabase / deterministic)
│           ├── escrow/            MockEscrowProvider
│           ├── funding/           Funding service + Prisma repository
│           ├── project-request/   ProjectRequest service + Prisma repository
│           ├── deal-terms/        TermsVersion service + Prisma repository
│           ├── deal-list/         Deal-discovery list service + Prisma repository
│           ├── audio-repository/  Audio sample Prisma repository
│           ├── auth-repository/   Auth Prisma repository
│           ├── repositories/      Talent and metadata repositories
│           ├── lib/               Errors, test-database guard, etc.
│           └── server.ts          HTTP server entry point
├── packages/
│   ├── types/               Shared Zod contracts (allow-listed public DTOs)
│   └── db/                  Prisma schema, client, deterministic seed
├── docs/
│   ├── adr/                 Accepted architecture decisions (0001–0007)
│   ├── architecture/        Legacy architecture notes (ADR-001, superseded)
│   ├── contracts/           API contracts (search-api v1)
│   ├── deployment/          Deployed-beta evidence, smoke procedures, email-template notes
│   ├── plans/               Milestone plans
│   ├── specs/               Milestone and Buildathon Golden Slice specs
│   └── agents/              Engineering agent notes
├── scripts/                 Acceptance gate, db lifecycle, smoke, forbidden-deps checks
├── supabase/                Magic-link email template + Postgres initdb hooks
├── docker/                  Initdb hooks for the disposable test/QA PostgreSQL
├── docker-compose.yml       Developer PostgreSQL (port 5432) + optional Redis (port 6379)
├── docker-compose.test.yml  Disposable PostgreSQL for tests + manual QA (port 5433)
├── CLAUDE.md / AGENTS.md    Engineering agent guidance
├── CONTEXT.md               Canonical domain glossary
└── spec.md                  MVP product baseline
```

## Local development

The repository uses pnpm workspaces, Node.js 20+, and ESM.

```bash
# Install
pnpm install

# Develop (both apps)
pnpm dev              # concurrently runs web (3000) and api (4000)
pnpm dev:web          # Next.js only
pnpm dev:api          # Express only

# Quality gates
pnpm type-check
pnpm lint
pnpm test
pnpm build
pnpm format:check
pnpm check            # type-check + lint + test + build
pnpm format           # write (mutate) formatting
```

### Database and Prisma

```bash
# Developer database (port 5432; named volume)
pnpm db:up
pnpm db:down          # DESTRUCTIVE: removes Compose volumes; confirm target first

# Prisma
pnpm prisma:generate
pnpm --filter @soundhub/db db:migrate
pnpm --filter @soundhub/db db:seed
pnpm --filter @soundhub/db db:studio
```

Do not use `prisma db push` as a substitute for a reviewed migration.

### Disposable test / QA PostgreSQL (port 5433)

```bash
pnpm db:test:up
pnpm db:test:down     # DESTRUCTIVE: removes volumes
pnpm db:test:wait
pnpm db:test:reset    # wait + reset
pnpm db:test:migrate  # wait + migrate
pnpm db:test:seed     # deterministic seed
pnpm db:test:cycle    # clean → migrate → seed twice → snapshot equality
```

Manual-QA target (separate from the destructive test database):

```bash
pnpm db:qa:wait
pnpm db:qa:migrate
pnpm db:qa:seed
pnpm dev:qa           # dev API pointed at the QA database
```

The test harness fails closed if `TEST_DATABASE_URL` does not point to a local/Compose host and a
database whose name ends in `_test` (`apps/api/src/lib/test-database.ts`).

### Expected local ports

- Web: `http://localhost:3000`
- API: `http://localhost:4000`
- Developer PostgreSQL: `localhost:5432`
- Disposable test / QA PostgreSQL: `localhost:5433`
- Redis (Compose service, not a Milestone 1 runtime dependency): `localhost:6379`

## Environment variables

The names and purposes below are drawn from the actual code (`.env.example`, the composition root
at `apps/api/src/index.ts`, and the adapter factories). **No secret values are included here.**

| Variable                          | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`                    | Primary PostgreSQL connection string                                    |
| `TEST_DATABASE_URL`               | Disposable test PostgreSQL (must end in `_test` and be local/Compose)   |
| `QA_DATABASE_URL`                 | Manual-QA PostgreSQL (separate from the destructive test target)        |
| `NODE_ENV`                        | `development` / `test` / `production`                                   |
| `FRONTEND_URL`                    | Web origin used for CORS                                                |
| `API_URL`                         | API origin used by the web app                                          |
| `PUBLIC_API_BASE_URL`             | Public base URL for browser-facing API references                       |
| `PORT_WEB`                        | Web listen port (defaults to 3000)                                      |
| `PUBLIC_FIXTURE_ORIGIN`           | Origin used to build deterministic audio-fixture URLs                   |
| `SUPABASE_URL`                    | Supabase project URL (managed identity adapter)                         |
| `SUPABASE_ANON_KEY`               | Supabase anon key (managed identity adapter)                            |
| `SUPABASE_SERVICE_ROLE_KEY`       | Supabase service-role key (managed identity + storage adapter)          |
| `AUTH_CALLBACK_URL`               | Magic-link callback URL (`<callback>?token=<token_hash>`)               |
| `BG1_DETERMINISTIC_OPERATOR_MODE` | `1` selects the deterministic identity adapter (operator/degraded path) |
| `BG2_STORAGE_BACKEND`             | `supabase` (managed) or `deterministic` (test/QA) storage backend       |
| `IMPALA_BASE_URL`                 | Impala Matchmaker provider base URL                                     |
| `IMPALA_API_KEY`                  | Impala Matchmaker provider API key                                      |
| `IMPALA_MODEL`                    | Impala Matchmaker model identifier (defaults to `qwen3.6-27b`)          |

Provider-neutral seams (identity, storage, AI, escrow) accept explicit overrides for tests and for
degraded deployment. See `apps/api/src/identity/identity-adapter-factory.ts`,
`apps/api/src/storage/storage-factory.ts`, `apps/api/src/matchmaker/ai-adapter-factory.ts`, and
`apps/api/src/escrow/escrow-provider.ts` for the exact selection rules.

The repository does not store SMTP credentials; managed email delivery is delegated to the Supabase
Auth project's email channel and verified by the bounded deployed smoke.

## Testing

- **Unit / integration** — `pnpm test` runs Node's built-in test runner across `apps/api`,
  `apps/web`, plus `pnpm test:repository`, `pnpm test:forbidden-deps`, and `pnpm test:db-qa-env`
- **Disposable PostgreSQL** — `pnpm test:repository` against a real local test database; the
  `db:test:*` scripts drive the cycle (clean → migrate → seed → snapshot equality)
- **Forbidden-dependency guard** — `pnpm test:forbidden-deps` rejects AI, vector, Redis, storage,
  wallet, and blockchain references in `package.json`, the lockfile, and TypeScript source
- **Playwright (web e2e)** — `pnpm test:e2e` runs the single integrated Golden Slice journey plus
  stale-request, concurrency, and outage projects against disposable PostgreSQL
- **Acceptance gate** — `pnpm acceptance-gate` orchestrates the forbidden-deps check, the
  disposable PostgreSQL cycle, format/lint/type-check, the full test suite, the production builds,
  the Playwright suite, and the runtime smoke. It stops at the first failure
- **CI** — `.github/workflows` runs `format:check`, `lint`, `type-check`, `build`, and the Node test
  suite on every push to `main` and on pull requests, against an ephemeral PostgreSQL service on
  `localhost:5433/soundhub_m1_test`. Playwright and the runtime smoke are intentionally out of CI
  scope and run locally through the acceptance gate

## Deployment

The deployed beta runs on Railway with managed Supabase services:

- **Web** — Railway service `soundhub-web` (Next.js production build)
- **API** — Railway service `soundhub-api` (Express production build)
- **PostgreSQL** — Managed Supabase project (13 migrations applied; no pending migrations)
- **Object storage** — Managed Supabase Storage (MP3 discovery samples)
- **Identity + email delivery** — Managed Supabase Auth with a custom BG1 magic-link email
  template (`supabase/magic-link-email-template.html`)

Deploy commands (operator-driven, used during the Buildathon):

```bash
railway up --service soundhub-api --environment production
railway up --service soundhub-web --environment production
```

Deployed-beta evidence and the bounded managed-Auth / managed-Storage smoke procedure are recorded
in `docs/deployment/bg7-golden-slice-evidence.md` and `docs/deployment/managed-provider-smoke.md`.

> The current escrow path is **sandbox / simulated** through `MockEscrowProvider`. Every relevant
> UI surface and persisted confirmation is labeled accordingly (`sandbox-USDC`, `simulated-network`,
> `Sandbox · simulated`). No real token movement, wallet verification, or Polkadot integration is
> performed or claimed by the deployed beta.

## Roadmap and current status

- **Milestone 1** — Database-backed talent and `ServiceOffering` search: **complete**
- **Milestone 2 (original scope)** — Authenticated Workspaces, seller onboarding: **partially
  complete**. The Golden Slice implements narrow portions of later milestones (managed magic-link
  Auth, acting-`Workspace` authorization, `ProjectRequest` flow, `TermsVersion`, approvals,
  sandbox funding, deterministic activation), but full Buyer/Seller onboarding is **not yet
  complete**
- **Buyer / Seller onboarding** — **next focus**; the spec lives in
  `docs/specs/milestone-2-authenticated-workspaces-seller-onboarding.md`
- **Delivery, revisions, acceptance** — not yet complete
- **Disputes, operations, hardening** — not yet complete
- **Real Polkadot escrow** — not the current production path; `MockEscrowProvider` is the
  approved buildathon funding provider behind the provider-neutral escrow interface
- **Production Milestone 3** — governed by GitHub issue #31; the Buildathon Golden Slice is
  intentionally **not** production M3 acceptance

## Current limitations

- **New authenticated users do not yet receive a usable `Workspace` automatically.** The Golden
  Slice relies on a seeded demo buyer/seller `Workspace` pair; M2's "one personal Workspace per
  authenticated user" flow is not yet wired into the deployed beta
- **Buyer / Seller onboarding is incomplete.** Full SellerProfile publication revision breadth,
  invitation lifecycle, and Workspace administration are still pending
- **The deployed Matchmaker currently uses the deterministic fallback** unless managed AI
  (`IMPALA_BASE_URL` / `IMPALA_API_KEY`) is configured. Both paths cross the same validation and
  `TalentSearchService` boundaries
- **Escrow is sandbox / simulated** through `MockEscrowProvider`. No real tokens move, no wallet is
  verified, and no blockchain connectivity is performed
- **The Sequential Command** is an engineering authorization-test surface rather than a real
  user-facing product feature. It exists to exercise explicit acting-`Workspace` and capability
  checks in tests, not as a buyer/seller workflow
