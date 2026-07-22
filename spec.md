# SoundHub x Polkaward — Buildathon Spec
## Future Caribbean: AI for the Arts (Track 08)
### Option 2 — AI Artist Discovery + Stablecoin Payment

---

## 1. The Problem

Caribbean artists — reggae, dancehall, soca, afrobeats, calypso — produce world-class music
but face three painful realities:

1. **Discovery is broken.** Brands, promoters, and film producers can't easily find the right
   Caribbean artist for their project.
2. **Getting paid internationally is hard.** Bank wire fees, currency conversion, and lack of
   financial infrastructure mean artists lose money or wait weeks to get paid.
3. **No trust layer exists.** Buyers fear paying before delivery; artists fear delivering
   before payment.

---

## 2. The Solution

> **MVP:** SoundHub is an AI-powered marketplace that helps businesses discover Caribbean
> musicians, agree on project terms, and pay them securely in stablecoins through Polkadot.

**The product flow:**

```
Business describes a music need
        ↓
AI discovers suitable Caribbean musicians
        ↓
AI helps both parties agree on project terms
        ↓
Payment is secured in escrow through Polkadot
        ↓
Artist delivers the work
        ↓
Buyer confirms delivery
        ↓
Artist receives stablecoin payment
```

A buyer describes what they need in plain language. A multi-agent AI system finds the best
match, helps both parties agree on scope and price, and monitors the deal through to completion.
A Polkadot smart contract holds the stablecoin payment in escrow — funds are released to the
artist's wallet when work is confirmed. No middlemen. No wire transfers. No unpaid invoices.

---

## 3. MVP Boundaries

This section defines what the team is building for the Buildathon and what is intentionally
out of scope for Phase 1.

### Building for the Buildathon

- AI artist discovery — Matchmaker Agent finds and ranks Caribbean artists by vibe
- AI-assisted negotiation — Negotiator Agent helps buyer and artist agree on scope, timeline, and price
- Delivery monitoring — Delivery Monitor Agent supervises the deal and auto-releases funds on confirmation
- Stablecoin payment via Polkadot escrow — payment is secured on-chain and released programmatically
- Basic contributor attribution — every deal records who did what, with a timestamped audit log
- Transaction proof — each deal has an on-chain transaction hash verifiable in real time

### Intentionally Not Building Yet

The following are future directions. They should not appear in the Buildathon demo or MVP scope:

- Automated royalty distribution
- Full rights and licensing management
- Tokenized ownership or NFT-based rights
- Complex cross-chain settlement
- Reputation systems
- DAO governance
- Rewards or incentive programs
- Advanced proof-of-contribution infrastructure beyond the deal audit log

---

## 4. What Already Exists (Do Not Rebuild)

### Soundhub (`/Users/cmatteis/soundhub`)
| What exists | File location | Status |
|---|---|---|
| Next.js 15 frontend | `apps/web/` | Running |
| Express API backend | `apps/api/` | Running |
| PostgreSQL + Prisma schema | `packages/db/` | Running |
| Shared TypeScript types | `packages/types/` | Running |
| AI vibe search UI | `apps/web/src/app/components/SearchPage.tsx` | Functional (mock data) |
| RAG service scaffold | `apps/api/src/services/rag-service.ts` | Mocked — ready to wire |
| OpenAI + Pinecone config | `apps/api/.env.example` | Env vars defined, not wired |
| Docker Compose (Postgres + Redis) | `docker-compose.yml` | Running |

### Polkaward (`/Users/cmatteis/m2-development/polkaward`)
| What exists | File location | Status |
|---|---|---|
| ink! smart contract on Polkadot | `src/lib.rs` | Deployed to Rococo testnet |
| Blockchain interaction layer | `frontend/server/contract.cjs` | Working |
| GitHub webhook handler | `frontend/server/github.cjs` | Working (HMAC verified) |
| Express webhook server | `frontend/server/server.cjs` | Working |
| React frontend (basic counter) | `frontend/src/App.tsx` | Working |

---

## 5. Architecture — Combined System

