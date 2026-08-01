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

> **MVP:** SoundHub is an AI-assisted creative-services marketplace that helps people and
> organizations discover Caribbean talent, agree on project terms, exchange private file
> deliverables, and pay securely in stablecoins through Polkadot.

The music MVP serves artists, producers, musicians, managers, executives, licensing houses,
brands, and sync buyers. The domain model must also allow later expansion to videographers,
editors, sound engineers, influencers, and other content creatives without replacing the
account or marketplace-permission model.

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

- AI talent discovery — Matchmaker Agent finds and ranks Caribbean creative talent by vibe and service
- AI-assisted negotiation — Negotiator Agent helps buyer and artist agree on scope, timeline, and price
- Versioned mutual approval — buyer and seller separately approve the same immutable terms version
- Delivery monitoring — Delivery Monitor Agent tracks uploaded deliverables, deadlines, and reminders
- Stablecoin payment via Polkadot escrow — buyer explicitly funds escrow and explicitly releases payment after accepting delivery
- Basic contributor attribution — every deal records who did what, with a timestamped audit log
- Transaction proof — each deal has an on-chain transaction hash verifiable in real time
- AI-assisted dispute intake — AI summarizes evidence and recommends options; unresolved disputes go to manual review

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
- AI-only financial authorization or final dispute adjudication
- Timer-only automatic payment release

### 3.1 Authoritative Product Rules

These rules govern the MVP and override conflicting language elsewhere in this document.

#### Participants and capabilities

- Accounts are either `Individual` or `Organization` accounts.
- Buying and selling are independent capabilities, not mutually exclusive user roles.
- Artists, producers, and musicians may be both buyers and sellers and may purchase services from one another.
- Managers, executives, licensing houses, brands, and agencies are buyer-only in the MVP.
- Seller specialties describe discoverability and services; they do not grant authorization. Initial specialties include
  `Artist`, `Producer`, `Musician`, `Songwriter`, and `SoundEngineer`.
- Future specialties such as `Videographer`, `VideoEditor`, and `Influencer` must fit the same seller-profile model
  without requiring a new account system.

#### Identity and wallets

- SoundHub account authentication uses an off-chain identity such as an email magic link or passkey.
- A wallet is linked separately by signing a nonce that proves wallet ownership.
- A seller may create and publish a profile without a wallet, but must connect a verified payout wallet before
  approving an escrow-backed deal.
- A buyer must connect a verified wallet before funding escrow.
- Financial transactions require an explicit wallet confirmation; an authenticated web session alone is insufficient.
- Payment asset, fee asset, and network are separate fields. The MVP must not assume that DOT is always the fee asset.

#### Agent authority and consent

- Agents may search, rank, explain, draft terms, summarize, remind, identify missing evidence, and flag risk.
- Agents may not approve terms, fund escrow, accept delivery, release or refund funds, cancel a deal, or make a
  binding dispute decision without explicit authorized user action.
- Buyer and seller approve the same immutable terms version independently. Any material edit creates a new
  version and invalidates prior approvals.
- Deal-state transitions and payment authorization are enforced by deterministic application services, not LLM output.

#### Escrow, delivery, and revisions

- The first end-to-end implementation uses a clearly labeled `MockEscrowProvider` behind the same interface planned
  for `PolkadotEscrowProvider`. Real escrow is integrated only after the lifecycle and authorization rules are tested.
- Stablecoin is the escrowed payment asset. Network-fee behavior is resolved from the selected network and wallet
  integration at transaction time.
- Delivery is a private file upload. Clients upload directly to object storage using short-lived presigned URLs;
  the API stores delivery versions, file metadata, checksums, and scan status.
- The default deal includes one revision. Negotiated terms may set zero, one, or two included revisions.
- A revision request must be within the agreed scope. Additional revisions require a change order, added payment,
  or mutual waiver.
- The buyer explicitly accepts delivery to release funds. Timer-only auto-release is outside the MVP.

#### Disputes

- Opening a dispute freezes the deal and escrow state.
- AI assembles the terms, messages, delivery versions, timestamps, and party statements into an evidence summary
  and non-binding recommendation.
