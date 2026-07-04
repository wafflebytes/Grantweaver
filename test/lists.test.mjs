import { describe, it, expect, vi } from 'vitest';

const COLUMNS = { title: 'ColT', stage: 'ColS', agency: 'ColA', close_date: 'ColD', award_ceiling: 'ColC', owner: 'ColO', fit: 'ColF', checklist: 'ColK', draft: 'ColDr' };

vi.mock('../src/services/db.js', () => ({
  db: {
    getOrg: vi.fn(async () => ({ pipeline_list_id: 'F123', pipeline_list_columns: COLUMNS })),
    setPipelineList: vi.fn(async () => {}),
    setOpportunityListItem: vi.fn(async () => {}),
    listOpportunities: vi.fn(async () => [
      { opp_id: '1', title: 'Youth Grant', stage: 'reviewing', list_item_id: 'Rec1', owner_user_id: null, close_date: '2026-08-01' },
    ]),
    moveOpportunity: vi.fn(async () => {}),
    setOwner: vi.fn(async () => {}),
    logActivity: vi.fn(async () => {}),
    pool: { query: vi.fn(async () => {}) },
  },
}));

const { syncOpportunityToList, reconcileListEdits } = await import('../src/services/lists.js');
const { db } = await import('../src/services/db.js');

describe('syncOpportunityToList', () => {
  it('updates an existing row when list_item_id is known', async () => {
    const client = { apiCall: vi.fn(async () => ({ ok: true })) };
    const itemId = await syncOpportunityToList(client, 'T1', {
      opp_id: '1', title: 'Youth Grant', stage: 'reviewing', list_item_id: 'Rec1',
    });
    expect(itemId).toBe('Rec1');
    expect(client.apiCall).toHaveBeenCalledWith('slackLists.items.update', expect.objectContaining({ list_id: 'F123' }));
  });

  it('creates a new row and never throws on API failure', async () => {
    const client = { apiCall: vi.fn(async () => { throw new Error('missing_scope'); }) };
    const itemId = await syncOpportunityToList(client, 'T1', { opp_id: '2', title: 'Another Grant', stage: 'suggested' });
    expect(itemId).toBeNull();
  });
});

describe('reconcileListEdits', () => {
  it('applies a human stage/owner edit from the List into DB truth on fixture rows', async () => {
    const client = {
      apiCall: vi.fn(async (method) => {
        if (method === 'slackLists.items.list') {
          return {
            items: [{
              id: 'Rec1',
              fields: [
                { column_id: COLUMNS.stage, select: ['submitted'] },
                { column_id: COLUMNS.owner, user: ['U999'] },
                { column_id: COLUMNS.close_date, date: ['2026-08-01'] },
              ],
            }],
          };
        }
        return { ok: true };
      }),
      team: { info: vi.fn(async () => ({ team: { domain: 'x', id: 'T1' } })) },
    };
    await reconcileListEdits(client, 'T1');
    expect(db.moveOpportunity).toHaveBeenCalledWith('T1', '1', 'submitted');
    expect(db.setOwner).toHaveBeenCalledWith('T1', '1', 'U999');
    // close_date unchanged (matches fixture) — no logActivity for it
    expect(db.logActivity).toHaveBeenCalledTimes(2);
  });

  it('never throws when Lists is unavailable', async () => {
    const client = { apiCall: vi.fn(async () => { throw new Error('missing_scope'); }) };
    await expect(reconcileListEdits(client, 'T1')).resolves.toBeUndefined();
  });
});
