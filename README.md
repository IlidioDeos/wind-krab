# Cross-Session Knowledge Broker for OpenClaw

Solution to the *Cross-Session Memory Synchronization* technical challenge.

**Problem:** Each OpenClaw session maintains its own isolated context. A fact mentioned on Telegram ("My Acme meeting was moved to Thursday") is invisible to the Slack session opened minutes later.

**Solution:** A lightweight plugin that extracts meaningful facts from session turns and propagates them to other sessions in near real-time, using a shared JSON file as the knowledge store. Zero external infrastructure. Zero added latency to LLM turns.

---

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop) (Docker Engine ≥ 24)
- An [OpenRouter API key](https://openrouter.ai/keys)

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. Required and optional fields:

| Variable | Required | How to obtain |
|---|---|---|
| `OPENROUTER_API_KEY` | ✅ | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `TELEGRAM_BOT_TOKEN` | optional | Open `@BotFather` on Telegram → `/newbot` |
| `SLACK_APP_TOKEN` | optional | [api.slack.com/apps](https://api.slack.com/apps) → Socket Mode → App-Level Token |
| `SLACK_BOT_TOKEN` | optional | Same app → OAuth & Permissions → Bot Token |

> Channels configured in `.env` are enabled **automatically** when the container starts — no manual steps required.

**Slack note:** After creating the Slack app, go to **Event Subscriptions → Subscribe to bot events** and add `message.im` (for DMs) and optionally `app_mention` (for channel @mentions). Reinstall the app to your workspace after saving.

### 2. Start (compiles plugin, builds and starts Docker)

```bash
./scripts/setup.sh
```

The gateway starts at `http://localhost:18789`. Logs show which channels were configured:

```
[entrypoint] Telegram channel configured
[entrypoint] Slack channel configured
```

### 3. WhatsApp (requires QR code scan — only interactive channel)

```bash
docker compose exec openclaw openclaw channels login --channel whatsapp
```

### 4. Run the test scenarios

```bash
./scripts/test-scenarios.sh
```

### 5. Run unit tests

```bash
cd extensions/knowledge-broker
npm install
npm test
```

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document including diagrams, cost analysis, conflict resolution strategy, and design decisions.

```
session A (Telegram) ──→ kb_publish tool  ←── cross-session-sync skill
                              │
                         ① Heuristic filter  (zero cost, <1 ms)
                              │
                         ② Fact extraction   (heuristic or async LLM)
                              │
                         ③ Atomic write ──→ shared-knowledge.json
                                                   │
session B (Slack) ────────────────────────────────→│
  kb_subscribe tool  ←── cross-session-sync skill  │
       │                                            │
  ④ Read recent facts ←────────────────────────────┘
       │
  ⑤ Inject compact fact list into response context
       (~50–200 tokens)
```

**How sync happens:** The `cross-session-sync` skill instructs the agent to call `kb_subscribe` before every response and `kb_publish` when it detects durable facts. This is the primary synchronization layer. The plugin also registers `message:received` and `agent:bootstrap` hooks for future automatic extraction when OpenClaw adds support.

---

## Project Structure

```
.
├── ARCHITECTURE.md                    # Full design document
├── DISCUSSION.md                      # Part 2: discussion answers
├── docker-compose.yml                 # Docker Compose (single service)
├── Dockerfile                         # Builds plugin + OpenClaw image
├── .env.example                       # Environment variable template
│
├── extensions/
│   └── knowledge-broker/              # The OpenClaw plugin
│       ├── openclaw.plugin.json       # Plugin manifest
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       ├── src/
│       │   ├── index.ts               # Plugin entry (hooks + tools)
│       │   ├── store.ts               # Shared JSON knowledge store
│       │   ├── filters.ts             # Heuristic noise filter
│       │   ├── extractor.ts           # Fact extraction (heuristic + LLM)
│       │   ├── injector.ts            # Context formatting for injection
│       │   └── types.ts               # TypeScript types
│       └── tests/
│           ├── store.test.ts          # Store: CRUD, conflict, expiry, concurrency
│           ├── filters.test.ts        # Filter: noise vs. signal classification
│           ├── extractor.test.ts      # Extractor: heuristic fact extraction
│           └── integration.test.ts    # Full pipeline end-to-end
│
├── skills/
│   └── cross-session-sync/
│       └── SKILL.md                   # Agent instructions for explicit sync
│
├── config/
│   └── openclaw.json                  # OpenClaw configuration (plugin enabled)
│
└── scripts/
    ├── setup.sh                       # One-command setup
    ├── test-scenarios.sh              # End-to-end webhook-based tests
    └── docker-entrypoint.sh           # Container entrypoint
```

---

## How It Works

### Primary sync layer: skill-based (explicit tool calls)

The `cross-session-sync` skill instructs the agent to:

1. **On every turn:** Call `kb_subscribe` to load recent facts from other sessions before generating a response.
2. **After user messages:** Call `kb_publish` when the message contains scheduling info, preferences, contact details, project updates, tasks, or any durable fact.

This gives reliable cross-session sync without requiring any special OpenClaw hook support.

### Secondary sync layer: hook-based (automatic, future-ready)

The plugin also registers `message:received` and `agent:bootstrap` hooks. These are registered but currently treated as "unknown typed hooks" by this version of OpenClaw and silently ignored. When OpenClaw adds support for these hooks, the plugin will automatically extract facts from every message without needing the skill as an intermediary — at zero additional latency (the extraction runs asynchronously).

### Explicit tools

The plugin registers three tools that agents can call directly:

| Tool | Purpose |
|---|---|
| `kb_publish` | Publish extracted facts to the shared store |
| `kb_subscribe` | Retrieve recent facts from other sessions |
| `kb_clear` | Clear the store (admin / testing) |

### Conflict resolution

- **Within 5 minutes:** Both facts are retained and annotated with `conflictsWith`. The injected context includes a conflict warning on the most recent fact.
- **After 5 minutes:** The newer fact supersedes the older one. The old fact is removed.

---

## Configuration

Plugin config lives in `config/openclaw.json` under `plugins.entries.knowledge-broker.config`:

| Key | Default | Description |
|---|---|---|
| `storePath` | `~/.openclaw/shared-knowledge.json` | Path to the shared store |
| `maxFacts` | `200` | Max facts to keep in the store |
| `ttl.scheduling` | `86400000` (24h) | TTL for scheduling facts |
| `ttl.preference` | `604800000` (7d) | TTL for preference facts |
| `ttl.contact` | `2592000000` (30d) | TTL for contact facts |
| `conflictWindowMs` | `300000` (5m) | Window for conflict detection |
| `extractionEnabled` | `false` | Use LLM for extraction (more accurate, small cost) |
| `injectionMaxFacts` | `10` | Max facts injected per turn |
| `injectionMaxAge` | `86400000` (24h) | Max age of injected facts |

---

## Troubleshooting

**Gateway doesn't start**
```bash
docker compose logs openclaw
```

**Plugin not loading**
```bash
docker compose exec openclaw openclaw plugins list
docker compose exec openclaw openclaw plugins doctor
```

**Inspect the shared knowledge store**
```bash
docker compose exec openclaw cat ~/.openclaw/shared-knowledge.json
```

**Rebuild after plugin changes**
```bash
cd extensions/knowledge-broker && npm run build
docker compose restart openclaw
```

**Wipe state and start fresh**
```bash
docker compose down -v && docker compose up -d --build
```

---

## Note on the Docker Image

This project uses `ghcr.io/openclaw/openclaw:latest` as the base image. If this image is not yet publicly available on the GitHub Container Registry, you can build OpenClaw from source:

```bash
git clone https://github.com/openclaw/openclaw.git _openclaw
cd _openclaw && ./scripts/docker/setup.sh
```

Then update the `FROM` line in `Dockerfile` to `FROM openclaw:local`.
