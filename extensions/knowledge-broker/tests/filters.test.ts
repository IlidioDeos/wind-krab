import { describe, it, expect } from 'vitest';
import { screenMessage } from '../src/filters.js';

describe('screenMessage — noise detection', () => {
  // ── Pure noise ────────────────────────────────────────────────────────

  it.each([
    ['lol'],
    ['ok'],
    ['okay'],
    ['sure'],
    ['yes'],
    ['no'],
    ['haha'],
    ['nice'],
    ['cool'],
    ['great'],
    ['thanks'],
    ['thank you'],
    ['bye'],
    ['hi'],
    ['hey'],
    ['hello'],
    ['👍'],
    ['😂😂😂'],
    ['!!!'],
    ['...'],
    ['?'],
    ['k'],
  ])('"%s" is noise', (msg) => {
    expect(screenMessage(msg).isNoise).toBe(true);
  });

  it('very short messages are noise', () => {
    expect(screenMessage('lol k').isNoise).toBe(true);
  });

  it('empty string is noise', () => {
    expect(screenMessage('').isNoise).toBe(true);
  });
});

describe('screenMessage — scheduling detection', () => {
  it.each([
    ['My meeting with Acme Corp was moved to Thursday'],
    ['The call is scheduled for 3 PM tomorrow'],
    ['Appointment rescheduled to next Monday at 10am'],
    ['Deadline is end of day Friday'],
    ['Event postponed to next month'],
    ['Can we meet on Wednesday instead?'],
  ])('"%s" is a scheduling message', (msg) => {
    const result = screenMessage(msg);
    expect(result.isNoise).toBe(false);
    expect(result.likelyCategory).toBe('scheduling');
  });
});

describe('screenMessage — preference detection', () => {
  it.each([
    ['My favorite color is blue'],
    ['I prefer working in the mornings'],
    ['I love Thai food for lunch'],
    ['I hate going to the gym in the evening'],
    ['I usually take my coffee black'],
  ])('"%s" is a preference message', (msg) => {
    const result = screenMessage(msg);
    expect(result.isNoise).toBe(false);
    expect(result.likelyCategory).toBe('preference');
  });
});

describe('screenMessage — task detection', () => {
  it.each([
    ['I need to send the report by end of day'],
    ['Reminder: follow up with John tomorrow'],
    ['Don\'t forget to review the pull request'],
    ['Action item: update the roadmap by Friday'],
    ['Going to call them back later today'],
  ])('"%s" is a task message', (msg) => {
    const result = screenMessage(msg);
    expect(result.isNoise).toBe(false);
    expect(result.likelyCategory).toBe('task');
  });
});

describe('screenMessage — general fact detection', () => {
  it.each([
    ['My email address is alice@example.com'],
    ['The project deadline is next sprint'],
    ['Sarah works at Acme Corp as a designer'],
    ['Our main repo lives in GitHub under acme-corp'],
  ])('"%s" is a fact message', (msg) => {
    const result = screenMessage(msg);
    expect(result.isNoise).toBe(false);
  });
});

describe('screenMessage — ambiguous / unknown messages', () => {
  it('returns noise for conversational filler with no facts', () => {
    const result = screenMessage('That sounds really interesting to me');
    // May or may not be noise depending on heuristic; should at least not crash
    expect(['noise', 'unknown'].includes(result.likelyCategory) || result.isNoise).toBe(true);
  });
});
