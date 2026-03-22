# Architecture: Cross-Session Knowledge Broker

## Problem Statement

OpenClaw sessions are isolated by design. Each session maintains its own conversation context — the rolling window of messages sent to the LLM on every turn. When a user mentions something important on WhatsApp ("My meeting with Acme was moved to Thursday"), that information is invisible to the Slack session they open twenty minutes later.

The naive fix — merging all session contexts into a single shared window — doesn't work. Token budgets are finite and expensive. Dumping every message from every channel into every session would inflate costs, degrade latency, and hit context window limits almost immediately.

The real fix is **selective, near-real-time propagation of durable facts** — not full conversation histories.

---

## Solution Overview

The **Knowledge Broker** is a lightweight OpenClaw plugin that intercepts session turns, extracts meaningful facts, writes them to a shared disk store, and injects relevant facts into new session turns. No external infrastructure. No databases. No network round-trips between services.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            OpenClaw Gateway                                 │
│                                                                             │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐                │
│  │  WhatsApp    │     │    Slack     │     │   Telegram   │                │
│  │   Session    │     │   Session    │     │   Session    │                │
│  │              │     │              │     │              │                │
│  │ [context A]  │     │ [context B]  │     │ [context C]  │                │
│  └──────┬───────┘     └──────┬───────┘     └──────┬───────┘               │
│         │ message:received   │ message:received   │ agent:bootstrap        │
│         ▼                    ▼                    ▼                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    Knowledge Broker Plugin                           │  │
│  │                                                                      │  │
│  │  ① Heuristic filter    → discard noise (lol, ok, emoji, …)          │  │
│  │  ② Fact extraction     → heuristic patterns (or async LLM call)     │  │
│  │  ③ Conflict detection  → check for contradictory existing facts      │  │
│  │  ④ Atomic write        → write-then-rename to shared-knowledge.json  │  │
│  │  ⑤ Bootstrap injection → prepend compact fact list to session context│  │
│  │                                                                      │  │
│  └──────────────────────────────────────┬─────────────────────────────-┘  │
│                                          │                                  │
│                                          ▼                                  │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                    shared-knowledge.json                              │ │
│  │  ~/.openclaw/shared-knowledge.json                                    │ │
│  │                                                                       │ │
│  │  { "version": 1, "facts": [                                          │ │
│  │    { "id": "…", "content": "Meeting with Acme Corp on Thursday",     │ │
│  │      "category": "scheduling", "source": "whatsapp",                 │ │
│  │      "timestamp": 1711234567890, "ttl": 86400000,                    │ │
│  │      "confidence": 0.9, "supersedes": null }                         │ │
│  │  ] }                                                                  │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## How Knowledge Moves Between Sessions

The system uses two complementary layers: an **explicit tool layer** (active now) and an **automatic hook layer** (registered, forward-compatible).

### Layer 1 — Explicit sync via skill and tools (primary)

The `cross-session-sync` skill instructs the agent to call `kb_subscribe` before every response and `kb_publish` when it detects durable facts. This is reliable and works with any OpenClaw version.

**Timing model (explicit layer):**

```
Turn N (source session)          Turn N+1 (target session)
────────────────────────         ─────────────────────────
User: "Acme meeting Thursday"    User: any message
           │                              │
     LLM processes ──→ calls             kb_subscribe called
        kb_publish                        │
           │                        reads shared-knowledge.json
     writes fact to                       │
     shared-knowledge.json          ← fact injected into response
```

Facts are available to the next target session turn — not mid-turn, but within seconds of the source turn completing. This satisfies the "near real-time" constraint at the granularity that matters: cross-session, cross-channel.

### Layer 2 — Automatic hook-based extraction (registered, future-ready)

The plugin registers `message:received` and `agent:bootstrap` hooks for automatic extraction and injection. In the current OpenClaw version these are treated as "unknown typed hooks" and silently ignored. The plugin handles this gracefully — Layer 1 covers the gap.

When OpenClaw adds support for these hooks, Layer 2 activates automatically with zero code changes:

**`message:received`** → runs the heuristic filter and extraction pipeline on every user message, asynchronously (fire-and-forget, zero latency to the LLM turn):

**Stage A — Heuristic pre-filter (zero cost, <1 ms)**
Pattern matching against scheduling keywords (`meeting`, `moved to`, day names), preference markers (`my favorite`, `I prefer`), fact patterns (`X is`, `X works at`), and task patterns (`need to`, `don't forget`). Messages matching none of these are discarded immediately. In practice, conversational filler (greetings, emoji, short responses) is eliminated — the filter's 36 test cases cover the most common noise patterns observed in messaging apps.

**Stage B — Fact extraction (optional, async)**
For messages that pass Stage A, a fast LLM call (Claude Haiku, ~500 tokens, ~$0.0001) extracts structured facts asynchronously. If LLM extraction is disabled (the default), a heuristic extractor picks the most informative sentence.

**`agent:bootstrap`** → prepends recent facts from other sessions into the session context before each turn — identical to what `kb_subscribe` does, but automatic.

### Storage

Extracted facts are written to `~/.openclaw/shared-knowledge.json` using an **atomic rename** pattern:

