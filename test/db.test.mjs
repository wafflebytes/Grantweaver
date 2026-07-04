import { describe, it, expect, vi } from 'vitest';

let rows = [];
vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      query: vi.fn(async (sql, params) => {
        if (sql.startsWith('SELECT checklist FROM opportunities')) return { rows };
        if (sql.startsWith('UPDATE opportunities SET checklist')) {
          rows = [{ checklist: JSON.parse(params[2]) }];
          return { rows: [] };
        }
        return { rows: [] };
      }),
    })),
  },
}));

const { db } = await import('../src/services/db.js');

describe('toggleChecklistItem', () => {
  it('flips only the matching item and leaves others untouched', async () => {
    rows = [{ checklist: [
      { id: 'narrative', label: 'Project narrative', done: false },
      { id: 'sam_uei', label: 'SAM/UEI', done: false },
    ] }];
    const out = await db.toggleChecklistItem('T1', '1', 'narrative', true);
    expect(out.find((i) => i.id === 'narrative').done).toBe(true);
    expect(out.find((i) => i.id === 'sam_uei').done).toBe(false);
  });

  it('is a no-op (returns the list unchanged) for an unknown item id', async () => {
    rows = [{ checklist: [{ id: 'narrative', label: 'Project narrative', done: false }] }];
    const out = await db.toggleChecklistItem('T1', '1', 'does-not-exist', true);
    expect(out).toEqual([{ id: 'narrative', label: 'Project narrative', done: false }]);
  });
});

describe('safeDate (via addOpportunity)', () => {
  it('never lets a stringified JS Date reach the query as-is', async () => {
    const badDate = new Date('2026-08-01T00:00:00Z').toString(); // e.g. "Fri Aug 01 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"
    let captured;
    db.pool.query = vi.fn(async (sql, params) => { captured = params; return { rows: [] }; });
    await db.addOpportunity('T1', { opp_id: '1', title: 'Test', close_date: badDate });
    expect(captured[5]).toBe('2026-08-01'); // close_date param, normalized to a plain ISO date
  });

  it('falls back to null for a genuinely unparseable date rather than throwing', async () => {
    let captured;
    db.pool.query = vi.fn(async (sql, params) => { captured = params; return { rows: [] }; });
    await db.addOpportunity('T1', { opp_id: '1', title: 'Test', close_date: 'not a date at all' });
    expect(captured[5]).toBeNull();
  });
});
