import { describe, it, expect, vi } from 'vitest';

const OPPS = [
  { opp_id: '1', title: 'Rejected Grant', close_date: '2026-08-01', status: 'posted' },
  { opp_id: '2', title: 'Fresh Grant', close_date: '2026-09-01', status: 'posted' },
];

vi.mock('../src/agent/rts.js', () => ({ searchWorkspace: vi.fn(), detectSearchMode: vi.fn(), expandKeywordQuery: vi.fn((q) => q) }));
vi.mock('../src/mcp/grantsgov-client.js', () => ({
  grantsGov: { search: vi.fn(async () => OPPS), fetchOpportunity: vi.fn(async () => null) },
}));
vi.mock('../src/services/lists.js', () => ({ syncOpportunityToList: vi.fn(async () => {}) }));
vi.mock('../src/services/canvas.js', () => ({ ensureOppCanvas: vi.fn(async () => ({})), refreshOverviewAndRequirements: vi.fn(async () => {}) }));
vi.mock('../src/agent/intents.js', () => ({ stashDraftMarkdown: vi.fn() }));
vi.mock('../src/prompts/classifiers.js', () => ({ assessFitBatch: vi.fn(async () => []), extractChecklist: vi.fn(async () => []) }));
vi.mock('../src/services/db.js', () => ({
  db: {
    getOrg: vi.fn(async () => ({ team_id: 'T1', mission: 'Youth mentorship', focus_areas: ['youth'] })),
    listNotRelevant: vi.fn(async () => [{ subject: '1', detail: 'Wrong focus area' }]),
  },
}));

const { buildToolbelt } = await import('../src/agent/tools.js');

describe('search_grants not_relevant filtering', () => {
  it('drops opps the org has previously marked not relevant, before rendering or counting', async () => {
    const posted = [];
    const client = { chat: { postMessage: vi.fn(async (p) => { posted.push(p); return { ts: '1.1' }; }) } };
    const toolbelt = buildToolbelt({ client, teamId: 'T1', channelId: 'C1', threadTs: '1.0', userId: 'U1' });
    const out = await toolbelt.search_grants({ keyword: 'youth' });
    expect(out.opportunities.map((o) => o.opp_id)).not.toContain('1');
    expect(out.opportunities.map((o) => o.opp_id)).toContain('2');
    expect(posted.some((p) => p.text === 'Rejected Grant')).toBe(false);
  });
});