```
  SOUNDHUB FRONTEND (Next.js)
  ┌──────────────────────────────────────────────────┐
  │  Search Page (vibe query)                         │
  │  Artist Profile Page                              │
  │  Deal / Booking Flow                              │
  │  Wallet Connect (Talisman / SubWallet)            │
  │  Deal Dashboard (real-time agent status updates)  │
  └───────────────────┬──────────────────────────────┘
                      │ HTTP / WebSocket
  SOUNDHUB API (Express)
  ┌───────────────────▼──────────────────────────────┐
  │  POST /api/search       POST /api/deals           │
  │  POST /api/agent/brief  GET  /api/deals/:id       │
  │  GET  /api/artists/:id  POST /api/deals/:id/*     │
  └───────────────────┬──────────────────────────────┘
                      │
  ┌─────────────────────────────────────────────────────────────────┐
  │  GOOGLE ADK ORCHESTRATION LAYER  (packages/agents)              │
  │                                                                 │
  │  ┌────────────────────────────────────────────────────────┐     │
  │  │  WORKFLOWS                                             │     │
  │  │  artist-discovery.ts    deal-lifecycle.ts              │     │
  │  └──────────────┬─────────────────────┬───────────────────┘     │
  │                 │                     │                         │
  │  ┌──────────────▼──┐  ┌──────────────▼──┐  ┌────────────────┐  │
  │  │  MATCHMAKER     │  │  NEGOTIATOR     │  │  DELIVERY      │  │
  │  │  AGENT          │─►│  AGENT          │─►│  MONITOR AGENT │  │
  │  │                 │  │                 │  │                │  │
  │  │  Semantic search│  │  Drafts terms   │  │  Watches       │  │
  │  │  Ranks matches  │  │  Handles Q&A    │  │  deadlines     │  │
  │  │  Explains fit   │  │  Flags risks    │  │  Escalates     │  │
  │  │  Asks follow-up │  │  Confirms deal  │  │  disputes      │  │
  │  └──────────┬──────┘  └──────────┬──────┘  └────────┬───────┘  │
  │             │                    │                   │          │
  │  ┌──────────▼────────────────────▼───────────────────▼───────┐  │
  │  │  TOOLS LAYER                                               │  │
  │  │  search-artists  rank-artists  create-deal  negotiate      │  │
  │  │  lock-escrow  release-escrow  escalate-dispute  notify     │  │
  │  └──────────────────────────────┬─────────────────────────────┘  │
  │                                 │                                │
  │  ┌──────────────────────────────▼─────────────────────────────┐  │
  │  │  MODEL PROVIDER LAYER                                      │  │
  │  │  Claude (primary)  │  Gemini (optional)  │  Future         │  │
  │  └────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────┬──────────────────────────────────┘
                                 │
  POLKADOT PAYMENT LAYER
  ┌──────────────────────────────▼──────────────────────────────────┐
  │  packages/blockchain/  (ported from Polkaward)                  │
  │  escrow.lock(dealId, artist, asset, amount)                     │
  │  escrow.release(dealId)                                         │
  │  escrow.refund(dealId)                                          │
  └──────────────────────────────┬──────────────────────────────────┘
                                 │ WebSocket
  POLKADOT BLOCKCHAIN (Paseo testnet)
  ┌──────────────────────────────▼──────────────────────────────────┐
  │  ink! Escrow Smart Contract  (upgraded from Polkaward)          │
  └─────────────────────────────────────────────────────────────────┘
```

---

## 6. Package Structure

```
soundhub/
├── apps/
│   ├── web/                → Next.js 15 frontend
│   └── api/                → Express API (routes, middleware, services)
├── packages/
│   ├── agents/             → Google ADK orchestration layer  ← NEW
│   ├── blockchain/         → Polkadot interaction layer      ← NEW (ported from Polkaward)
│   ├── db/                 → Prisma schema + client
│   └── types/              → Shared TypeScript interfaces
├── docker-compose.yml
└── pnpm-workspace.yaml
```

### `packages/agents/` — Internal Layout

```
packages/agents/
├── src/
│   ├── agents/
│   │   ├── matchmaker.ts          — Matchmaker Agent definition (Google ADK Agent)
│   │   ├── negotiator.ts          — Negotiator Agent definition
│   │   └── delivery-monitor.ts    — Delivery Monitor Agent definition
│   │
│   ├── workflows/
│   │   ├── artist-discovery.ts    — Buyer brief → ranked shortlist workflow
│   │   └── deal-lifecycle.ts      — Accepted deal → escrow → delivery → release workflow
│   │
│   ├── tools/
│   │   ├── search-artists.ts      — Pinecone + PostgreSQL artist lookup
│   │   ├── rank-artists.ts        — LLM re-ranking of vector search results
│   │   ├── create-deal.ts         — Writes Deal record to database
│   │   ├── negotiate.ts           — Appends message to DealMessage history
│   │   ├── lock-escrow.ts         — Calls packages/blockchain escrow.lock()
│   │   ├── release-escrow.ts      — Calls packages/blockchain escrow.release()
│   │   ├── escalate-dispute.ts    — Flags deal for human review
│   │   ├── notify.ts              — Sends email / in-app notification
│   │   └── schedule-reminder.ts   — Creates a time-based follow-up trigger
│   │
│   ├── prompts/
│   │   ├── matchmaker.md          — System prompt for Matchmaker Agent
│   │   ├── negotiator.md          — System prompt for Negotiator Agent
│   │   └── monitor.md             — System prompt for Delivery Monitor Agent
│   │
│   ├── memory/
│   │   └── conversation-store.ts  — Shared conversation + workflow state store
│   │
│   └── index.ts                   — Public exports
├── package.json                   — @soundhub/agents
└── tsconfig.json
```

---

## 7. Orchestration Framework — Google ADK

### Why Google ADK

SoundHub is fundamentally a multi-agent workflow, not a chatbot. Three autonomous agents must
coordinate across a shared deal lifecycle, hand work to one another, and interact with both a
database and a blockchain. Google ADK (TypeScript) is the orchestration framework because it
provides first-class abstractions for exactly this shape of system:

