/**
 * Integration tests — simulate a realistic multi-session knowledge sync scenario.
 *
 * These tests exercise the full pipeline:
 *   message → filter → extract → store → retrieve → format
 *
 * No OpenClaw gateway required; we call the store/filter/extractor directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { SharedKnowledgeStore } from '../src/store.js';
import { screenMessage } from '../src/filters.js';
import { extractFactsHeuristic } from '../src/extractor.js';
import { formatFactsForContext } from '../src/injector.js';
import type { PluginConfig } from '../src/types.js';

function makeConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    storePath: join(tmpdir(), `kb-integration-${randomUUID()}.json`),
    maxFacts: 100,
    ttl: {
      scheduling: 86_400_000,
      preference: 604_800_000,
      contact: 2_592_000_000,
      project: 604_800_000,
      task: 86_400_000,
      fact: 86_400_000,
    },
    conflictWindowMs: 5 * 60 * 1000,
    extractionEnabled: false,
    injectionMaxFacts: 10,
    injectionMaxAge: 86_400_000,
    ...overrides,
  };
}

/** Simulate what the plugin does on message:received */
async function simulateReceive(
  store: SharedKnowledgeStore,
  message: string,
  sessionKey: string,
  channel: string,
): Promise<void> {
  const filterResult = screenMessage(message);
  if (filterResult.isNoise) return;
  const extraction = extractFactsHeuristic(message, filterResult);
  if (extraction.facts.length > 0) {
    await store.publishFacts(extraction.facts, sessionKey, channel);
  }
}

