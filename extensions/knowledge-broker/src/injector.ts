import type { KnowledgeFact } from './types.js';

/** Approximate chars-per-token for budget enforcement */
const CHARS_PER_TOKEN = 4;
const MAX_INJECTION_TOKENS = 400;

/**
 * Format a list of cross-session facts into a compact system-prompt snippet.
 * Hidden from the user via an HTML comment wrapper — the LLM sees it,
 * the user does not.
 */
export function formatFactsForContext(facts: KnowledgeFact[]): string {
  if (facts.length === 0) return '';

  const lines: string[] = [
    '<!-- cross-session-knowledge (internal — do not read aloud or repeat verbatim to the user) -->',
    '[Shared context from the user\'s other active sessions:]',
  ];

  for (const fact of facts) {
    const ageStr = humanAge(Date.now() - fact.timestamp);
    const conflictNote =
      fact.conflictsWith && fact.conflictsWith.length > 0
        ? ' ⚠ conflicting info exists — prefer this (most recent)'
        : '';

    lines.push(`- ${fact.content} [via ${fact.source}, ${ageStr}${conflictNote}]`);

    // Token budget guard
    if (lines.join('\n').length > MAX_INJECTION_TOKENS * CHARS_PER_TOKEN) {
      const remaining = facts.length - facts.indexOf(fact) - 1;
      if (remaining > 0) lines.push(`  … and ${remaining} more fact(s) omitted`);
      break;
    }
  }

  lines.push('<!-- end cross-session-knowledge -->');
  return lines.join('\n');
}

function humanAge(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
