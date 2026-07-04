import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/mcp/grantsgov-client.js', () => ({
  grantsGov: {
    search: vi.fn(async () => ([
      { opp_id: '1', title: 'Old match', status: 'posted' },
      { opp_id: '2', title: 'New match', status: 'posted' },
    ])),
    fetchOpportunity: vi.fn(async () => null),
  },
}));

vi.mock('../src/prompts/classifiers.js', () => ({
  assessFitBatch: vi.fn(async () => []),
}));

const posted = [];
vi.mock('../src/services/db.js', () => ({
  db: {
    allOrgs: vi.fn(async () => [{ team_id: 'T1', post_channels: ['C1'] }]),
    getOrg: vi.fn(async () => ({ team_id: 'T1', post_channels: ['C1'] })),
    listWatches: vi.fn(async () => [{ id: 5, kind: 'query', params: { keyword: 'youth' }, last_seen_ids: ['1'] }]),
    countSignalsSince: vi.fn(async () => 0),
    addSignal: vi.fn(async () => {}),
    updateWatchSeen: vi.fn(async (id, patch) => { posted.push(patch); }),
  },
}));

const { runWatchSweep } = await import('../src/services/watches.js');

describe('runWatchSweep', () => {
  it('only posts opps not already in last_seen_ids, and merges seen ids', async () => {
    const client = { chat: { postMessage: vi.fn(async () => ({ ok: true })) } };
    await runWatchSweep(client, 'T1');
    const titles = client.chat.postMessage.mock.calls.map((c) => c[0].text);
    expect(titles.some((t) => t.includes('New match'))).toBe(true);
    expect(titles.some((t) => t.includes('Old match'))).toBe(false);
    expect(posted[0].last_seen_ids).toEqual(expect.arrayContaining(['1', '2']));
  });
});
