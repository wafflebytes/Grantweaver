import { describe, it, expect } from 'vitest';
import { sanitizeCanvasMarkdown } from '../src/services/canvas.js';

describe('sanitizeCanvasMarkdown', () => {
  it('collapses heading levels deeper than 3 to h3', () => {
    const out = sanitizeCanvasMarkdown('#### Too deep\n##### Even deeper\n### Fine');
    expect(out).toContain('### Too deep');
    expect(out).toContain('### Even deeper');
    expect(out).toContain('### Fine');
    expect(out).not.toMatch(/^#{4,}/m);
  });

  it('preserves ordinary spacing and links', () => {
    const md = '# Title\n\nSome text with a [source](https://x.slack.com/archives/C1/p1) link.';
    const out = sanitizeCanvasMarkdown(md);
    expect(out).toContain('Some text with a [source](https://x.slack.com/archives/C1/p1) link.');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeCanvasMarkdown('\n\n  # Title  \n\n')).toBe('# Title');
  });
});
