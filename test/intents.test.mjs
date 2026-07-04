import { describe, it, expect, vi } from 'vitest';

// A tiny in-memory intents store that mimics the atomic
// `UPDATE ... WHERE status='pending' RETURNING *` guarantee: claimIntent only
// ever succeeds once per intent, no matter how many callers race it.
const store = new Map();
let nextId = 1;

vi.mock('../src/services/db.js', () => ({
  db: {
    createIntent: vi.fn(async (teamId, { kind, params, requested_by, channel_id }) => {
      const row = { id: nextId++, team_id: teamId, kind, params, requested_by, channel_id, message_ts: null, status: 'pending' };
      store.set(row.id, row);
      return row;
    }),
    setIntentMessage: vi.fn(async (id, ts) => { store.get(id).message_ts = ts; }),
    getIntentByMessage: vi.fn(async (channel, ts) => [...store.values()].find((r) => r.channel_id === channel && r.message_ts === ts) ?? null),
    claimIntent: vi.fn(async (id) => {
      const row = store.get(id);
      if (!row || row.status !== 'pending') return null;
      row.status = 'running';
      return { ...row };
    }),
    finishIntent: vi.fn(async (id, status) => { if (store.has(id)) store.get(id).status = status; }),
    listOpportunities: vi.fn(async () => []),
    logActivity: vi.fn(async () => {}),
  },
}));

vi.mock('../src/services/canvas.js', () => ({
  ensureOppCanvas: vi.fn(async () => ({ canvasId: 'F1', canvasUrl: 'https://x.slack.com/docs/T1/F1' })),
  rewriteCanvas: vi.fn(async () => true),
}));
vi.mock('../src/services/lists.js', () => ({ syncOpportunityToList: vi.fn(async () => {}) }));

const { runIntent, markCardRunning, markCardCancelled, stashDraftMarkdown } = await import('../src/agent/intents.js');
const { db } = await import('../src/services/db.js');

function fakeClient() {
  return {
    chat: { postMessage: vi.fn(async () => ({ ts: '9.9' })), update: vi.fn(async () => ({})) },
  };
}

describe('pending_intents claim atomicity', () => {
  it('a double-click only lets one caller win', async () => {
    const intent = await db.createIntent('T1', { kind: 'draft', params: { opp_id: null }, requested_by: 'U1', channel_id: 'C1' });
    const [a, b] = await Promise.all([db.claimIntent(intent.id), db.claimIntent(intent.id)]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it('claimIntent on an already-running/expired intent returns null', async () => {
    const intent = await db.createIntent('T1', { kind: 'draft', params: {}, requested_by: 'U1', channel_id: 'C1' });
    await db.claimIntent(intent.id);
    const second = await db.claimIntent(intent.id);
    expect(second).toBeNull();
  });
});

describe('runIntent', () => {
  it('runs the draft executor from the in-process stash (tool-call path) without persisting markdown', async () => {
    const client = fakeClient();
    const intent = await db.createIntent('T1', { kind: 'draft', params: { opp_id: null }, requested_by: 'U1', channel_id: 'C1' });
    stashDraftMarkdown(intent.id, { title: 'LOI — Test', markdown: '# body [source](https://x/archives/y)' });
    intent.message_ts = '5.5';
    await runIntent(client, intent);
    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(db.finishIntent).toHaveBeenCalledWith(intent.id, 'done');
    // Class-A guard: the intent row itself never carries the drafted markdown.
    expect(JSON.stringify(intent.params)).not.toContain('body');
  });

  it('apologizes and marks cancelled for an unregistered kind', async () => {
    const client = fakeClient();
    const intent = await db.createIntent('T1', { kind: 'revise', params: {}, requested_by: 'U1', channel_id: 'C1' });
    intent.message_ts = '5.6';
    await runIntent(client, intent);
    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(db.finishIntent).toHaveBeenCalledWith(intent.id, 'cancelled');
  });
});

describe('card state transitions', () => {
  it('markCardRunning and markCardCancelled update the confirm card in place', async () => {
    const client = fakeClient();
    const intent = { channel_id: 'C1', message_ts: '5.5' };
    await markCardRunning(client, intent);
    await markCardCancelled(client, intent);
    expect(client.chat.update).toHaveBeenCalledTimes(2);
  });
});
