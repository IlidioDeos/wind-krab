/**
 * knowledge-broker — Cross-Session Knowledge Broker for OpenClaw
 *
 * Compiled as CommonJS so OpenClaw can require() it directly.
 * We do NOT import from 'openclaw/plugin-sdk/*' — that package is only
 * available inside the OpenClaw monorepo. Instead we define the one function
 * we need (definePluginEntry) locally; at runtime OpenClaw replaces the
 * module with its own loader anyway.
 *
 * Tool parameters use plain JSON Schema instead of TypeBox so there are
 * zero runtime dependencies on packages outside Node.js built-ins.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

import { SharedKnowledgeStore } from './store.js';
import { screenMessage } from './filters.js';
import { extractFactsWithLLM, extractFactsHeuristic } from './extractor.js';
import { formatFactsForContext } from './injector.js';
import type { FactCategory, PluginConfig } from './types.js';

// ── Minimal local stub — identical to OpenClaw's runtime implementation ──────
// OpenClaw expects the default export to be the result of definePluginEntry().
// The function is a simple identity/pass-through; we define it here so we
// don't need to import from 'openclaw/plugin-sdk/plugin-entry'.
function definePluginEntry(entry: {
  id: string;
  name: string;
  description?: string;
  register(api: any): void;
}) {
  return entry;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_WEEK = 7 * ONE_DAY;
const ONE_MONTH = 30 * ONE_DAY;

export const DEFAULT_CONFIG: PluginConfig = {
  storePath: join(homedir(), '.openclaw', 'shared-knowledge.json'),
  maxFacts: 200,
  ttl: {
    scheduling: ONE_DAY,
    preference: ONE_WEEK,
    contact: ONE_MONTH,
    project: ONE_WEEK,
    task: ONE_DAY,
    fact: ONE_DAY,
  },
  conflictWindowMs: 5 * 60 * 1000,
  extractionEnabled: false,
  injectionMaxFacts: 10,
  injectionMaxAge: ONE_DAY,
};

// ── Plain JSON Schema helpers (no TypeBox dependency) ────────────────────────

const FACT_CATEGORY_ENUM = ['scheduling', 'preference', 'contact', 'project', 'task', 'fact'];

const FACT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string', description: 'The fact as a complete, standalone sentence.' },
    category: { type: 'string', enum: FACT_CATEGORY_ENUM, description: 'Category of the fact.' },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence (0–1) that this is a durable, shareable fact.' },
  },
  required: ['content', 'category', 'confidence'],
};

// ── Plugin ────────────────────────────────────────────────────────────────────

module.exports = definePluginEntry({
  id: 'knowledge-broker',
  name: 'Cross-Session Knowledge Broker',
  description: 'Shares relevant facts between sessions across all channels in near real-time.',

  register(api: any) {
    const userConfig = (api.getConfig?.() ?? {}) as Partial<PluginConfig>;
    const config: PluginConfig = {
      ...DEFAULT_CONFIG,
      ...userConfig,
      ttl: { ...DEFAULT_CONFIG.ttl, ...(userConfig.ttl ?? {}) },
    };

    const store = new SharedKnowledgeStore(config.storePath, config);

    function channelFromKey(key: string): string {
      return key.split(':')[2] ?? 'unknown';
    }

    // ── Hook: inject shared knowledge before each session turn ──────────────
    api.on('agent:bootstrap', async (ctx: any) => {
      try {
        const sessionKey: string = ctx?.session?.key ?? ctx?.sessionKey ?? '';
        const facts = await store.getRecentFacts({
          excludeSessionKey: sessionKey,
          maxAge: config.injectionMaxAge,
          limit: config.injectionMaxFacts,
        });
        if (facts.length === 0) return;
        const snippet = formatFactsForContext(facts);
        if (typeof ctx?.context?.prepend === 'function') ctx.context.prepend(snippet);
        else if (typeof ctx?.prepend === 'function') ctx.prepend(snippet);
        else if (Array.isArray(ctx?.bootstrapLines)) ctx.bootstrapLines.unshift(snippet);
      } catch (err) {
        console.error('[knowledge-broker] bootstrap injection failed:', err);
      }
    });

    // ── Hook: extract facts from incoming user messages ─────────────────────
    api.on('message:received', (ctx: any) => {
      const content: string = ctx?.message?.content ?? ctx?.content ?? '';
      const sessionKey: string = ctx?.session?.key ?? ctx?.sessionKey ?? '';
      const channel = channelFromKey(sessionKey);

      void (async () => {
        try {
          const filterResult = screenMessage(content);
          if (filterResult.isNoise) return;

          let result;
          if (config.extractionEnabled && api.runtime?.llm?.complete) {
            const llm = api.runtime.llm;
            result = await extractFactsWithLLM(content, (p: string) =>
              llm.complete(p, { model: 'fast' }),
            );
          } else {
            result = extractFactsHeuristic(content, filterResult);
          }

          if (result.facts.length > 0) {
            await store.publishFacts(result.facts, sessionKey, channel);
          }
        } catch (err) {
          console.error('[knowledge-broker] extraction failed:', err);
        }
      })();
    });

    // ── Tool: kb_publish ────────────────────────────────────────────────────
    api.registerTool((ctx: any) => ({
      name: 'kb_publish',
      description:
        'Publish important facts to the shared cross-session knowledge base. ' +
        'Call this when the user mentions scheduling info, preferences, project updates, ' +
        'contact details, or any durable fact that should be available in other channels.',
      parameters: {
        type: 'object',
        properties: {
          facts: {
            type: 'array',
            description: 'Facts to publish.',
            items: FACT_ITEM_SCHEMA,
          },
        },
        required: ['facts'],
      },
      async execute(_id: string, params: any) {
        const sessionKey: string = ctx?.sessionKey ?? '';
        const channel = channelFromKey(sessionKey);
        await store.publishFacts(
          params.facts as Array<{ content: string; category: FactCategory; confidence: number }>,
          sessionKey,
          channel,
        );
        return {
          content: [{ type: 'text', text: `Published ${params.facts.length} fact(s) to shared knowledge base.` }],
        };
      },
    }));

    // ── Tool: kb_subscribe ──────────────────────────────────────────────────
    api.registerTool((ctx: any) => ({
      name: 'kb_subscribe',
      description:
        'Retrieve recent facts from the shared cross-session knowledge base. ' +
        'Call this at the start of a session to catch up on what happened in other channels.',
      parameters: {
        type: 'object',
        properties: {
          maxAgeHours: { type: 'number', description: 'Only return facts newer than this many hours (default 24).' },
          categories: {
            type: 'array',
            description: 'Filter by category.',
            items: { type: 'string', enum: FACT_CATEGORY_ENUM },
          },
        },
      },
      async execute(_id: string, params: any) {
        const sessionKey: string = ctx?.sessionKey ?? '';
        const maxAge = params.maxAgeHours ? params.maxAgeHours * ONE_HOUR : config.injectionMaxAge;
        const facts = await store.getRecentFacts({
          excludeSessionKey: sessionKey,
          maxAge,
          categories: params.categories as FactCategory[] | undefined,
          limit: config.injectionMaxFacts,
        });
        if (facts.length === 0) {
          return { content: [{ type: 'text', text: 'No recent shared knowledge available.' }] };
        }
        const lines = facts.map((f) => {
          const age = humanAge(Date.now() - f.timestamp);
          const conflict = f.conflictsWith?.length ? ' [CONFLICT: earlier info may differ]' : '';
          return `- [${f.category}] ${f.content} (from ${f.source}, ${age})${conflict}`;
        });
        return { content: [{ type: 'text', text: `Shared knowledge from other sessions:\n${lines.join('\n')}` }] };
      },
    }));

    // ── Tool: kb_clear ──────────────────────────────────────────────────────
    api.registerTool(() => ({
      name: 'kb_clear',
      description: 'Clear all shared knowledge (admin / testing only).',
      parameters: { type: 'object', properties: {} },
      async execute() {
        await store.clearAll();
        return { content: [{ type: 'text', text: 'Shared knowledge store cleared.' }] };
      },
    }));
  },
});

function humanAge(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