| Need | ADK primitive |
|---|---|
| Autonomous agents with defined tools | `Agent` class with `tools` registry |
| Structured agent-to-agent handoffs | `AgentHandoff` / subagent invocation |
| Shared workflow state across agents | `WorkflowSession` / session state |
| Long-running workflows (delivery monitor) | Persistent workflow sessions |
| Model-agnostic routing | Provider adapters (Claude, Gemini, LiteLLM) |
| Agent evaluation | ADK built-in eval harness |

### Model Layer

The orchestration layer is **model-agnostic**. Agents are defined without hard-coding a
provider. The model is injected at runtime through the ADK model configuration:

```
Google ADK Runtime
        │
        ▼
  Model Provider Adapter
        │
   ┌────┴───────────────┐
   │                    │
Claude (primary)    Gemini (optional)
claude-opus-4-8     gemini-2.0-flash
                         │
                    Future providers
                    (LiteLLM passthrough,
                     OpenAI, Mistral, etc.)
```

This means the agent logic, tools, and workflows never import a model SDK directly. Switching
the reasoning model for any agent is a one-line config change, not an application rewrite.

---

## 8. The Three Agents — Detailed Design

This section wins the Agentic AI Excellence category (50% of total score).

---

### Agent 1 — The Matchmaker Agent

**File:** `packages/agents/src/agents/matchmaker.ts`
**Prompt:** `packages/agents/src/prompts/matchmaker.md`

#### Purpose
Match a buyer's natural language brief to the most suitable Caribbean artists in the platform,
using semantic search + LLM re-ranking. The agent reasons over the results — it does not merely
retrieve them.

#### Responsibilities
- Interpret the buyer's natural language brief
- Detect when the brief is too vague to make a confident match
- Ask one targeted clarifying question before proceeding when needed
- Generate a ranked shortlist of 3 artists with a written, context-specific explanation per artist
- Hand off the shortlist to the `artist-discovery` workflow for presentation

#### Tools Available
| Tool | Purpose |
|---|---|
| `SearchArtistsTool` | Embeds the query (OpenAI) and retrieves top-10 nearest artists from Pinecone |
| `FetchArtistProfileTool` | Fetches full profile from PostgreSQL for each candidate |
| `RankArtistsTool` | LLM re-ranks candidates against the brief, produces scores + explanations |

#### Workflow Inputs
```
brief: string              — buyer's natural language description
clarificationAnswer?: string — buyer's answer if agent previously asked a question
sessionId: string          — links to conversation memory
```

#### Workflow Outputs
```
On vague brief:
  { needsClarification: true, question: string }

On clear brief:
  {
    needsClarification: false,
    matches: [
      { artistId, rank, score, explanation }  × 3
    ]
  }
```

#### Handoff Condition
Returns structured output to the `artist-discovery` workflow. The workflow surfaces results
to the API, which returns them to the frontend. No direct agent-to-agent call at this stage —
the buyer must select an artist before the Negotiator is invoked.

#### Memory Requirements
- **Conversation memory:** Stores the buyer's brief and any clarification exchange in the
  session so the clarification loop works across multiple HTTP requests without repeating context.
- No persistent deal memory required at this stage.

---

### Agent 2 — The Deal Negotiation Agent

**File:** `packages/agents/src/agents/negotiator.ts`
**Prompt:** `packages/agents/src/prompts/negotiator.md`

#### Purpose
Facilitate fair project terms between a buyer and a Caribbean artist. The agent reasons over
both parties' needs, drafts terms, handles back-and-forth Q&A, flags unusual requests, and
produces a confirmed deal ready for escrow.

#### Responsibilities
- Review buyer brief, artist profile, and artist's standard rate
- Draft initial project terms (scope, deliverables, timeline, payment amount)
- Respond to questions from either the buyer or the artist
- Flag risk conditions — unusual rights requests, abnormally short deadlines, pricing outliers
- Suggest fair alternatives when flagging a risk
- Produce a structured deal summary when both parties agree
- Invoke `CreateDealTool` and `LockEscrowTool` upon deal confirmation

#### Tools Available
| Tool | Purpose |
|---|---|
| `NegotiateTool` | Appends a message to the deal thread (buyer, artist, or agent) |
| `CreateDealTool` | Writes a confirmed Deal record to the database |
| `LockEscrowTool` | Calls `packages/blockchain` `escrow.lock()` — secures payment on-chain |
| `NotifyTool` | Notifies buyer and artist when terms are drafted or updated |

#### Workflow Inputs
```
dealId?: string            — set after deal record exists; absent on first message
artistId: string
buyerBrief: string
newMessage: string
sender: "buyer" | "artist"
sessionId: string          — links to conversation memory
```

#### Workflow Outputs
```
{
  agentMessage: string      — agent's response to the thread
  riskFlag?: {
    risk: string
    suggestion: string
  }
  dealConfirmed?: {
    dealId: string
    deliverables: string
    deadlineDays: number
    paymentAmountMinor: bigint
    paymentAsset: string
    specialTerms?: string
    txHash: string          — populated after LockEscrowTool succeeds
  }
}
```

#### Handoff Condition
When `dealConfirmed` is present in the output, the `deal-lifecycle` workflow transitions the
deal status to `Funded` and activates the Delivery Monitor Agent.

