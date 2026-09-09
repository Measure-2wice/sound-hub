# AGENTS.md

Guidance for Codex and other engineering agents working in SoundHub.

## Product and authority

SoundHub is an AI-assisted Caribbean creative-services marketplace. Read these before changing
domain behavior:

1. `CONTEXT.md` for canonical terminology
2. Relevant accepted records in `docs/adr/`
3. `spec.md` for the MVP product baseline
4. The applicable feature specification, plan, and contract

Do not revive producer-only or exclusive-role terminology that conflicts with the glossary. Surface
an ADR conflict instead of silently overriding it.

## Current implementation target

Milestone 1 is the only implementation-ready milestone:

- Specification: `docs/specs/milestone-1-talent-search.md`
- Plan: `docs/plans/milestone-1-talent-search.md`
- API contract: `docs/contracts/search-api.md`

Milestone 1 replaces the pre-release producer-only mock with deterministic PostgreSQL-backed seller
and ServiceOffering search. It establishes a minimal Workspace ownership foundation but excludes
authentication, agents, Redis, uploads, Deals, wallets, escrow, and blockchain behavior.

## Actual monorepo

```text
apps/
├── web/       Next.js App Router frontend
└── api/       Express TypeScript API

packages/
├── types/     Shared TypeScript contracts
└── db/        Prisma schema, client, and seed
```

Root configuration includes pnpm workspaces, TypeScript, ESLint, Prettier, and Docker Compose.
PostgreSQL and Redis services are described in Docker Compose, but Redis is not a Milestone 1 runtime
dependency.

## Current code status

- Web, API, shared types, Prisma, and Docker scaffolds exist.
- Health routing exists.
- Search currently uses RagService mock data, random scoring, fake vectors, artificial delay, and
  fabricated AI explanations.
- Shared types and Prisma still use the obsolete Role/ProducerProfile/MusicTrack model.
- No accepted production dataset or backward-compatible public search contract exists.
- Milestone 1 intentionally replaces these pre-release models and fixtures.

## Stack

- Node.js 20+ using ESM
- pnpm workspace
- Next.js + React + TypeScript
- Express + TypeScript
- PostgreSQL + Prisma
- ESLint flat configuration + Prettier
- Node test runner for current API tests

OpenAI, Pinecone, object storage, Redis workflows, Google ADK, and Polkadot integration are planned
later and must not be introduced into Milestone 1 without an approved scope change.

## Commands

```bash
# Install
pnpm install

# Development
pnpm dev
pnpm dev:web
pnpm dev:api

# Backend
cd apps/backend
cargo contract build
cargo contract test
npx pnpm --filter @soundhub/api exec tsx src/services/backend.service.test.ts

# Frontend
cd apps/web
pnpm dev

# Quality
pnpm type-check
pnpm lint
pnpm test
pnpm build
pnpm format:check
pnpm check

# Formatting mutation
pnpm format

# Prisma and local infrastructure
pnpm prisma:generate
pnpm --filter @soundhub/db db:migrate
pnpm --filter @soundhub/db db:seed
pnpm --filter @soundhub/db db:studio
pnpm db:up
pnpm db:down
```

`pnpm db:down` removes Compose volumes. Confirm the target and preservation requirements before
running destructive database operations. Do not use `prisma db push` as a substitute for a reviewed
Milestone 1 migration.

Expected local ports:

- Web: `http://localhost:3000`
- API: `http://localhost:4000`
- PostgreSQL: `localhost:5432`
- Redis Compose service: `localhost:6379` when explicitly needed later

## Engineering constraints

- Keep public DTOs allow-listed; never serialize Prisma models directly.
- Treat PostgreSQL as canonical. Vector indexes are derived projections.
- Keep agents outside authorization, state-transition, deadline, approval, and payment authority.
- Use runtime validation at untrusted JSON and tool boundaries; TypeScript alone is insufficient.
- Required search constraints may not be silently dropped or relaxed.
- relevanceScore is deterministic strategy-specific ordering, not buyer-facing confidence.
- Preserve immutable terms, approvals, delivery versions, and audit evidence in later milestones.
- Do not expose account identity, membership, wallet, embedding, or storage internals publicly.

## Milestone 1 coordination

Use an integration branch and isolated worktrees for database, API, and web streams only after the
shared foundation contract is merged. The integration owner exclusively owns shared types, root
configuration, dependency changes, and the lockfile. Any shared contract change requires evidence,
explicit approval, and notification to all streams.

Every stream runs focused tests before handoff. The integration owner runs the full acceptance gate
and disposable-PostgreSQL runtime smoke test before completion.