- If both parties accept the recommendation, the agreed resolution may be executed explicitly.
- Otherwise an authorized human administrator decides the outcome. Every recommendation, approval, decision,
  and financial action is appended to the audit log.

---

## 4. What Already Exists (Do Not Rebuild)

### SoundHub (`/Users/calebmatteis/sound-hub`)
| What exists | File location | Status |
|---|---|---|
| Next.js 15 frontend | `apps/web/` | Scaffolded; search request is not yet routed to Express |
| Express API backend | `apps/api/` | Scaffolded; health and mock search routes only |
| PostgreSQL + Prisma schema | `packages/db/` | Schema present; no migration or generated client committed |
| Shared TypeScript types | `packages/types/` | Present; still models the older producer-only domain |
| AI vibe search UI | `apps/web/src/app/components/SearchPage.tsx` | Implemented UI over mock API results |
| RAG service scaffold | `apps/api/src/services/rag-service.ts` | Mocked — ready to wire |
| OpenAI + Pinecone config | `apps/api/.env.example` | Env vars defined, not wired |
| Docker Compose (Postgres + Redis) | `docker-compose.yml` | Defined; runtime health not established by repository state |

### Polkaward (external repository; status requires separate verification)
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
  │  │  Asks follow-up │  │  Drafts terms   │  │  summarizes    │  │
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

SoundHub uses agents for reasoning-heavy assistance inside a deterministic marketplace workflow.
Agents coordinate discovery, negotiation support, reminders, and evidence summaries, while
application services enforce permissions, deal transitions, approvals, and financial actions.
Google ADK (TypeScript) is the planned orchestration framework because it provides first-class
abstractions for this shape of system:

| Need | ADK primitive |
|---|---|
| Bounded agents with defined tools | `Agent` class with `tools` registry |
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
      { sellerId, rank, score, explanation }  × 3
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
- Produce a proposed immutable terms version for separate buyer and seller approval
- Invoke `CreateDealTool` to persist the draft; never approve or fund it on behalf of either party

#### Tools Available
| Tool | Purpose |
|---|---|
| `NegotiateTool` | Appends a message to the deal thread (buyer, artist, or agent) |
| `CreateDealTool` | Writes a confirmed Deal record to the database |
| `NotifyTool` | Notifies buyer and artist when terms are drafted or updated |

#### Workflow Inputs
```
dealId?: string            — set after deal record exists; absent on first message
sellerId: string
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
  proposedTerms?: {
    dealId: string
    termsVersion: number
    deliverables: string
    deadlineDays: number
    revisionLimit: number
    paymentAmountMinor: string
    paymentAsset: string
    specialTerms?: string
  }
}
```

#### Handoff Condition
When `proposedTerms` is present, the workflow waits for buyer and seller approval of that exact
terms version. Deterministic application services then transition to `AwaitingFunding`. The buyer
must explicitly authorize the escrow transaction before the deal can become `Funded`.

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
Assist with an active deal from escrow lock through delivery review. The agent runs on scheduled
and domain events, but it cannot authorize state transitions or move funds.

#### Responsibilities
- Track deal deadline relative to current time
- Send reminder to artist at 50% of deadline elapsed
- Send final reminder 24 hours before deadline
- If deadline passes without delivery: notify both parties and present options
  (extend, dispute, refund)
- When artist marks delivery: prompt buyer to confirm
- If buyer does not respond: send reminders and route the deal to manual review; do not auto-release
- If a dispute is raised: freeze the deal, summarize evidence, recommend non-binding options,
  and escalate unresolved cases to an authorized human
- Generate a post-deal summary for both parties on completion (deliverables, timeline, payment,
  blockchain proof link) — this constitutes the deal's contributor attribution record

#### Tools Available
| Tool | Purpose |
|---|---|
| `NotifyTool` | Sends notification to artist, buyer, or both |
| `ScheduleReminderTool` | Creates or cancels time-based follow-up triggers |
| `EscalateDisputeTool` | Sets deal status to `Disputed`, flags for human review |
| `SummarizeDisputeTool` | Builds a structured evidence summary and non-binding recommendation |

