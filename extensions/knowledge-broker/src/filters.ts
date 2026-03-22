import type { FilterResult } from './types.js';

// ── Pattern banks ─────────────────────────────────────────────────────────

const SCHEDULING = [
  /\b(meeting|appointment|event|deadline|schedule|calendar)\b/i,
  /\b(phone call|video call|zoom call|team call)\b/i,
  /\b(rescheduled?|moved? to|postponed?|cancelled?|confirmed?)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b(tomorrow|next week|next month|this (week|month|friday))\b/i,
  /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
  /\b(at \d|\d+ (o'?clock|hours?))\b/i,
];

const PREFERENCE = [
  /\b(favorite|favourite|prefer|preferred|like|love|hate|dislike|enjoy|can't stand)\b/i,
  /\bmy (favorite|preferred|go-to|usual|default)\b/i,
  /\bi (always|never|usually|typically|generally)\b/i,
];

const FACT = [
  /\b(my|our|the)\s+\w+\s+(is|are|was|were|will be)\b/i,
  /\b(works? (at|for|with)|lives? in|based in|from|moved to)\b/i,
  /\b(phone|email|address|number|username|handle)\b.{0,20}(is|:)/i,
  /\b(project|feature|bug|issue|ticket|task|sprint)\b.*(is|are|has|have|was|ready|done|blocked)/i,
  /\b(launched?|released?|shipped?|deployed?|promoted?)\b/i,
];

const TASK = [
  /\b(need to|have to|must|should|plan to)\s+\w+/i,
  // "going to + verb" but NOT "going to the/a/an <noun>" (which is a preference/fact)
  /\bgoing to\s+(?!the\b|a\b|an\b)\w+/i,
  /\b(todo|to-do|action item|follow[- ]?up)\b/i,
  /\b(remind|reminder|don'?t forget|please note|note that)\b/i,
  /\b(by (eod|end of day|friday|tomorrow|next week))\b/i,
];

// Messages that are pure noise regardless of content
const NOISE_EXACT = [
  /^(ok|okay|sure|yes|no|nope|yep|yeah|lol|haha|ha|nice|cool|great|awesome|perfect|thanks|thank you|ty|thx|bye|hi|hey|hello|sup|yo|k|np|ikr|omg|wtf|smh)[\s!.?]*$/i,
  /^[\W\s]+$/, // Only punctuation / whitespace
  /^.{1,4}$/, // Four chars or fewer
];

const EMOJI_ONLY = /^[\u{1F300}-\u{1FFFF}\s\u2000-\u3300]+$/u;

const MIN_WORD_COUNT = 4;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Screen a message for potential fact-bearing content.
 * Fast, zero-cost heuristic — no LLM required.
 */
export function screenMessage(content: string): FilterResult {
  const text = content.trim();

  if (!text || text.length < 5) return noise();
  if (EMOJI_ONLY.test(text)) return noise();
  if (NOISE_EXACT.some((p) => p.test(text))) return noise();

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORD_COUNT) return noise();

  // Check task/preference first — their markers are more specific.
  // Scheduling is checked after because day/time words appear in task messages too.
  if (TASK.some((p) => p.test(text)))
    return { isNoise: false, likelyCategory: 'task' };

  if (PREFERENCE.some((p) => p.test(text)))
    return { isNoise: false, likelyCategory: 'preference' };

  if (SCHEDULING.some((p) => p.test(text)))
    return { isNoise: false, likelyCategory: 'scheduling' };

  if (FACT.some((p) => p.test(text)))
    return { isNoise: false, likelyCategory: 'fact' };

  return { isNoise: true, likelyCategory: 'unknown' };
}

function noise(): FilterResult {
  return { isNoise: true, likelyCategory: 'noise' };
}
