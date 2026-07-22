# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## SoundHub: AI Producer Marketplace

Goal: Build a full-stack TypeScript project to master Type Safety, Prisma, and Retrieval-Augmented Generation (RAG) for senior-level interviews.
Primary Engineer: Caleb Matteis
Assistant Role: Codex will serve as an architecture auditor, scaffolding assistant, and TypeScript reviewer.

🧠 Project Overview

SoundHub is a full-stack AI-powered platform that allows Artists to find Producers by describing a “vibe.”
Codex will help scaffold, refactor, and extend this codebase with TypeScript-first, frontend-driven, and system-design-level principles.

Technical Stack
Layer	Tech
Frontend	Next.js (TypeScript, App Router)
Backend	Express (TypeScript)
Database	PostgreSQL + Prisma ORM
Vector DB (RAG)	Pinecone
AI API	OpenAI (Embeddings + Chat)
Cloud Storage	AWS S3
Package Manager	pnpm v9
Lint/Format	ESLint v9 + TypeScript-ESLint v8 + Prettier v3
Runtime	Node 20+ (ESM)
🏗️ Monorepo Structure
soundhub/
├── apps/
│   ├── web/        → Next.js frontend
│   └── api/        → Express backend
├── packages/
│   ├── types/      → Shared TypeScript interfaces
│   └── db/         → Prisma schema + client
├── .eslint.config.js
├── tsconfig.base.json
├── pnpm-workspace.yaml
├── docker-compose.yml
└── AGENTS.md (this file)

## Current Project Status

**Note**: This is currently a partially scaffolded monorepo. Only the root configuration and `packages/types` exist. The `apps/web` and `apps/api` directories, database setup, and Docker configuration are not yet implemented.

## Common Development Commands

```bash
# Install dependencies
pnpm install

# Development (will fail until apps are created)
pnpm dev                 # Run both web and api apps
pnpm dev:web            # Run Next.js frontend
pnpm dev:api            # Run Express backend

# Code quality
pnpm lint               # Run ESLint
pnpm format             # Format code with Prettier

# Database (not yet implemented)
pnpm db:up              # Start PostgreSQL container
pnpm db:down            # Stop and remove containers
pnpm prisma:generate    # Generate Prisma client

# Build shared types
pnpm --filter @soundhub/types build
```

## Core Dependencies

- typescript: ^5.6.3
- eslint: ^9.10.0 (with flat config)
- typescript-eslint: ^7.18.0
- prettier: ^3.3.3
- concurrently: ^9.0.0
- pnpm: ^9.0.0

## Configuration Details

### TypeScript Configuration (`tsconfig.base.json`)
- Strict mode enabled with additional safety checks
- ES2022 target with ESNext modules
- Bundler module resolution for modern tooling
- `noUncheckedIndexedAccess` for array/object safety

### ESLint Configuration (`.eslint.config.js`)
- Uses ESLint v9 flat configuration format
- TypeScript-ESLint integration with type checking
- Enforces consistent type imports
- Configured for modern ESM projects

### Prettier Configuration (`.prettierrc`)
- Double quotes, semicolons, 100 character print width
- Consistent with TypeScript best practices

## Architecture Notes

This is designed as a pnpm monorepo with:
- **Shared types package**: `@soundhub/types` for type-safe communication between frontend/backend
- **Frontend app**: Next.js with App Router (planned: `@soundhub/web`)
- **Backend API**: Express TypeScript server (planned: `@soundhub/api`)
- **Database layer**: Prisma + PostgreSQL (planned: `@soundhub/db`)

The type system uses branded types for UUID and ISO date strings to prevent mixing incompatible string values. The core domain models (User, ProducerProfile, MusicTrack) are designed around the AI vibe matching concept.

## Development Phases

### Phase A - Complete Basic Scaffolding
- Create missing `apps/web` (Next.js)
- Create missing `apps/api` (Express)
- Create `packages/db` with Prisma schema
- Set up Docker Compose for PostgreSQL

### Phase B - Implement Core Features
- User authentication and profiles
- Producer profile management with vibe embeddings
- Music track upload and storage (S3)
- AI-powered search using OpenAI + Pinecone

### Phase C - Integration & Polish
- Connect frontend to backend APIs
- Implement RAG-based producer matching
- Add comprehensive error handling and validation

## Core Type Definitions (packages/types)

The shared types package defines the core domain models:

- **Branded types**: `UUID`, `ISODateString` for type safety
- **Domain models**: `IUser`, `IProducerProfile`, `IMusicTrack`
- **Business logic**: `Money` type, `Role` enum, `IQueryResponse` for AI matching

Key architectural decisions:
- Immutable interfaces (readonly properties)
- Branded string types to prevent ID/date confusion
- Vector embeddings stored as `number[]` for AI similarity matching

## Single Test Command

To run tests for a specific package:
```bash
pnpm --filter @soundhub/[package-name] test
```

## Expected Ports

When fully implemented:
- **Frontend**: http://localhost:3000 (Next.js)
- **Backend API**: http://localhost:4000 (Express)
- **Database**: localhost:5432 (PostgreSQL via Docker)
