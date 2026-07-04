// Probe: Slack Lists column type names, cell read/update shapes, and
// whether the sandbox's plan even allows list creation.
// Run: node --env-file=.env scripts/probe-lists.mjs
import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function main() {
  console.log('--- 1. slackLists.create (5 base + 4 new columns) ---');
  let listId, columns;
  try {
    const created = await client.apiCall('slackLists.create', {
      name: 'Probe Pipeline',
      schema: [
        { key: 'title', name: 'Opportunity', type: 'text', is_primary_column: true },
        { key: 'stage', name: 'Stage', type: 'select', options: { choices: [{ value: 'reviewing', label: 'Reviewing', color: 'blue' }] } },
        { key: 'agency', name: 'Agency', type: 'text' },
        { key: 'close_date', name: 'Deadline', type: 'date' },
        { key: 'award_ceiling', name: 'Award ceiling', type: 'number' },
        { key: 'owner', name: 'Owner', type: 'user' },
        { key: 'fit', name: 'Fit', type: 'number' },
        { key: 'checklist', name: 'Checklist %', type: 'number' },
        { key: 'draft', name: 'Draft', type: 'link' },
      ],
    });
    console.log(JSON.stringify(created, null, 2));
    listId = created.list_id;
    columns = Object.fromEntries((created.list_metadata?.schema ?? []).map((c) => [c.key, c.id]));
  } catch (e) {
    console.log('FAILED (likely plan-gated)', e?.data?.error ?? e.message);
    return;
  }

  console.log('\n--- 2. items.create one row ---');
  const item = await client.apiCall('slackLists.items.create', {
    list_id: listId,
    initial_fields: [
      { column_id: columns.title, rich_text: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Probe Opp' }] }] }] },
      { column_id: columns.stage, select: ['reviewing'] },
      { column_id: columns.owner, user: ['U0BER9GSBQD'] },
      { column_id: columns.fit, number: [77] },
      { column_id: columns.draft, link: [{ original_url: 'https://example.com', display_as_url: false }] },
    ],
  });
  console.log(JSON.stringify(item, null, 2));

  console.log('\n--- 3. items.list ---');
  const list = await client.apiCall('slackLists.items.list', { list_id: listId });
  console.log(JSON.stringify(list, null, 2));

  console.log('\n--- 4. items.update a select cell ---');
  const rowId = item.item?.id;
  const upd = await client.apiCall('slackLists.items.update', {
    list_id: listId,
    cells: [{ row_id: rowId, column_id: columns.stage, select: ['submitted'] }],
  });
  console.log(JSON.stringify(upd, null, 2));

  console.log('\n--- 5. items.list again (confirm update stuck) ---');
  const list2 = await client.apiCall('slackLists.items.list', { list_id: listId });
  console.log(JSON.stringify(list2, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
