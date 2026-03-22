import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  KnowledgeFact,
  KnowledgeStore,
  ExtractedFact,
  PluginConfig,
} from './types.js';

const DEFAULT_STORE: KnowledgeStore = {
  version: 1,
  lastUpdated: 0,
  facts: [],
};

export class SharedKnowledgeStore {
  private readonly storePath: string;
  private readonly lockPath: string;
  private readonly config: PluginConfig;

  // In-memory read cache to avoid hammering the filesystem on every turn
  private cache: KnowledgeStore | null = null;
  private cacheAt = 0;
  private readonly CACHE_TTL_MS = 300; // 300 ms cache

  constructor(storePath: string, config: PluginConfig) {
    this.storePath = storePath;
    this.lockPath = storePath + '.lock';
    this.config = config;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async publishFacts(
    rawFacts: ExtractedFact[],
    sessionKey: string,
    channel: string,
  ): Promise<void> {
    if (rawFacts.length === 0) return;
    await this._write((store) => {
      const now = Date.now();
      for (const rawFact of rawFacts) {
        const ttl =
          this.config.ttl[rawFact.category] ??
          this.config.ttl['fact'] ??
          86_400_000;

        // Find existing facts that might conflict (same category + overlapping entities)
        const conflicting = store.facts.filter(
          (f) =>
            f.sessionKey !== sessionKey &&
            f.category === rawFact.category &&
            areFactsRelated(f.content, rawFact.content),
        );

        let supersedes: string | undefined;
        const conflictIds: string[] = [];

        for (const conflict of conflicting) {
          const ageMs = now - conflict.timestamp;
          if (ageMs >= this.config.conflictWindowMs) {
            // Old enough → this fact supersedes the previous one
            supersedes = conflict.id;
            store.facts.splice(store.facts.indexOf(conflict), 1);
          } else {
            // Recent contradiction → mark both as conflicted
            conflictIds.push(conflict.id);
            conflict.conflictsWith ??= [];
            if (!conflict.conflictsWith.includes(rawFact.content)) {
              conflict.conflictsWith.push(rawFact.content);
            }
          }
        }

        const newFact: KnowledgeFact = {
          id: randomUUID(),
          content: rawFact.content,
          category: rawFact.category,
          source: channel,
          sessionKey,
          timestamp: now,
          ttl,
          confidence: rawFact.confidence,
          ...(supersedes ? { supersedes } : {}),
          ...(conflictIds.length > 0 ? { conflictsWith: conflictIds } : {}),
        };

        store.facts.push(newFact);
      }
    });
  }

  async getRecentFacts(opts: {
    excludeSessionKey?: string;
    maxAge?: number;
    limit?: number;
    categories?: KnowledgeFact['category'][];
  } = {}): Promise<KnowledgeFact[]> {
    const store = await this._read();
    const now = Date.now();
    const maxAge = opts.maxAge ?? this.config.injectionMaxAge;
    const limit = opts.limit ?? this.config.injectionMaxFacts;

    const facts = store.facts
      .filter((f) => {
        if (now - f.timestamp > f.ttl) return false;
        if (now - f.timestamp > maxAge) return false;
        if (opts.excludeSessionKey && f.sessionKey === opts.excludeSessionKey)
          return false;
        if (opts.categories && !opts.categories.includes(f.category))
          return false;
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    return facts;
  }

  async clearAll(): Promise<void> {
    await this._write((store) => {
      store.facts = [];
    });
  }

  async getAllFacts(): Promise<KnowledgeFact[]> {
    const store = await this._read();
    return store.facts;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async _read(): Promise<KnowledgeStore> {
    if (this.cache && Date.now() - this.cacheAt < this.CACHE_TTL_MS) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw) as KnowledgeStore;
      this.cache = parsed;
      this.cacheAt = Date.now();
      return parsed;
    } catch (err: any) {
      if (err.code === 'ENOENT') return { ...DEFAULT_STORE, facts: [] };
      throw err;
    }
  }

  private async _write(
    mutate: (store: KnowledgeStore) => void,
  ): Promise<void> {
    // Invalidate cache so next read is fresh
    this.cache = null;

    const store = await this._read();
    mutate(store);
    store.lastUpdated = Date.now();

    // Prune expired facts
    const now = Date.now();
    store.facts = store.facts.filter((f) => now - f.timestamp < f.ttl);

    // Cap total facts (keep most recent)
    if (store.facts.length > this.config.maxFacts) {
      store.facts.sort((a, b) => b.timestamp - a.timestamp);
      store.facts = store.facts.slice(0, this.config.maxFacts);
    }

    // Atomic write: write to tmp then rename (safe across OS restarts mid-write).
    // Use randomUUID() so concurrent writes never collide on the tmp filename.
    const tmpPath = `${this.storePath}.tmp.${randomUUID()}`;
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.storePath);
  }
}

// ── Heuristic: do two fact strings discuss the same topic? ─────────────────

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'been', 'will', 'about',
  'they', 'their', 'there', 'then', 'when', 'what', 'which', 'into',
  'your', 'more', 'also', 'some', 'just',
]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
  );
}

export function areFactsRelated(a: string, b: string): boolean {
  const aKeys = keywords(a);
  const bKeys = keywords(b);
  let shared = 0;
  for (const w of bKeys) {
    if (aKeys.has(w)) shared++;
  }
  // Two shared significant keywords → likely the same topic
  return shared >= 2;
}