#### Memory Requirements
- **Conversation memory:** Full negotiation thread (all messages: buyer, artist, agent)
  persisted in `DealMessage` table and loaded from `ConversationStore` per session.
- **Deal memory:** Current deal state (status, terms, parties) available to the agent
  throughout the negotiation without re-fetching.
- Memory is stored externally to the LLM (in PostgreSQL and the conversation store) so the
  full history survives across HTTP requests and restarts.

---

### Agent 3 — The Delivery Monitor Agent

**File:** `packages/agents/src/agents/delivery-monitor.ts`
**Prompt:** `packages/agents/src/prompts/monitor.md`

#### Purpose
Autonomously supervise an active deal from escrow lock through to fund release. The agent
runs on a schedule and on trigger events — it is never directly invoked by the buyer or artist.

#### Responsibilities
- Track deal deadline relative to current time
- Send reminder to artist at 50% of deadline elapsed
- Send final reminder 24 hours before deadline
- If deadline passes without delivery: notify both parties and present options
  (extend, dispute, refund)
- When artist marks delivery: prompt buyer to confirm
- If buyer does not respond within 48 hours: auto-confirm and release funds
- Escalate to human if a dispute is raised or an anomalous state is detected
- Generate a post-deal summary for both parties on completion (deliverables, timeline, payment,
  blockchain proof link) — this constitutes the deal's contributor attribution record

#### Tools Available
| Tool | Purpose |
|---|---|
| `NotifyTool` | Sends notification to artist, buyer, or both |
| `ScheduleReminderTool` | Creates or cancels time-based follow-up triggers |
| `ReleaseEscrowTool` | Calls `packages/blockchain` `escrow.release()` |
| `RefundEscrowTool` | Calls `packages/blockchain` `escrow.refund()` |
| `EscalateDisputeTool` | Sets deal status to `Disputed`, flags for human review |

#### Workflow Inputs
The Delivery Monitor does not receive a message from a user. It receives a **workflow event**:
```
event: "reminder_50pct"
     | "reminder_24h"
     | "deadline_passed"
     | "delivery_submitted"
     | "buyer_confirmed"
     | "confirmation_timeout"
     | "dispute_raised"
dealId: string
```

#### Workflow Outputs
```
{
  actionTaken: "reminded" | "released" | "refunded" | "escalated" | "no_action"
  txHash?: string     — populated if escrow interaction occurred
  summary?: string    — post-deal summary text, populated on Completed or Disputed
}
```

#### Handoff Condition
This agent terminates the `deal-lifecycle` workflow. When `actionTaken` is `released`,
`refunded`, or `escalated`, the workflow sets final deal status and no further agent
invocations occur.

#### Memory Requirements
- **Workflow state:** The full deal record (status, deadline, parties, payment amount,
  payment asset) is loaded from PostgreSQL at the start of each event — the agent does not
  reconstruct context from LLM memory.
- **Audit log:** Every action taken (remind, release, escalate) is appended to `Deal.agentLog`
  (JSON column) for legal traceability and contributor attribution.
- The agent does NOT rely on conversation history — it reasons from structured deal state.
  This makes it restartable and auditable.

---

## 9. Workflow Layer

Workflows are the connective tissue between agents. They define the sequence of agent
invocations, what state is passed between them, and the conditions for advancing to the
next step. Workflows live in `packages/agents/src/workflows/`.

### Workflow 1 — Artist Discovery (`artist-discovery.ts`)

**Trigger:** Buyer submits a brief via `POST /api/agent/brief`

```
Buyer brief received
        │
        ▼
  Matchmaker Agent
  ├── brief vague?
  │       └── return { needsClarification: true, question }
  │               → API returns question to frontend
  │               → buyer answers
  │               → POST /api/agent/brief with clarificationAnswer
  │               → workflow resumes from this step
  └── brief clear?
          └── SearchArtistsTool
                  │
                  ▼
              FetchArtistProfileTool (top 10)
                  │
                  ▼
              RankArtistsTool (LLM re-ranks → top 3)
                  │
                  ▼
          return { matches: [...] }
                  │
                  ▼
        Workflow ends — results returned to API
```

**State passed through workflow:**
- `brief` + `clarificationAnswer` (if provided)
- `sessionId` (for conversation memory continuity)
- `candidates` (artist profiles fetched mid-workflow, not passed from API)

---

### Workflow 2 — Deal Lifecycle (`deal-lifecycle.ts`)

**Trigger:** Buyer clicks "Book This Artist"