1. Write to `shared-knowledge.json.tmp.<uuid>`
2. `fs.rename()` the tmp file to the final path

This is safe on POSIX systems (rename is atomic at the VFS level) and tolerant of crashes mid-write. No external locking mechanism is needed for single-node deployments.

### Injection format

Facts are formatted as a compact block prepended to the agent's response context:

```
<!-- cross-session-knowledge (internal) -->
[Shared context from the user's other active sessions:]
- Meeting with Acme Corp moved to Thursday [via telegram, 3m ago]
- User prefers dark mode in all tools [via slack, 1h ago]
<!-- end cross-session-knowledge -->
```

This adds ~50–200 tokens per turn — orders of magnitude cheaper than merging full conversation histories.

---

## Conflict Resolution

**Normal case (> 5 minutes apart):** A newer fact supersedes an older one on the same topic. The old fact is removed from the store and the new one references it via `supersedes`. Last-write-wins.

**Concurrent conflict (< 5 minutes apart):** Both facts are retained. The earlier fact is annotated with `conflictsWith: [newer fact content]`. When injected into a third session, a `⚠ conflicting info exists — prefer this (most recent)` note is appended to the most recent fact.

The conflict window is configurable (`conflictWindowMs`, default 5 minutes). This covers the realistic scenario where a user quickly corrects themselves on a different channel.

**Why last-write-wins?**
It mirrors how users naturally operate: if you say "blue" and then 10 seconds later say "green", you mean green. No vector similarity, no CRDT, no external coordination. Simple and auditable.

---

## Selective Propagation

The filter uses three layers:

| Layer | Mechanism | Cost |
|---|---|---|
| Length & character filter | < 5 chars, emoji-only, < 4 words | 0 |
| Noise phrase list | Exact-match regex against common filler | 0 |
| Category pattern matching | Regex banks for scheduling, preference, fact, task | 0 |

Only messages that pass all three layers proceed to extraction. The LLM extraction layer adds a final `confidence ≥ 0.5` threshold.

**What is propagated:**
- Scheduling (meetings, deadlines, rescheduled events)
- Preferences (favorites, settings, work style)
- Contact information (names, roles, emails)
- Project status (launches, blockers, decisions)
- Tasks and commitments

**What stays local:**
- Greetings and filler ("hi", "lol", "ok")
- Questions (facts live in answers, not questions)
- Emotional expressions without facts ("that sounds great!")
- Turn-by-turn reasoning that only matters within one session

---

## Cost Analysis

| Approach | Added tokens per turn | Added latency |
|---|---|---|
| **No sync (baseline)** | 0 | 0 ms |
| **Knowledge Broker (heuristic)** | 50–200 (injection) | 0 ms |
| **Knowledge Broker (LLM extraction)** | 50–200 (injection) + ~500 (async extraction, on turns that pass the heuristic filter) | 0 ms (async) |
| **Unified context (naive)** | Thousands (grows unboundedly) | Proportional |

The broker adds roughly $0.00001–$0.00005 per turn in injection tokens, and $0.0001 per extracted fact when LLM extraction is enabled. For a user with 10 sessions averaging 50 turns/day, this is under $0.05/month.

---

## Design Decisions

### Why a plugin, not a core fork?

A fork ties your changes to a specific upstream commit. Every upstream patch requires a rebase, creates merge conflicts, and demands ongoing maintenance. A plugin:
- Installs and uninstalls cleanly
- Survives upstream releases without modification in most cases
- Can be versioned and distributed independently
- Is testable in isolation

### Why file-based storage, not Redis or SQLite?

OpenClaw's philosophy is local-first. Adding Redis requires running an additional service (more Docker containers, more ops burden, more failure modes). SQLite would be a valid alternative but adds a native dependency and WAL complexity.

A JSON file with atomic rename is:
- Readable and inspectable with any text editor
- Debuggable (`cat shared-knowledge.json`)
- Trivially backed up
- Fast enough for this access pattern (< 5 writes/minute in realistic usage)

For multi-host deployments, replacing `SharedKnowledgeStore` with a Redis or SQLite implementation is straightforward — the interface is stable.

### Why two extraction paths (heuristic + LLM)?

Heuristic extraction is always-on and zero-cost. LLM extraction is opt-in for teams that want higher accuracy. This lets operators choose their cost/accuracy trade-off without changing the architecture.

### Why not just write everything to MEMORY.md?

MEMORY.md is read into every session's context on every turn. Writing every potentially useful message there would bloat the context and degrade quality. The broker is additive and scoped: it only injects facts that exist in other sessions and haven't expired, keeping the injection small and relevant.

---

## Failure Modes and Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Store file corrupted mid-write | One write lost | Atomic rename prevents partial files; next write heals the store |
| LLM extraction takes too long | None — runs async | Fire-and-forget; the turn is never blocked |
| False positive (noise gets stored) | Slightly polluted context | Low confidence threshold + TTL expiry cleans it up |
| False negative (fact missed) | Fact not propagated | Skill instructs agents to call `kb_publish` explicitly as backup |
| High write concurrency | Last-write-wins race | Acceptable on single node; multiple writes within a tick are rare in practice |