#### Workflow Inputs
The Delivery Monitor does not receive a message from a user. It receives a **workflow event**:
```
event: "reminder_50pct"
     | "reminder_24h"
     | "deadline_passed"
     | "delivery_submitted"
     | "buyer_confirmed"
     | "review_reminder"
     | "dispute_raised"
dealId: string
```

#### Workflow Outputs
```
{
  actionTaken: "reminded" | "summarized" | "escalated" | "no_action"
  summary?: string    — post-deal summary text, populated on Completed or Disputed
}
```

#### Handoff Condition
The agent returns advice or notifications to the workflow. Only an authorized user command,
validated by the deterministic deal service, can accept delivery, release or refund escrow,
or apply an agreed/manual dispute resolution.

#### Memory Requirements
- **Workflow state:** The full deal record (status, deadline, parties, payment amount,
  payment asset) is loaded from PostgreSQL at the start of each event — the agent does not
  reconstruct context from LLM memory.
- **Audit log:** Every action taken (remind, summarize, escalate) is appended to the immutable
  deal-event log for traceability and contributor attribution.
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
  └── agent proposes immutable terms version
              │
              ▼
        CreateDealTool  →  Deal + DealTermsVersion written (status: AwaitingApprovals)
              │
              ▼
  Buyer approval + seller approval of same version
              │
              ▼
        status: AwaitingFunding
              │
              ▼
  Buyer explicitly authorizes LockEscrowTool (status: Funded)
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
  ├── [command: buyer_accepts_delivery]
  │       └── deterministic DealService validates actor and state
  │               └── ReleaseEscrowTool → funds released to seller (status: Completed)
  │               └── post-deal summary + attribution record generated
  │
  ├── [command: buyer_requests_revision]
  │       └── validate revision allowance → status: RevisionRequested → InProgress
  │
  └── [event: dispute_raised]
          └── freeze deal → summarize evidence → mutual resolution or human review
```

**State passed through workflow:**
- `dealId` threads every step — all agents read deal state from DB
- `sessionId` persists negotiation conversation memory
- append-only `DealEvent` records capture user, agent, system, and financial actions

---

## 10. Tools Layer

Tools and deterministic application services are the only components that touch the database,
blockchain, or external services. **Agents never access these systems directly.** Financial tools
may run only after an application service validates actor authorization, current state, approved
terms version, and idempotency key.

| Tool | Package | What it touches |
|---|---|---|
| `SearchArtistsTool` | `packages/agents` | Pinecone (vector search) |
| `FetchArtistProfileTool` | `packages/agents` | PostgreSQL via `@soundhub/db` |
| `RankArtistsTool` | `packages/agents` | Model provider (LLM call) |
| `CreateDealTool` | `packages/agents` | PostgreSQL via `@soundhub/db` |
| `NegotiateTool` | `packages/agents` | PostgreSQL (DealMessage table) |
| `LockEscrowTool` | application service | escrow provider after explicit buyer authorization |
| `ReleaseEscrowTool` | application service | escrow provider after explicit delivery acceptance or agreed/manual resolution |
| `RefundEscrowTool` | application service | escrow provider after agreed/manual dispute resolution |
| `EscalateDisputeTool` | `packages/agents` | PostgreSQL (Deal status update) |
| `SummarizeDisputeTool` | `packages/agents` | Read-only deal evidence + model provider |
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

**Where:** ADK `WorkflowSession` + append-only `DealEvent` records

**What it stores:** Current workflow position, last event processed, flags (risk flagged,
clarification requested, etc.).

**How agents use it:** Workflows checkpoint state so partial completions (e.g. escrow locked
but cron not yet started) are recoverable. The `deal-lifecycle` workflow can be inspected
at any point to see exactly where in the flow a deal is.

### Audit Log

**Where:** append-only `DealEvent` records plus `PaymentTransaction` records

**What it stores:** Every user, agent, administrator, system, and financial action — command or
tool, result, timestamp, model/version where applicable, token count, actor, and terms version.

**Purpose:** Traceability for escrow decisions and contributor attribution. If a dispute is
raised, a reviewer can reconstruct the evidence, AI recommendation, explicit party approvals,
manual decision, and payment command. The post-deal summary links to finalized on-chain
transaction hashes as external proof of payment.

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

The current singular `Artist | Producer` role is replaced by account type, marketplace
capabilities, and seller specialties. Suggested MVP models:

```prisma
enum AccountType {
  Individual
  Organization
}

