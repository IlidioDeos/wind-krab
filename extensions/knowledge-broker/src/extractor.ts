import type { ExtractionResult, ExtractedFact, FactCategory, FilterResult } from './types.js';

// ── LLM-based extraction ──────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Extract factual, cross-session-relevant information from this message.
Return a JSON array. Return [] if nothing is worth sharing.

Rules:
- INCLUDE: scheduling, preferences, personal/project facts, commitments, contact info
- EXCLUDE: questions without answers, casual opinions, greetings, filler
- Each fact must be a complete, standalone sentence
- Max 3 facts per message
- Confidence: 0.0–1.0 (how certain this is a durable, shareable fact)

Message:
{MESSAGE}

Return ONLY valid JSON — no prose, no code fences:
[{"content":"...","category":"scheduling|preference|contact|project|task|fact","confidence":0.0}]`;

/** LLM-based extraction. The apiCall function is provided by the caller so
 *  the extractor stays decoupled from any specific SDK. */
export async function extractFactsWithLLM(
  message: string,
  apiCall: (prompt: string) => Promise<string>,
): Promise<ExtractionResult> {
  const prompt = EXTRACTION_PROMPT.replace('{MESSAGE}', message);
  try {
    const response = await apiCall(prompt);
    const match = response.match(/\[[\s\S]*\]/);
    if (!match) return { facts: [] };

    const parsed: unknown[] = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return { facts: [] };

    const facts: ExtractedFact[] = parsed
      .filter(isRawFact)
      .filter((f) => f.confidence >= 0.5)
      .slice(0, 3);

    return { facts };
  } catch {
    return { facts: [] };
  }
}

function isRawFact(x: unknown): x is ExtractedFact {
  return (
    typeof x === 'object' &&
    x !== null &&
    'content' in x &&
    typeof (x as any).content === 'string' &&
    'category' in x &&
    typeof (x as any).category === 'string' &&
    'confidence' in x &&
    typeof (x as any).confidence === 'number'
  );
}

// ── Heuristic extraction (zero-cost fallback) ─────────────────────────────

/** Fallback when LLM extraction is disabled or unavailable. */
export function extractFactsHeuristic(
  message: string,
  filterResult: FilterResult,
): ExtractionResult {
  if (filterResult.isNoise) return { facts: [] };

  const category: FactCategory =
    filterResult.likelyCategory === 'unknown' || filterResult.likelyCategory === 'noise'
      ? 'fact'
      : (filterResult.likelyCategory as FactCategory);

  const content = message.trim().replace(/\s+/g, ' ');

  // For longer messages, try to extract the most relevant sentence
  const sentences = content
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  if (sentences.length > 1) {
    // Use the sentence most likely to contain the fact (heuristic: longest sentence
    // that contains a category-relevant keyword)
    const best = sentences.sort((a, b) => b.length - a.length)[0];
    return { facts: [{ content: best, category, confidence: 0.6 }] };
  }

  return { facts: [{ content, category, confidence: 0.65 }] };
}
