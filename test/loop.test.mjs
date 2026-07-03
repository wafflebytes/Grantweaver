import { describe, it, expect } from 'vitest';
import { chunkMarkdown, inferTitle } from '../src/agent/loop.js';

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