enum MarketplaceCapability {
  Buyer
  Seller
}

enum SellerSpecialty {
  Artist
  Producer
  Musician
  Songwriter
  SoundEngineer
  Videographer
  VideoEditor
  Influencer
}

model User {
  id           String                  @id @default(cuid())
  email        String                  @unique
  displayName  String
  accountType  AccountType             @default(Individual)
  capabilities MarketplaceCapability[]
  createdAt    DateTime                @default(now())
  updatedAt    DateTime                @updatedAt
  sellerProfile SellerProfile?
  wallets      Wallet[]
  buyerDeals   Deal[]                  @relation("BuyerDeals")
}

model SellerProfile {
  id                  String              @id @default(cuid())
  userId              String              @unique
  bio                 String
  specialties         SellerSpecialty[]
  genreTags           String[]
  vibeEmbeddingVector Float[]
  rateAmountMinor     Int
  rateCurrency        String              @default("USD")
  country             String              @default("Caribbean")
  user                User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  tracks              MusicTrack[]
  sellerDeals         Deal[]              @relation("SellerDeals")

  @@map("seller_profiles")
}

model Wallet {
  id          String   @id @default(cuid())
  userId      String
  address     String
  network     String
  verifiedAt DateTime?
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([network, address])
  @@map("wallets")
}

enum DealStatus {
  Draft
  Proposed
  Negotiating
  AwaitingApprovals
  AwaitingFunding
  Funded        // stablecoin locked in escrow on-chain
  InProgress
  Delivered     // artist marked work delivered
  RevisionRequested
  Completed     // buyer confirmed, funds released to artist
  Disputed      // escalated to human review
  Refunded
  Cancelled
}

model Deal {
  id                  String      @id @default(cuid())
  buyerId             String
  sellerId            String
  description         String
  deadlineAt          DateTime?
  amountMinor         Int         // agreed price in display currency (for UI)
  currency            String      @default("USD")
  paymentAmountMinor  String      // on-chain smallest unit; serialized safely over JSON
  paymentAsset        String      // e.g. "USDC"
  feeAsset            String?
  paymentNetwork      String?
  status              DealStatus  @default(Draft)
  approvedTermsId     String?
  createdAt           DateTime    @default(now())
  updatedAt           DateTime    @updatedAt
  buyer               User        @relation("BuyerDeals", fields: [buyerId], references: [id])
  seller              SellerProfile @relation("SellerDeals", fields: [sellerId], references: [id])
  termsVersions       DealTermsVersion[]
  approvals           DealApproval[]
  messages            DealMessage[]
  deliveries          Delivery[]
  events              DealEvent[]
  transactions        PaymentTransaction[]

  @@map("deals")
}

model DealTermsVersion {
  id             String   @id @default(cuid())
  dealId         String
  version        Int
  deliverables   String
  deadlineAt     DateTime?
  revisionLimit  Int      @default(1)
  amountMinor    Int
  currency       String   @default("USD")
  specialTerms   String?
  createdAt      DateTime @default(now())
  deal           Deal     @relation(fields: [dealId], references: [id], onDelete: Cascade)
  approvals      DealApproval[]
  @@unique([dealId, version])
  @@map("deal_terms_versions")
}

