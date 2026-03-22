import { describe, it, expect } from 'vitest';
import { extractFactsHeuristic } from '../src/extractor.js';
import { screenMessage } from '../src/filters.js';

describe('extractFactsHeuristic', () => {
  it('extracts a scheduling fact from a scheduling message', () => {
    const msg = 'My meeting with Acme Corp was moved to Thursday at 3 PM';
    const filter = screenMessage(msg);
    const result = extractFactsHeuristic(msg, filter);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].category).toBe('scheduling');
    expect(result.facts[0].confidence).toBeGreaterThan(0.5);
    expect(result.facts[0].content).toContain('Acme');
  });

  it('extracts a preference fact from a preference message', () => {
    const msg = 'I prefer working in the mornings, before 10 AM';
    const filter = screenMessage(msg);
    const result = extractFactsHeuristic(msg, filter);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].category).toBe('preference');
  });

  it('returns empty facts for a noise message', () => {
    const msg = 'lol ok';
    const filter = screenMessage(msg);
    const result = extractFactsHeuristic(msg, filter);

    expect(result.facts).toHaveLength(0);
  });

  it('returns empty facts when filter says noise', () => {
    const filter = { isNoise: true, likelyCategory: 'noise' as const };
    const result = extractFactsHeuristic('some text', filter);
    expect(result.facts).toHaveLength(0);
  });

  it('extracts the most informative sentence from a multi-sentence message', () => {
    const msg =
      'Sure, sounds good! My meeting with Acme Corp has been rescheduled. ' +
      'The new time is Thursday at 3 PM instead of Wednesday.';
    const filter = screenMessage(msg);
    const result = extractFactsHeuristic(msg, filter);

    expect(result.facts).toHaveLength(1);
    // Should pick the longest substantive sentence
    expect(result.facts[0].content.length).toBeGreaterThan(10);
  });

  it('confidence is between 0.5 and 1.0', () => {
    const msg = 'My favorite color is blue and I love pizza';
    const filter = screenMessage(msg);
    const result = extractFactsHeuristic(msg, filter);

    for (const fact of result.facts) {
      expect(fact.confidence).toBeGreaterThanOrEqual(0.5);
      expect(fact.confidence).toBeLessThanOrEqual(1.0);
    }
  });
});
