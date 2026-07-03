import { describe, it, expect, vi } from 'vitest';

const opp = { opp_id: '1', title: 'Youth Mentoring Grant', agency: 'HHS', close_date: '2026-12-01', award_ceiling: 50000, checklist: [{ id: 'a', label: 'Narrative', done: true }, { id: 'b', label: 'Budget', done: false }], canvas_id: null };
const pointer = { channel_id: 'C1', message_ts: '1.1', opp_id: '1', permalink: 'https://x/archives/C1/p1', tag: 'story' };

vi.mock('../src/services/db.js', () => ({
  db: {
    getOrg: vi.fn(async () => ({ org_name: 'Riverbend', mission: 'youth mentoring' })),
    listOpportunities: vi.fn(async () => [opp]),
    listEvidence: vi.fn(async () => [pointer]),
  },
}));
vi.mock('../src/mcp/grantsgov-client.js', () => ({
  grantsGov: { fetchOpportunity: vi.fn(async () => ({ title: opp.title, agency: opp.agency, close_date: opp.close_date, award_ceiling: opp.award_ceiling, eligibility: 'nonprofits', synopsis: 'A grant.' })) },
}));
vi.mock('../src/agent/llm.js', () => ({ completeOnce: vi.fn(async () => '### Narrative\nAnswer text.') }));

const { buildMdPack, buildAnswers } = await import('../src/services/exportpack.js');

function fakeClient(text) {
  return { conversations: { history: vi.fn(async () => ({ messages: [{ text: text ?? '42 of 47 mentees improved attendance', user: 'U1' }] })) } };
}

describe('buildMdPack', () => {
  it('assembles all five sections and re-reads evidence live via ts', async () => {
    const { title, content, filename } = await buildMdPack(fakeClient(), 'T1', '1');
    expect(title).toBe('Youth Mentoring Grant');
    expect(filename).toMatch(/\.md$/);
    expect(content).toContain('## The opportunity');
    expect(content).toContain('## Requirements');
    expect(content).toContain('- [x] Narrative');
    expect(content).toContain('- [ ] Budget');
    expect(content).toContain('## Evidence');
    expect(content).toContain('42 of 47 mentees improved attendance');
    expect(content).toContain('## How to use this pack');
  });

  it('never fabricates evidence when the pointer cannot be re-read', async () => {
    const client = { conversations: { history: vi.fn(async () => ({ messages: [] })) } };
    const { content } = await buildMdPack(client, 'T1', '1');
    expect(content).toContain('No saved evidence pointers');
  });
});

describe('buildAnswers', () => {
  it('produces markdown from a single completion call', async () => {
    const { title, content, filename } = await buildAnswers(fakeClient(), 'T1', '1');
    expect(title).toBe('Youth Mentoring Grant');
    expect(filename).toMatch(/-answers\.md$/);
    expect(content).toContain('Narrative');
  });
});
