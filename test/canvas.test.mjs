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

  it('strips a leading H1 unconditionally — Slack renders the canvas title as its own H1', () => {
    const md = '# Letter of Intent: OJJDP\n\nDear Program Officer,...';
    const out = sanitizeCanvasMarkdown(md);
    expect(out).not.toMatch(/^#\s+Letter of Intent/);
    expect(out.startsWith('Dear Program Officer')).toBe(true);
  });

  it('strips a leading H1 even when its wording differs from the title (live-observed case)', () => {
    const md = '# Letter of Intent — Riverside Foundation LOI — Youth Mentorship\n\n**Funder:** Riverside Foundation...';
    const out = sanitizeCanvasMarkdown(md);
    expect(out.startsWith('**Funder:**')).toBe(true);
  });
});
