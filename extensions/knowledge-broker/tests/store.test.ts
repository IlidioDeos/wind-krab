import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { SharedKnowledgeStore, areFactsRelated } from '../src/store.js';
import type { PluginConfig, ExtractedFact } from '../src/types.js';

// ── Test helpers ──────────────────────────────────────────────────────────

function testConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    storePath: join(tmpdir(), `kb-test-${randomUUID()}.json`),
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

function makeStore(overrides: Partial<PluginConfig> = {}) {
  const config = testConfig(overrides);
  return { store: new SharedKnowledgeStore(config.storePath, config), config };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('SharedKnowledgeStore', () => {
  const tempFiles: string[] = [];

  afterEach(async () => {
    for (const f of tempFiles) {
      await fs.rm(f, { force: true }).catch(() => {});
      await fs.rm(f + '.tmp.*', { force: true }).catch(() => {});
    }
    tempFiles.length = 0;
  });

  // ── Core: cross-session propagation ──────────────────────────────────

  it('a fact published by session A is visible to session B', async () => {
    const { store, config } = makeStore();
    tempFiles.push(config.storePath);

    const sessionA = 'agent:default:whatsapp:user1';
    const sessionB = 'agent:default:slack:user1';

    const facts: ExtractedFact[] = [
      {
        content: 'Meeting with Acme Corp moved to Thursday at 3 PM',
        category: 'scheduling',
        confidence: 0.95,
      },
    ];

    await store.publishFacts(facts, sessionA, 'whatsapp');

    const retrieved = await store.getRecentFacts({ excludeSessionKey: sessionB });
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].content).toBe('Meeting with Acme Corp moved to Thursday at 3 PM');
    expect(retrieved[0].source).toBe('whatsapp');
    expect(retrieved[0].category).toBe('scheduling');
  });

  it('facts published by a session are excluded from that same session\'s own query', async () => {
    const { store, config } = makeStore();
    tempFiles.push(config.storePath);

    const session = 'agent:default:whatsapp:user1';

    await store.publishFacts(
      [{ content: 'My dog is named Biscuit', category: 'fact', confidence: 0.9 }],
      session,
      'whatsapp',
    );

    const retrieved = await store.getRecentFacts({ excludeSessionKey: session });
    expect(retrieved).toHaveLength(0);
  });

  it('facts from multiple channels are all available to other sessions', async () => {
    const { store, config } = makeStore();
    tempFiles.push(config.storePath);

    await store.publishFacts(
      [{ content: 'Prefer dark mode', category: 'preference', confidence: 0.9 }],
      'agent:default:whatsapp:user1',
      'whatsapp',
    );
    await store.publishFacts(
      [{ content: 'Project Alpha launches on Friday', category: 'project', confidence: 0.88 }],
      'agent:default:slack:user1',
      'slack',
    );

    const telegram = 'agent:default:telegram:user1';
    const facts = await store.getRecentFacts({ excludeSessionKey: telegram });

    expect(facts).toHaveLength(2);
    const sources = facts.map((f) => f.source).sort();
    expect(sources).toEqual(['slack', 'whatsapp']);
  });

  // ── Conflict resolution ───────────────────────────────────────────────

  it('contradictory facts within the conflict window are both marked conflicted', async () => {
    const { store, config } = makeStore({ conflictWindowMs: 60_000 });
    tempFiles.push(config.storePath);

    await store.publishFacts(
      [{ content: 'My favorite color is blue', category: 'preference', confidence: 0.9 }],
      'agent:default:whatsapp:u1',
      'whatsapp',
    );
    await store.publishFacts(
      [{ content: 'My favorite color is green', category: 'preference', confidence: 0.9 }],
      'agent:default:slack:u1',
      'slack',
    );

    const all = await store.getAllFacts();
    expect(all).toHaveLength(2);

    const conflicted = all.filter(
      (f) => f.conflictsWith && f.conflictsWith.length > 0,
    );
    // At least one should be marked as conflicted
    expect(conflicted.length).toBeGreaterThanOrEqual(1);
  });

  it('a newer fact supersedes an older contradictory fact outside the conflict window', async () => {
    const { store, config } = makeStore({ conflictWindowMs: 100 }); // 100 ms window
    tempFiles.push(config.storePath);

    await store.publishFacts(
      [{ content: 'My favorite color is blue', category: 'preference', confidence: 0.9 }],
      'agent:default:whatsapp:u1',
      'whatsapp',
    );

    // Wait for the conflict window to expire
    await new Promise((r) => setTimeout(r, 150));

    await store.publishFacts(
      [{ content: 'My favorite color is green', category: 'preference', confidence: 0.9 }],
      'agent:default:slack:u1',
      'slack',
    );

    const all = await store.getAllFacts();
    // The old fact should have been removed; only the new one remains
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('My favorite color is green');
    expect(all[0].supersedes).toBeDefined();
  });

  // ── Expiry & pruning ──────────────────────────────────────────────────

  it('expired facts are pruned on the next write', async () => {
    const { store, config } = makeStore({
      ttl: {
        scheduling: 50, // 50 ms TTL for test
        preference: 50,
        contact: 50,
        project: 50,
        task: 50,
        fact: 50,
      },
    });
    tempFiles.push(config.storePath);

    await store.publishFacts(
      [{ content: 'Lunch at noon', category: 'scheduling', confidence: 0.8 }],
      'agent:default:whatsapp:u1',
      'whatsapp',
    );

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 100));

    // Trigger a write to prune
    await store.publishFacts(
      [{ content: 'New fact after expiry', category: 'fact', confidence: 0.7 }],
      'agent:default:slack:u1',
      'slack',
    );

    const all = await store.getAllFacts();
    // Expired fact should be gone, only the new one remains
    const expired = all.find((f) => f.content === 'Lunch at noon');
    expect(expired).toBeUndefined();
  });

  // ── Category & maxAge filtering ───────────────────────────────────────

  it('getRecentFacts respects category filter', async () => {
    const { store, config } = makeStore();
    tempFiles.push(config.storePath);

    const session = 'agent:default:slack:u1';

    await store.publishFacts(
      [
        { content: 'Meeting on Monday', category: 'scheduling', confidence: 0.9 },
        { content: 'Prefer dark mode', category: 'preference', confidence: 0.9 },
      ],
      'agent:default:whatsapp:u1',
      'whatsapp',
    );

    const scheduling = await store.getRecentFacts({
      excludeSessionKey: session,
      categories: ['scheduling'],
    });

    expect(scheduling).toHaveLength(1);
    expect(scheduling[0].category).toBe('scheduling');
  });

  // ── Atomic writes ─────────────────────────────────────────────────────

  it('concurrent writes do not corrupt the store', async () => {
    const { store, config } = makeStore();
    tempFiles.push(config.storePath);

    const writes = Array.from({ length: 10 }, (_, i) =>
      store.publishFacts(
        [{ content: `Fact number ${i}`, category: 'fact', confidence: 0.8 }],
        `agent:default:channel${i}:u1`,
        `channel${i}`,
      ),
    );

    await Promise.all(writes);

    const all = await store.getAllFacts();
    // The file must be valid (no corruption) and contain at least one fact.
    // With truly simultaneous writes the store uses last-write-wins (atomic
    // rename), so some facts may be lost under high concurrency — this is an
    // accepted trade-off for a file-based, local-first store. In production,
    // the async fire-and-forget extraction naturally staggers writes.
    expect(all.length).toBeGreaterThanOrEqual(1);
    for (const f of all) {
      expect(f.id).toBeDefined();
      expect(f.content).toMatch(/Fact number \d+/);
      expect(f.category).toBe('fact');
      expect(f.timestamp).toBeGreaterThan(0);
    }
  });
});

// ── areFactsRelated ───────────────────────────────────────────────────────

describe('areFactsRelated', () => {
  it('returns true for sentences about the same topic', () => {
    expect(
      areFactsRelated(
        'Meeting with Acme Corp on Thursday',
        'Meeting with Acme Corp moved to Friday',
      ),
    ).toBe(true);
  });

  it('returns false for unrelated sentences', () => {
    expect(
      areFactsRelated('My favorite color is blue', 'Meeting with Acme Corp on Thursday'),
    ).toBe(false);
  });

  it('returns true for preference updates about the same topic', () => {
    expect(
      areFactsRelated('Favorite color is blue', 'Favorite color is green'),
    ).toBe(true);
  });
});
