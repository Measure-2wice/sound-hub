---
status: accepted
---

# Agents reason within deterministic workflows

SoundHub agents interpret briefs, clarify intent, select tools, draft terms, summarize evidence,
and recommend actions, while deterministic application services own authorization, state
transitions, deadlines, approvals, and payments. PostgreSQL is authoritative; model, vector, Redis,
and agent-runtime state are replaceable infrastructure. This preserves a meaningful agentic layer
without allowing probabilistic output to become marketplace truth.

## Consequences

- The Matchmaker converts natural language into required constraints and preferences, then invokes
  a deterministic TalentSearchService through a tool boundary.
- Required constraints are never relaxed without buyer approval.
- PostgreSQL/vector or model failures degrade to deterministic PostgreSQL search; PostgreSQL failure
  stops search safely.
- Deadline monitoring is triggered by recoverable jobs and application services. The Delivery
  Monitor Agent assists with analysis and communication but does not own the clock.
- User-visible conversations and binding records remain in PostgreSQL. Redis may later provide
  replaceable queues, caches, locks, and rate limits, but is not a Milestone 1 dependency.
- AgentRun audits store versions, redacted structured inputs, tool activity, and validated outputs,
  never hidden reasoning, secrets, or unrestricted raw private data.
