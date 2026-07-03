import { describe, it, expect } from 'vitest';
import { expandKeywordQuery, normalizeRtsResult } from '../src/agent/rts.js';

describe('expandKeywordQuery', () => {
  it('expands attendance queries with OR', () => {
    const q = expandKeywordQuery('How did mentee attendance change?');
    expect(q).toMatch(/OR/);
    expect(q.toLowerCase()).toContain('attendance');
  });
});

describe('normalizeRtsResult', () => {
  it('maps the live assistant.search.context response shape', () => {
    const res = {
      results: {
        messages: [{
          content: '42 of 47 mentees improved attendance',
          author_name: 'Priya Nair',
          is_author_bot: true,
          channel_id: 'C1',
          channel_name: 'program-updates',
          permalink: 'https://x.slack.com/archives/C1/p1',
          message_ts: '1700000000.000100',
        }],
        files: [],
      },
    };
    const out = normalizeRtsResult(res);
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toContain('42 of 47');
    expect(out[0].author).toBe('Priya Nair');
    expect(out[0].permalink).toContain('archives');
  });

  it('drops entries with no content', () => {
    const res = { results: { messages: [{ content: '' }], files: [] } };
    expect(normalizeRtsResult(res)).toHaveLength(0);
  });
});