model DealApproval {
  id             String   @id @default(cuid())
  dealId         String
  termsVersionId String
  party          String   // "buyer" | "seller"
  approvedById   String
  approvedAt     DateTime @default(now())
  deal           Deal     @relation(fields: [dealId], references: [id], onDelete: Cascade)
  termsVersion   DealTermsVersion @relation(fields: [termsVersionId], references: [id], onDelete: Cascade)
  @@unique([termsVersionId, party])
  @@map("deal_approvals")
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

model Delivery {
  id            String         @id @default(cuid())
  dealId        String
  version       Int
  message       String?
  submittedById String
  submittedAt   DateTime       @default(now())
  deal          Deal           @relation(fields: [dealId], references: [id], onDelete: Cascade)
  files         DeliveryFile[]
  @@unique([dealId, version])
  @@map("deliveries")
}

model DeliveryFile {
  id           String   @id @default(cuid())
  deliveryId   String
  storageKey   String   @unique
  originalName String
  mimeType     String
  sizeBytes    BigInt
  checksum     String
  scanStatus   String
  delivery     Delivery @relation(fields: [deliveryId], references: [id], onDelete: Cascade)
  @@map("delivery_files")
}

model DealEvent {
  id        String   @id @default(cuid())
  dealId    String
  actorType String   // "buyer" | "seller" | "agent" | "admin" | "system"
  actorId   String?
  eventType String
  payload   Json?
  createdAt DateTime @default(now())
  deal      Deal     @relation(fields: [dealId], references: [id], onDelete: Cascade)
  @@map("deal_events")
}

model PaymentTransaction {
  id             String   @id @default(cuid())
  dealId         String
  operation      String   // "lock" | "release" | "refund"
  idempotencyKey String   @unique
  network        String
  paymentAsset   String
  feeAsset       String?
  amountMinor    String
  status         String   // submitted | finalized | failed
  txHash         String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  deal           Deal     @relation(fields: [dealId], references: [id], onDelete: Cascade)
  @@map("payment_transactions")
}
```

Buyer-only restrictions for managers, executives, licensing houses, brands, and agencies are
validated by the application service when capabilities are assigned. Prisma enums describe
storage values; they are not the authorization layer.

---

## 14. New Package — `packages/blockchain`

Define a provider boundary first. Build and test `MockEscrowProvider` for the initial vertical
slice, then port and upgrade Polkaward's interaction layer as `PolkadotEscrowProvider`.

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
escrow.lock(dealId: string, seller: string, asset: string, amount: bigint): Promise<EscrowResult>
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

This package is called only by deterministic application services after explicit user authorization.
Agents may explain or recommend a payment action, but cannot invoke escrow functions directly.

---

## 15. New API Routes (`apps/api`)

The API is a thin HTTP layer over application services and, where appropriate, ADK workflows.
Routes never invoke agents or blockchain clients directly.

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
→ Returns: { agentMessage, riskFlag?, proposedTerms? }

POST /api/agent/monitor/:dealId
Body: { event: MonitorEvent }
→ Triggers a specific Delivery Monitor event in the deal-lifecycle workflow
→ Returns: { actionTaken, summary? }
```

### Deals
```
POST   /api/deals                    — create a draft deal
GET    /api/deals/:id                — deal status + message history
POST   /api/deals/:id/terms          — create a new immutable terms version
POST   /api/deals/:id/approve        — buyer or seller approves the current terms version
POST   /api/deals/:id/fund           — buyer locks stablecoin (triggers escrow.lock via LockEscrowTool)
POST   /api/deals/:id/uploads        — authorize a private direct-to-storage upload
POST   /api/deals/:id/deliveries     — seller submits a versioned file delivery
POST   /api/deals/:id/revisions      — buyer requests an in-scope revision
POST   /api/deals/:id/accept         — buyer accepts delivery and explicitly authorizes release
POST   /api/deals/:id/disputes       — freeze deal and begin AI-assisted/manual review
```

### Talent
```
GET    /api/talent/:id               — public seller profile
POST   /api/talent/profile           — create/update seller profile
POST   /api/wallets/challenge        — create a nonce for wallet ownership proof
POST   /api/wallets/verify           — verify signature and save wallet association
```

---

## 16. Frontend Changes (`apps/web`)

| Page | Route | Description |
|---|---|---|
| Landing | `/` | Hero — "Find Caribbean artists, pay instantly in stablecoins" |
| Search | `/search` | Existing vibe search UI + Matchmaker Agent clarification flow |
| Talent Profile | `/talent/[id]` | Bio, specialties, samples, and "Book This Creative" CTA |
| Deal Negotiation | `/deals/new?seller=[id]` | Live chat UI with Negotiator Agent |
| Terms Approval | `/deals/[id]/terms` | Buyer and seller approve the same immutable terms version |
| Deal Dashboard | `/deals/[id]` | Both parties see status, agent messages, delivery confirmation |
| Delivery | `/deals/[id]/delivery` | Private file upload, version history, acceptance, and revisions |
| Wallet Connect | `/settings/wallet` | User verifies a funding or payout wallet |
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
| 1 | Repair clean install/build/type-check/lint/test orchestration and frontend-to-API routing. |
| 2–3 | Add capability-based accounts and `SellerProfile`; migrate and seed Caribbean talent. |
| 4 | Replace random search mocks with deterministic PostgreSQL-backed search and an integration test. |
| 5 | Add real OpenAI embeddings and Pinecone behind a search-provider interface. |
| 6–7 | Add deals, versioned terms, mutual approvals, append-only events, and deterministic state transitions. |

### Week 2 — The Agent Layer (Days 8–14)

| Day | Task |
|---|---|
| 8 | Implement `MockEscrowProvider` and test explicit funding/release/refund authorization. |
| 9 | Build Matchmaker clarification and ranking workflow; retain deterministic fallbacks and evaluations. |
| 10–11 | Build Negotiator drafting workflow; test that it cannot approve terms or invoke escrow. |
| 12 | Add direct-to-S3 private file delivery, metadata, checksums, and versioning. |
| 13 | Build Delivery Monitor reminders and dispute-evidence summaries without auto-release authority. |
| 14 | Integration pass: search → negotiate → mutual approval → mock funding → upload → explicit acceptance. |

### Week 3 — Frontend + Polish (Days 15–21)

| Day | Task |
|---|---|
| 15 | Build Agent chat UI on Deal Negotiation page. |
| 16 | Build Deal Dashboard with real-time status + agent message log. |
| 17 | Build talent profile and hybrid wallet-linking flow. |
| 18 | Add email magic-link or passkey authentication; wallet remains a separate verified association. |
| 19 | Port Polkadot escrow behind the provider interface if network, asset, fee, and contract decisions are resolved; otherwise demo the labeled mock. |
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

**The product in one sentence:** *"AI helps you discover Caribbean talent, agree on fair terms,
and complete a secure creative-services deal settled transparently through Polkadot."*

---

1. **Brief submitted.** Buyer types: *"I need upbeat soca for a summer campaign in Trinidad."*
   The Matchmaker Agent asks: *"Will this be used in video content or audio only? That affects
   which artists I'd recommend."* Buyer answers. Agent returns three ranked artists with
   specific explanations.

2. **Artist selected.** Buyer clicks "Book This Artist." The Negotiator Agent opens a
   three-way chat and drafts project terms: *"Based on your brief and Kes's standard rate, I'm
   proposing: one original soca track, 30-second ad length, non-exclusive use, delivered in 7
   days, 500 USDC, one included revision."* Buyer and artist each approve the same terms version.

3. **Agent flags a risk.** Buyer edits terms to request exclusive rights. Agent responds:
   *"Exclusive rights are unusual at this price point — Kes typically charges 3× for
   exclusivity. I'd suggest either removing exclusivity or increasing the offer."*

4. **Deal funded.** Both parties agree. Buyer locks 500 USDC into the Polkadot escrow
   contract. Transaction hash appears — verifiable on-chain in real time.

5. **Delivery Monitor takes over.** Agent sends artist a reminder at day 4.
   Artist submits the track on day 6. Agent notifies buyer to confirm.

6. **Explicit release.** Buyer reviews the uploaded file and accepts delivery. The wallet asks
   the buyer to authorize release, then the smart contract releases 500 USDC to the
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
| Bounded agent autonomy | Agents independently search, clarify, draft, monitor, and summarize within explicit authority limits |
| Multi-agent coordination | Matchmaker → Negotiator → Monitor handoff chain via ADK workflows |
| Workflow orchestration | ADK `deal-lifecycle` workflow passes structured state across all three agents and the blockchain layer |
| Reasoning capability | Matchmaker asks clarifying questions; Negotiator flags risks; Monitor selects reminders and summarizes dispute evidence |
| Human-in-the-loop design | Both parties approve terms; users authorize financial actions; unresolved disputes escalate to an administrator |
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
