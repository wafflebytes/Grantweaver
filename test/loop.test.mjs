import { describe, it, expect } from 'vitest';
import { chunkMarkdown, inferTitle, looksEvidenceShaped } from '../src/agent/loop.js';

describe('chunkMarkdown', () => {
  it('chunks without dropping lines', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    expect(chunkMarkdown(text, 100).join('')).toContain('line 49');
  });
});

describe('inferTitle', () => {
  it('caps titles at 48 chars', () => {
    expect(inferTitle('x'.repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe('looksEvidenceShaped', () => {
  it('flags evidence and drafting questions', () => {
    expect(looksEvidenceShaped('What impact evidence do we have from the last 90 days?')).toBe(true);
    expect(looksEvidenceShaped('Show me citations for our tutoring outcomes.')).toBe(true);
    expect(looksEvidenceShaped('How did mentee attendance change this spring?')).toBe(true);
  });
  it('does not flag unrelated questions', () => {
    expect(looksEvidenceShaped("What's due in the next 30 days?")).toBe(false);
    expect(looksEvidenceShaped('Find new grants for youth mentoring.')).toBe(false);
  });
});