```
Artist selected
        │
        ▼
  Negotiator Agent activated
  ├── drafts initial project terms
  ├── buyer/artist Q&A loop  (multiple HTTP requests, stateful via conversation memory)
  ├── risk flag? → agent explains → loop continues
  └── both parties confirm
              │
              ▼
        CreateDealTool  →  Deal record written (status: Accepted)
              │
              ▼
        LockEscrowTool  →  stablecoin locked in escrow (status: Funded)
              │
              ▼
  Delivery Monitor Agent activated
  ├── ScheduleReminderTool  (50% deadline, 24h deadline)
  │
  ├── [event: reminder_50pct]
  │       └── NotifyTool → artist reminder
  │
  ├── [event: reminder_24h]
  │       └── NotifyTool → artist final reminder
  │
  ├── [event: deadline_passed]
  │       └── NotifyTool → both parties → present options
  │
  ├── [event: delivery_submitted]  (status: Delivered)
  │       └── NotifyTool → buyer — confirm or dispute
  │
  ├── [event: buyer_confirmed OR confirmation_timeout]
  │       └── ReleaseEscrowTool → funds released to artist (status: Completed)
  │               └── post-deal summary + attribution record generated
  │
  └── [event: dispute_raised]
          └── EscalateDisputeTool → (status: Disputed) → human review queue
```

**State passed through workflow:**
- `dealId` threads every step — all agents read deal state from DB
- `sessionId` persists negotiation conversation memory
- `agentLog` (JSON) captures every agent action for audit trail and attribution

---

## 10. Tools Layer

Tools are the only components that touch the database, the blockchain, or external services.
**Agents never access these systems directly.** This separation keeps agent logic testable,
swappable, and auditable independently of side effects.

| Tool | Package | What it touches |
|---|---|---|
| `SearchArtistsTool` | `packages/agents` | Pinecone (vector search) |
| `FetchArtistProfileTool` | `packages/agents` | PostgreSQL via `@soundhub/db` |
| `RankArtistsTool` | `packages/agents` | Model provider (LLM call) |
| `CreateDealTool` | `packages/agents` | PostgreSQL via `@soundhub/db` |
| `NegotiateTool` | `packages/agents` | PostgreSQL (DealMessage table) |
| `LockEscrowTool` | `packages/agents` | `@soundhub/blockchain` `escrow.lock()` |
| `ReleaseEscrowTool` | `packages/agents` | `@soundhub/blockchain` `escrow.release()` |
| `RefundEscrowTool` | `packages/agents` | `@soundhub/blockchain` `escrow.refund()` |
| `EscalateDisputeTool` | `packages/agents` | PostgreSQL (Deal status update) |
| `NotifyTool` | `packages/agents` | Email / in-app notification service |
| `ScheduleReminderTool` | `packages/agents` | Job queue (node-cron or Redis queue) |

Tools are registered on the ADK Agent at definition time. The agent invokes them by name;
the framework handles execution and returns structured results back into the agent's context.

---

## 11. Memory Architecture

Memory is stored externally to the LLM. The agents receive memory as structured input
at the start of each invocation — they do not "remember" across calls implicitly.

### Conversation Memory

**Where:** `packages/agents/src/memory/conversation-store.ts` + `DealMessage` table

**What it stores:** The full message thread for each deal negotiation, including messages
from the buyer, artist, and agent, in chronological order.

**How agents use it:** On each Negotiator invocation, the full thread is loaded from the
store and passed as the ADK session's message history. The agent reasons over the complete
context without re-deriving it from prompts.

### Deal Memory

**Where:** `Deal` table in PostgreSQL

**What it stores:** Current deal status, project terms, parties, deadlines, payment amount,
payment asset, transaction hashes.

**How agents use it:** The Delivery Monitor loads the Deal record at the start of every event
invocation. It reasons from structured data, not from reconstructed LLM context. This makes
the Monitor restartable — if the server restarts mid-deadline, the next cron tick loads the
same deal state and continues correctly.

### Workflow State

**Where:** ADK `WorkflowSession` + `Deal.agentLog` (JSON column)

**What it stores:** Current workflow position, last event processed, flags (risk flagged,
clarification requested, etc.).

**How agents use it:** Workflows checkpoint state so partial completions (e.g. escrow locked
but cron not yet started) are recoverable. The `deal-lifecycle` workflow can be inspected
at any point to see exactly where in the flow a deal is.

### Audit Log

**Where:** `Deal.agentLog` (JSON column)

**What it stores:** Every agent action — tool called, result, timestamp, model used, token
count, parties involved.

**Purpose:** Legal traceability for escrow decisions and contributor attribution. If a dispute
is raised and a human reviewer asks "why did the agent release funds automatically?", the audit
log provides a complete, timestamped record of the decision. The post-deal summary links to
the on-chain transaction hash as external proof of payment.

---

## 12. Prompt Architecture

Prompts are first-class components, not strings embedded in TypeScript files.

### File Location

Each agent has a dedicated markdown prompt file:
- `packages/agents/src/prompts/matchmaker.md`
- `packages/agents/src/prompts/negotiator.md`
- `packages/agents/src/prompts/monitor.md`

### Structure

