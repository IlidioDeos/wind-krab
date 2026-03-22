# Discussion Questions

## 2.1 — Alternatives to OpenClaw

If I were not using OpenClaw, my primary alternative would depend on whether the system needs to run fully locally or can tolerate a cloud-connected architecture.

### For a local-first, self-hosted system: **n8n + a custom LLM orchestrator**

n8n is a workflow automation tool with 400+ integrations (Slack, WhatsApp via Twilio, Telegram, Discord, Teams). I would pair it with a thin LLM orchestration layer (a few hundred lines of Node.js or Python) that wraps Anthropic's API directly.

**Extensibility and plugin ecosystem**
n8n's node-based model is exceptionally flexible. Adding a new channel means writing or installing a node — not understanding a framework's internal abstractions. Custom business logic lives in Code nodes. This compares favorably to OpenClaw's plugin SDK, which requires TypeScript and knowledge of OpenClaw's internal hook API (which is sparsely documented).

**Multi-channel messaging support**
n8n has more production-proven integrations than OpenClaw — particularly for enterprise channels like MS Teams, Google Chat, and Salesforce. OpenClaw's 22+ adapters are impressive for a young project, but some are community-maintained and may lag behind platform API changes.

**Local-first vs. cloud-first**
Both can run self-hosted. n8n has a strong self-hosted community; OpenClaw is local-first by design and avoids cloud dependencies more aggressively. For the cross-session memory problem specifically, both need the same thing: shared persistent state accessible from all workers.

**Community maturity**
n8n has ~70k GitHub stars, a commercial entity behind it, and a large contributor base. OpenClaw (≈2026) is early-stage. For a production system, n8n's maturity reduces operational risk significantly.

**The honest tradeoff:** n8n is a workflow tool, not an AI agent framework. For tasks that require deep agent reasoning (multi-step tool use, long-horizon planning), you'd need to build the LLM orchestration layer yourself. OpenClaw gives you that for free. The question is whether the agent primitives OpenClaw provides are worth the ecosystem immaturity.

### For a cloud-first system: **LangChain / LangGraph + a hosted messaging platform**

LangGraph provides state-machine-style agent orchestration with first-class support for persistence and memory. Its `MemorySaver` / `PostgresSaver` backend can serve as a shared cross-session store natively. Cross-session sharing becomes a matter of configuring the right `thread_id` scope.

The weakness: LangGraph adds significant complexity for simple tasks and doesn't ship channel adapters — you still need to connect messaging platforms yourself (usually via Twilio, Slack SDK, Telegram Bot API, etc.).

---

## 2.2 — Advantages and Disadvantages of OpenClaw

### Strongest architectural decisions

**Plugin-first design.** Almost every capability (LLM providers, channels, tools, memory) is a plugin. This creates a clean separation between the core (Gateway, session management, message routing) and the capabilities that use it. It also means the community can extend OpenClaw without forking.

**Local gateway model.** The WebSocket Gateway running on `127.0.0.1:18789` keeps all data on the user's machine by default. This is architecturally correct for a personal assistant: your conversation history, credentials, and memory stay local. Cloud services are opt-in, not mandatory.

**Sessions as first-class objects.** The fact that sessions are individually managed (with their own context windows, JSONL transcripts, compaction policies) and that the gateway routes messages to them by type is a sound abstraction. It avoids the "one big global context" anti-pattern that plagues many AI agent frameworks.

**No orchestration framework.** OpenClaw deliberately avoids LangChain-style chains and agents. For 90% of use cases, direct LLM calls with the right system prompt and tools are more predictable and cheaper than multi-step orchestration. This is pragmatic.

### Where it falls short

**Sparse hook API documentation.** The exact names and signatures of lifecycle events (`message:received`, `agent:bootstrap`, etc.) are not documented with type signatures. Plugin authors must read the source or reverse-engineer from examples. This is a significant friction point.

**Single-node architecture.** The Gateway is a singleton process on one machine. There is no built-in clustering, high availability, or horizontal scaling. For a personal assistant this is fine; for a team or enterprise deployment, it becomes a hard constraint.

**Conflict between sessions and agents.** The cross-session memory problem exists precisely because OpenClaw's session isolation is so clean — each session's context is independent. This is a feature that creates a gap. The `memory.md` bridge is useful but too coarse for ephemeral, session-specific information.

**Community governance risk.** OpenClaw appears to be maintained by a small team (or possibly a solo developer). If the primary maintainer steps back, the project could stagnate. There is no evidence of a foundation, a clear governance model, or a roadmap commitment. Depending on it for production systems before it reaches v1.0 stability is a risk.

