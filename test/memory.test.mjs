import { describe, it, expect } from 'vitest';
import { fetchRecentHistory, fetchThreadHistory } from '../src/agent/memory.js';

describe('fetchRecentHistory', () => {
  const fakeClient = (messages) => ({ conversations: { history: async () => ({ messages }) } });

  it('drops the current message, orders oldest-first, and roles by botUserId', async () => {
    const client = fakeClient([
      { ts: '3', user: 'U1', text: 'draft it now' }, // the just-arrived message
      { ts: '2', user: 'UBOT', text: 'Found 3 matches.' },
      { ts: '1', user: 'U1', text: 'find grants' },
    ]);
    const history = await fetchRecentHistory(client, 'D1', 'UBOT', '3');
    expect(history).toEqual([
      { role: 'user', content: 'find grants' },
      { role: 'assistant', content: 'Found 3 matches.' },
    ]);
  });

  it('filters out subtype/no-text messages', async () => {
    const client = fakeClient([
      { ts: '2', user: 'U1', text: 'draft it now' },
      { ts: '1', subtype: 'channel_join', text: '' },
    ]);
    const history = await fetchRecentHistory(client, 'D1', 'UBOT', '2');
    expect(history).toEqual([]);
  });
});

describe('fetchThreadHistory', () => {
  const fakeClient = (messages) => ({ conversations: { replies: async () => ({ messages }) } });

  it('keeps oldest-first order and prefixes non-bot speakers with their user id', async () => {
    const client = fakeClient([
      { ts: '1', user: 'U1', text: 'find funding for youth mentoring' },
      { ts: '2', user: 'UBOT', text: 'Here are 3 matches.' },
      { ts: '3', user: 'U2', text: 'can you draft the OJJDP one?' },
    ]);
    const history = await fetchThreadHistory(client, 'C1', '1', 'UBOT', '4');
    expect(history).toEqual([
      { role: 'user', content: '<@U1>: find funding for youth mentoring' },
      { role: 'assistant', content: 'Here are 3 matches.' },
      { role: 'user', content: '<@U2>: can you draft the OJJDP one?' },
    ]);
  });

  it('drops the current message and subtype/no-text messages', async () => {
    const client = fakeClient([
      { ts: '1', user: 'U1', text: 'hey @grantweaver' },
      { ts: '2', subtype: 'channel_join', text: '' },
      { ts: '3', user: 'U1', text: 'the one just arrived' },
    ]);
    const history = await fetchThreadHistory(client, 'C1', '1', 'UBOT', '3');
    expect(history).toEqual([{ role: 'user', content: '<@U1>: hey @grantweaver' }]);
  });

  it('caps at the requested count, keeping the most recent', async () => {
    const client = fakeClient(
      Array.from({ length: 5 }, (_, i) => ({ ts: String(i), user: 'U1', text: `msg ${i}` }))
    );
    const history = await fetchThreadHistory(client, 'C1', '0', 'UBOT', '999', 3);
    expect(history.map((h) => h.content)).toEqual(['<@U1>: msg 2', '<@U1>: msg 3', '<@U1>: msg 4']);
  });
});
