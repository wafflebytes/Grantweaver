import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/db.js', () => ({
  db: {
    getOrg: vi.fn(async () => ({ pipeline_list_id: 'F123', pipeline_list_columns: { title: 'ColT', stage: 'ColS', agency: 'ColA', close_date: 'ColD', award_ceiling: 'ColC' } })),
    setPipelineList: vi.fn(async () => {}),
    setOpportunityListItem: vi.fn(async () => {}),
  },
}));

const { syncOpportunityToList } = await import('../src/services/lists.js');

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