### How the "no vector database, no orchestration framework" philosophy helps and hinders

**Helps:** The cross-session memory problem does not require vector search. The broker's keyword-based fact similarity check is fast, readable, and deterministic. Avoiding a vector database means no additional service to run, no embedding model to manage, and no latency for similarity queries. The broker is entirely file-based and ships in ~500 lines of TypeScript.

**Hinders:** Without semantic embeddings, the broker's fact deduplication relies on keyword overlap. Two facts that say the same thing with different words ("The Acme meeting is Thursday" vs. "Thursday is when we meet with Acme") would not be detected as related. A vector store would handle this trivially. For now, keyword matching covers 80–90% of real cases; the remaining 10–20% results in minor redundancy rather than data loss.

---

## 2.3 — Maintaining a Custom Fork

I did not fork OpenClaw for this solution — I wrote a plugin. This is the most important upstream-compatibility decision I made, and I'd make it again.

### Strategy: thin plugin, no fork

The plugin has no direct dependency on OpenClaw's internal modules. It imports only from `openclaw/plugin-sdk/plugin-entry` (the stable public API surface) and the TypeBox type library. The hook event names (`message:received`, `agent:bootstrap`) are the only points of coupling to OpenClaw's internals.

If upstream renames a hook, the fix is a one-line change in `src/index.ts`. If upstream removes a hook, we fall back to the explicit tool-based approach (the skill + `kb_publish`/`kb_subscribe` tools), which requires no hooks at all.

### Branching strategy

```
main                  ← our stable release branch
  ↑
develop               ← integration branch for new features
  ↑
feature/…             ← short-lived feature branches

upstream-tracking     ← mirrors openclaw/openclaw main; updated weekly via CI
```

`upstream-tracking` is a mirror, not a development branch. Its only purpose is to run our integration tests against the latest OpenClaw release before we merge anything to `main`.

### Dependency pinning

`openclaw` is listed as a `peerDependency` with `"*"` — we don't pin it. This is intentional: the plugin should work across a range of OpenClaw versions. We test against the three most recent minor releases in CI.

For the test environment, we pin to a specific version using `npm install openclaw@2026.3.14 --save-dev` so our CI is reproducible. Dependabot opens a PR weekly to bump this pin.

### CI/CD compatibility testing

```yaml
# .github/workflows/compat.yml
strategy:
  matrix:
    openclaw-version: ["2026.1.0", "2026.2.0", "2026.3.0", "latest"]
steps:
  - run: npm install openclaw@${{ matrix.openclaw-version }}
  - run: npm test
```

If a new OpenClaw release breaks any test, the PR is blocked. The failure is triaged within 24 hours: either we fix the plugin (if the change is intentional breaking), or we open an issue upstream (if the change is a regression).

### Adapter pattern for hook coupling

The `api.on()` calls in `src/index.ts` are the only place we depend on OpenClaw's hook names. I've wrapped them in a small abstraction:

```typescript
// If upstream renames hooks, update only this map
const HOOK_NAMES = {
  bootstrap: 'agent:bootstrap',
  messageReceived: 'message:received',
};
```

If OpenClaw ever renames these events, the fix is a one-line change in the constant map, not a search across the codebase.

### Contributing back vs. maintaining separately

I would contribute back if:
1. The change is generally useful to any OpenClaw user (e.g., a new hook event for post-turn extraction)
2. It requires modifying core OpenClaw code (e.g., adding a more expressive `agent:bootstrap` context API)
3. It has no opinion about our specific use case

I would maintain separately if:
1. The change is specific to the knowledge-broker use case
2. It requires configuration that would be confusing for the general user
3. Upstream is unlikely to accept it in reasonable time (long review queues, governance issues)

In this solution, the only upstream contribution worth proposing is adding explicit context manipulation support to the `agent:bootstrap` hook — allowing plugins to prepend content to the bootstrap block with a typed API rather than relying on duck-typed property access.

### Risk register

| Risk | Probability | Mitigation |
|---|---|---|
| OpenClaw renames `message:received` | Low (stable hook) | `HOOK_NAMES` constant; integration tests catch it |
| OpenClaw changes plugin SDK import paths | Medium | CI tests against each minor version; `skipLibCheck` tolerates type divergence |
| OpenClaw abandons the project | Low–Medium | Plugin has no hard OpenClaw dependency at runtime; could be adapted to another framework's hook system |
| `agent:bootstrap` context API changes | Medium | Defensive duck-typing with three fallback property paths in the hook handler |