Each prompt file contains:
1. **Role definition** — who the agent is (e.g. "You are a Caribbean music industry expert...")
2. **Context block** — dynamic placeholders (e.g. `{{artist_profiles}}`, `{{buyer_brief}}`)
3. **Decision rules** — explicit reasoning guidelines the agent must follow
4. **Output format** — which tool to call and when
5. **Constraints** — what the agent must never do (e.g. "never quote a price you have not
   verified against the artist's profile")

### Versioning

Prompt files are version-controlled in git alongside the code. A prompt change is a code
change — it goes through the same review process as a TypeScript file. This prevents
silent prompt drift.

### Reuse

Common instructions (e.g. Caribbean cultural context, marketplace rules, tone guidelines)
are defined in a shared `packages/agents/src/prompts/base.md` and included by reference
in each agent prompt.

### Testing

Each prompt has a corresponding eval fixture in `packages/agents/src/prompts/__evals__/`
containing representative inputs and expected output structure. The ADK eval harness runs
these on CI to catch prompt regressions before they reach production.

---

## 13. Data Model Changes

Add these models to `packages/db/prisma/schema.prisma`:

```prisma
model ArtistProfile {
  id                  String      @id @default(cuid())
  userId              String      @unique
  bio                 String
  genreTags           String[]
  vibeEmbeddingVector Float[]
  walletAddress       String?
  rateAmountMinor     Int
  rateCurrency        String      @default("USD")
  country             String      @default("Caribbean")
  user                User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  tracks              MusicTrack[]
  deals               Deal[]      @relation("ArtistDeals")

  @@map("artist_profiles")
}

enum DealStatus {
  Pending       // buyer proposed, waiting for artist
  Accepted      // artist accepted, awaiting payment lock
  Funded        // stablecoin locked in escrow on-chain
  Delivered     // artist marked work delivered
  Completed     // buyer confirmed, funds released to artist
  Disputed      // escalated to human review
  Refunded
  Cancelled
}

model Deal {
  id                  String      @id @default(cuid())
  buyerId             String
  artistId            String
  description         String
  deliverables        String?
  deadlineAt          DateTime?
  amountMinor         Int         // agreed price in display currency (for UI)
  currency            String      @default("USD")
  paymentAmountMinor  BigInt      // on-chain escrow amount in smallest token unit
  paymentAsset        String      // e.g. "USDC"
  paymentChain        String?     // e.g. "Polkadot Asset Hub" — TODO: confirm with Andriy
  status              DealStatus  @default(Pending)
  txHash              String?     // escrow lock transaction hash
  releaseTxHash       String?     // escrow release transaction hash
  agentLog            Json?       // agent action audit trail and contributor attribution
  createdAt           DateTime    @default(now())
  updatedAt           DateTime    @updatedAt
  buyer               User        @relation("BuyerDeals", fields: [buyerId], references: [id])
  artist              ArtistProfile @relation("ArtistDeals", fields: [artistId], references: [id])
  messages            DealMessage[]

  @@map("deals")
}

model DealMessage {
  id        String   @id @default(cuid())
  dealId    String
  sender    String   // "buyer" | "artist" | "agent"
  content   String
  createdAt DateTime @default(now())
  deal      Deal     @relation(fields: [dealId], references: [id])

  @@map("deal_messages")
}
```

Also update `User` model — add `Buyer` to the `Role` enum.

---

## 14. New Package — `packages/blockchain`

Port and upgrade Polkaward's contract interaction layer into a clean TypeScript package.

```
packages/blockchain/
├── src/
│   ├── index.ts     — exports all public functions
│   ├── client.ts    — ApiPromise + ContractPromise init (from Polkaward contract.cjs)
│   ├── escrow.ts    — lock(), release(), refund()
│   └── types.ts     — BlockchainConfig, EscrowResult interfaces
├── package.json     — @soundhub/blockchain
└── tsconfig.json
```

**What to port from Polkaward (direct conversion to TypeScript ESM):**
- `signAndSend()` — `client.ts`
- `getQueryGasLimit()` — `client.ts`
- `formatDispatchError()` — `client.ts`
- `isDispatchError()` — `client.ts`
- `init()` / WebSocket setup — `client.ts`

**TypeScript escrow interface (asset-neutral):**
```typescript
// TODO: confirm asset parameter type and fee behavior with Andriy
// The selected Polkadot chain or runtime determines network fee asset
escrow.lock(dealId: string, artist: string, asset: string, amount: bigint): Promise<EscrowResult>
escrow.release(dealId: string): Promise<EscrowResult>
escrow.refund(dealId: string): Promise<EscrowResult>
```

**Upgraded ink! smart contract messages:**
```rust
// replaces the incrementer in polkaward/src/lib.rs
// TODO: validate stablecoin asset support with Andriy — PSP22 token or XCM asset?
lock(deal_id: String, artist: AccountId, asset: AccountId, amount: Balance)
release(deal_id: String)
refund(deal_id: String)
get_deal(deal_id: String) -> DealState
```

> **Unresolved:** Which Polkadot chain or parachain hosts the escrow contract, which stablecoin
> asset (e.g. USDC via Asset Hub XCM) is supported, and what asset pays network fees are
> decisions to validate with Andriy before implementing the contract upgrade.

This package is called only by tools in `packages/agents` — never by the API directly.
The blockchain layer is a side effect of a tool decision, not a direct API action.

---

## 15. New API Routes (`apps/api`)

The API is a thin HTTP layer over the ADK workflow runner. Routes invoke workflows,
not agents directly.

### Search
```
POST /api/search
Body: { query: string }
→ Runs artist-discovery workflow (non-agentic path — Pinecone + re-rank without clarification)
→ Returns: top 3 matches
```

### Agent (Agentic path — invokes ADK workflows)
```
POST /api/agent/brief
Body: { query: string, clarificationAnswer?: string, sessionId: string }
→ Runs artist-discovery workflow (agentic path — Matchmaker Agent with clarification loop)
→ Returns: { needsClarification, question? } or { matches: [...] }

POST /api/agent/negotiate
Body: { dealId: string, message: string, sender: "buyer" | "artist", sessionId: string }
→ Continues deal-lifecycle workflow at Negotiator Agent step
→ Returns: { agentMessage, riskFlag?, dealConfirmed? }

POST /api/agent/monitor/:dealId
Body: { event: MonitorEvent }
→ Triggers a specific Delivery Monitor event in the deal-lifecycle workflow
→ Returns: { actionTaken, txHash?, summary? }
```

### Deals
```
POST   /api/deals                    — create deal from confirmed negotiation
GET    /api/deals/:id                — deal status + message history
POST   /api/deals/:id/fund           — buyer locks stablecoin (triggers escrow.lock via LockEscrowTool)
POST   /api/deals/:id/deliver        — artist marks delivered
POST   /api/deals/:id/confirm        — buyer confirms (triggers escrow.release via ReleaseEscrowTool)
POST   /api/deals/:id/dispute        — escalate to human review
```

### Artists
```
GET    /api/artists/:id              — public artist profile
POST   /api/artists/profile          — create/update artist profile
POST   /api/artists/wallet           — save Polkadot wallet address
```

---

## 16. Frontend Changes (`apps/web`)

| Page | Route | Description |
|---|---|---|
| Landing | `/` | Hero — "Find Caribbean artists, pay instantly in stablecoins" |
| Search | `/search` | Existing vibe search UI + Matchmaker Agent clarification flow |
| Artist Profile | `/artists/[id]` | Bio, genre tags, sample tracks, "Book This Artist" CTA |
| Deal Negotiation | `/deals/new?artist=[id]` | Live chat UI with Negotiator Agent |
| Deal Dashboard | `/deals/[id]` | Both parties see status, agent messages, delivery confirmation |
| Wallet Connect | `/settings/wallet` | Artist connects Talisman/SubWallet |
| My Deals | `/dashboard` | All active and past deals |

**Key UI detail — Agent chat interface:**
The Negotiator Agent interaction should feel like a group chat: buyer, artist, and agent all
visible in the same thread. Agent messages are visually distinct (different color/icon). This
makes the agentic nature of the product immediately obvious to judges in the demo.

**Wallet integration:** Reuse Polkaward's `@talismn/connect-wallets` + `useink` hooks.

---

## 17. Build Plan — 21 Days

### Week 1 — Foundation (Days 1–7)

| Day | Task |
|---|---|
| 1–2 | Add `ArtistProfile`, `Deal`, `DealMessage` to Prisma schema. Run migration. Seed Caribbean artists. |
| 3–4 | Create `packages/blockchain` — port Polkaward `contract.cjs` to TypeScript. |
| 5–6 | Upgrade ink! contract to escrow (asset-neutral). Deploy to Paseo testnet. Test lock/release/refund. |
| 7 | Wire real OpenAI embeddings into `RagService`. Connect Pinecone. |

### Week 2 — The Agent Layer (Days 8–14)

| Day | Task |
|---|---|
| 8 | Scaffold `packages/agents` — install Google ADK TypeScript, configure ADK runtime, model adapter for Claude. |
| 9 | Build `artist-discovery` workflow. Define Matchmaker Agent with `SearchArtistsTool`, `RankArtistsTool`. Wire to `POST /api/agent/brief`. Test clarification loop. |
| 10–11 | Build `deal-lifecycle` workflow (negotiation phase). Define Negotiator Agent with all tools. Wire to `POST /api/agent/negotiate`. Test deal confirmation flow + escrow lock. |
| 12–13 | Build Delivery Monitor Agent. Wire to scheduled job (node-cron → ADK event trigger). Test all monitor events. Test auto-release on timeout. |
| 14 | Integration pass: full workflow end-to-end (brief → match → negotiate → lock → deliver → release). Fix handoff edge cases. |

### Week 3 — Frontend + Polish (Days 15–21)

| Day | Task |
|---|---|
| 15 | Build Agent chat UI on Deal Negotiation page. |
| 16 | Build Deal Dashboard with real-time status + agent message log. |
| 17 | Build Artist Profile page. Add wallet connect flow. |
| 18 | Add auth (NextAuth with email magic link — fastest to ship). |
| 19 | End-to-end test: search → agent match → negotiate → lock stablecoin → deliver → auto-release. |
| 20 | UI polish. Mobile responsiveness. Error states. |
| 21 | Record demo video. Prepare pitch. |

---

## 18. Environment Variables

```env
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/soundhub

# Embeddings (RAG)
OPENAI_API_KEY=
PINECONE_API_KEY=
PINECONE_INDEX_NAME=soundhub-artists

# AI Model Providers (injected into ADK model adapter)
ANTHROPIC_API_KEY=        # Claude — primary reasoning model
GOOGLE_API_KEY=           # Gemini — optional / fallback
# LITELLM_API_BASE=       # Uncomment to route via LiteLLM proxy

# Storage
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=

# Blockchain (from Polkaward env.sample)
WS_PROVIDER=wss://paseo.rpc.amforc.com
MNEMONIC=
CONTRACT=
METADATA=target/ink/escrow.contract

# Server
PORT=4000
```

---

## 19. Demo Script (What to Show Judges)

**The product in one sentence:** *"AI agents handle everything between 'I need a Caribbean
artist' and 'here's your payment' — permanently settled on Polkadot, no middleman required."*

---

1. **Brief submitted.** Buyer types: *"I need upbeat soca for a summer campaign in Trinidad."*
   The Matchmaker Agent asks: *"Will this be used in video content or audio only? That affects
   which artists I'd recommend."* Buyer answers. Agent returns three ranked artists with
   specific explanations.

2. **Artist selected.** Buyer clicks "Book This Artist." The Negotiator Agent opens a
   three-way chat and drafts project terms: *"Based on your brief and Kes's standard rate, I'm
   proposing: one original soca track, 30-second ad length, non-exclusive use, delivered in 7
   days, 500 USDC."* Artist sees this and confirms.

3. **Agent flags a risk.** Buyer edits terms to request exclusive rights. Agent responds:
   *"Exclusive rights are unusual at this price point — Kes typically charges 3× for
   exclusivity. I'd suggest either removing exclusivity or increasing the offer."*

4. **Deal funded.** Both parties agree. Buyer locks 500 USDC into the Polkadot escrow
   contract. Transaction hash appears — verifiable on-chain in real time.

5. **Delivery Monitor takes over.** Agent sends artist a reminder at day 4.
   Artist submits the track on day 6. Agent notifies buyer to confirm.

6. **Auto-release.** Buyer confirms delivery. Smart contract releases 500 USDC to the
   artist's wallet instantly. No bank. No invoice. No waiting.

7. **Post-deal summary.** Agent generates a summary for both parties — deliverables,
   timeline met, payment amount, blockchain proof link. This record attributes the work
   to the artist and the deal to the buyer, permanently.

---

## 20. How This Scores Against the Judging Rubric

The rubric is 50% Business Strength + 50% Agentic AI Excellence, scored 1–10.

### Business Strength

| Criterion | Score | Why |
|---|---|---|
| Team quality | TBD | Depends on team background presented |
| Product innovation & defensibility | 8/10 | No one has combined AI multi-agent orchestration + Polkadot escrow for Caribbean music. ADK workflow architecture is defensible and extensible. |
| Product-market fit | 8/10 | Real pain (Caribbean artists unpaid), proven market (Superteam Earn 194k users on Solana), zero direct competitors on Polkadot. |

### Agentic AI Excellence

| Rubric requirement | How we meet it |
|---|---|
| Autonomous agents | All three agents act without human triggers |
| Multi-agent coordination | Matchmaker → Negotiator → Monitor handoff chain via ADK workflows |
| Workflow orchestration | ADK `deal-lifecycle` workflow passes structured state across all three agents and the blockchain layer |
| Reasoning capability | Matchmaker asks clarifying questions; Negotiator flags risks; Monitor decides between remind / escalate / auto-release |
| Human-in-the-loop design | Disputes escalate to human; routine confirmations are automatic |
| Compute efficiency | Agents only run on events (brief submitted, message sent, cron tick) — not polling |
| Real-world impact | Caribbean artists get paid in minutes, not months |

**Projected score: 7–8/10 across both halves.**

---

## 21. Future Architecture — Agent Expansion

The Google ADK workflow architecture makes adding new agents straightforward.
A new agent is a new file in `packages/agents/src/agents/` registered on an existing or
new workflow. The existing three agents are not modified.

The following capabilities are **out of scope for the Buildathon MVP** and planned for
future phases:

### Planned Future Agents

| Agent | Purpose |
|---|---|
| **Rights & Licensing Agent** | Automatically generates and stores usage license agreements per deal. Notifies parties when licenses are about to expire. |
| **Pricing Advisor Agent** | Recommends fair payment amounts based on artist tier, project type, exclusivity, and current exchange rates. |
| **Fraud Detection Agent** | Monitors deal patterns for anomalies — repeat disputes, unusually fast confirmations, wallet address changes mid-deal. |
| **Recommendation Agent** | Proactively suggests artists to returning buyers based on past deal history and listening patterns. |
| **Creator Success Agent** | Reaches out to artists whose profiles are incomplete or who have not responded to briefs in 30+ days. |
| **Analytics Agent** | Generates weekly marketplace reports — deal volume, genre trends, average payout time, top artists. |

### Why ADK Makes This Easy

Each future agent follows the same pattern: define purpose, register tools, write a prompt,
attach to a workflow. There is no orchestration boilerplate to update — the ADK runtime handles
routing. New tools can be registered on existing agents without breaking the agents that do
not use them.

The model-agnostic architecture also means future agents can be routed to cheaper or
faster models for lower-stakes tasks (e.g. Haiku for reminders, Opus for contract risk flagging)
by changing a one-line model config per agent — not by rewriting orchestration logic.