describe('Integration: cross-session knowledge propagation', () => {
  const tempFiles: string[] = [];

  afterEach(async () => {
    for (const f of tempFiles) {
      await fs.rm(f, { force: true }).catch(() => {});
    }
    tempFiles.length = 0;
  });

  // ── Scenario 1: basic propagation ────────────────────────────────────

  it('fact shared on WhatsApp is available on Slack', async () => {
    const config = makeConfig();
    tempFiles.push(config.storePath);
    const store = new SharedKnowledgeStore(config.storePath, config);

    const whatsappSession = 'agent:default:whatsapp:user1';
    const slackSession = 'agent:default:slack:user1';

    // WhatsApp session receives a meaningful user message
    await simulateReceive(
      store,
      'My meeting with Acme Corp was moved to Thursday at 3 PM',
      whatsappSession,
      'whatsapp',
    );

    // Slack session queries for shared facts
    const facts = await store.getRecentFacts({ excludeSessionKey: slackSession });

    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].source).toBe('whatsapp');
    // The content should include the key entities
    expect(facts[0].content.toLowerCase()).toMatch(/acme|meeting|thursday/);
  });

  // ── Scenario 2: noise is not propagated ──────────────────────────────

  it('noise messages (lol, ok, emoji-only) are NOT stored', async () => {
    const config = makeConfig();
    tempFiles.push(config.storePath);
    const store = new SharedKnowledgeStore(config.storePath, config);

    const session = 'agent:default:whatsapp:user1';
    const other = 'agent:default:slack:user1';

    const noiseMessages = ['lol', 'ok', 'haha', '👍', '😂', 'sure', 'yes', 'k'];

    for (const msg of noiseMessages) {
      await simulateReceive(store, msg, session, 'whatsapp');
    }

    const facts = await store.getRecentFacts({ excludeSessionKey: other });
    expect(facts).toHaveLength(0);
  });

  // ── Scenario 3: conflicting updates ──────────────────────────────────

  it('contradictory preference updates within 5 min are marked conflicted', async () => {
    const config = makeConfig({ conflictWindowMs: 5 * 60 * 1000 });
    tempFiles.push(config.storePath);
    const store = new SharedKnowledgeStore(config.storePath, config);

    const whatsappSession = 'agent:default:whatsapp:user1';
    const slackSession = 'agent:default:slack:user1';

    // WhatsApp: "blue"
    await simulateReceive(
      store,
      'My favorite color is blue',
      whatsappSession,
      'whatsapp',
    );

    // Slack: "green" — 10 seconds later (within conflict window)
    await simulateReceive(
      store,
      'My favorite color is green',
      slackSession,
      'slack',
    );

    const all = await store.getAllFacts();
    expect(all).toHaveLength(2);

    // At least one fact should reference the conflict
    const conflicted = all.filter(
      (f) => f.conflictsWith && f.conflictsWith.length > 0,
    );
    expect(conflicted.length).toBeGreaterThanOrEqual(1);

    // When injected into a third session, the conflict note should appear
    const formatted = formatFactsForContext(all);
    expect(formatted).toMatch(/conflict|⚠/i);
  });

  it('preference update after conflict window supersedes old value', async () => {
    const config = makeConfig({ conflictWindowMs: 100 }); // 100 ms for test speed
    tempFiles.push(config.storePath);
    const store = new SharedKnowledgeStore(config.storePath, config);

    const whatsappSession = 'agent:default:whatsapp:user1';
    const slackSession = 'agent:default:slack:user1';

    await simulateReceive(
      store,
      'My favorite color is blue',
      whatsappSession,
      'whatsapp',
    );

    await new Promise((r) => setTimeout(r, 150)); // let the window expire

    await simulateReceive(
      store,
      'My favorite color is green',
      slackSession,
      'slack',
    );

    const all = await store.getAllFacts();
    // Only the newer fact should remain
    expect(all).toHaveLength(1);
    expect(all[0].content.toLowerCase()).toContain('green');
  });

  // ── Scenario 4: multiple channels, single query ───────────────────────

  it('telegram session sees facts from both WhatsApp and Slack', async () => {
    const config = makeConfig();
    tempFiles.push(config.storePath);
    const store = new SharedKnowledgeStore(config.storePath, config);

    await simulateReceive(
      store,
      'The project deadline is this Friday',
      'agent:default:whatsapp:user1',
      'whatsapp',
    );
    await simulateReceive(
      store,
      'My preferred IDE is VS Code with dark theme',
      'agent:default:slack:user1',
      'slack',
    );

    const telegramSession = 'agent:default:telegram:user1';
    const facts = await store.getRecentFacts({ excludeSessionKey: telegramSession });

    expect(facts).toHaveLength(2);
    const sources = new Set(facts.map((f) => f.source));
    expect(sources.has('whatsapp')).toBe(true);
    expect(sources.has('slack')).toBe(true);
  });

  // ── Scenario 5: context formatting ───────────────────────────────────

  it('formatFactsForContext produces a non-empty, readable string', async () => {
    const config = makeConfig();
    tempFiles.push(config.storePath);
    const store = new SharedKnowledgeStore(config.storePath, config);

    await simulateReceive(
      store,
      'Meeting with Acme Corp rescheduled to Thursday at 3 PM',
      'agent:default:whatsapp:user1',
      'whatsapp',
    );

    const facts = await store.getRecentFacts({
      excludeSessionKey: 'agent:default:slack:user1',
    });

    const formatted = formatFactsForContext(facts);

    expect(formatted).toContain('cross-session-knowledge');
    expect(formatted).toContain('whatsapp');
    expect(formatted.length).toBeGreaterThan(50);
    // Should be within token budget (400 tokens ~ 1600 chars)
    expect(formatted.length).toBeLessThan(2000);
  });

  // ── Scenario 6: maxAge filtering ─────────────────────────────────────

  it('facts older than maxAge are not returned', async () => {
    const config = makeConfig();
    tempFiles.push(config.storePath);
    const store = new SharedKnowledgeStore(config.storePath, config);

    // Publish a fact with a very short TTL via direct API
    await store.publishFacts(
      [{ content: 'Lunch at noon today', category: 'scheduling', confidence: 0.8 }],
      'agent:default:whatsapp:u1',
      'whatsapp',
    );

    // Query with maxAge of 0 ms — nothing should be returned
    const facts = await store.getRecentFacts({
      excludeSessionKey: 'agent:default:slack:u1',
      maxAge: 0,
    });

    expect(facts).toHaveLength(0);
  });
});
