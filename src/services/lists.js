// Grant pipeline as a Slack List — the sortable, judge-visible table
// complement to the Home tab board. Canvas keeps the *drafts* job
// (documents); this List is the *pipeline* job (rows + columns).
//
// UNVERIFIED LIVE: live method reference confirmed real
// (slackLists.create/items.create/items.update, `lists:write` scope), but
// the bot token needs that scope re-granted via an app reinstall before this
// can run end to end in the sandbox. Every call here is best-effort and
// swallows errors — a missing scope or a paid-workspace-only Lists gate must
// never break the pipeline tool's core add/move/list behavior.
import { db } from './db.js';

const COLUMN_DEFS = [
  { key: 'title', name: 'Opportunity', type: 'text', is_primary_column: true },
  {
    key: 'stage', name: 'Stage', type: 'select',
    options: {
      choices: [
        { value: 'suggested', label: 'Suggested' },
        { value: 'reviewing', label: 'Reviewing' },
        { value: 'drafting', label: 'Drafting' },
        { value: 'submitted', label: 'Submitted' },
        { value: 'awarded', label: 'Awarded' },
        { value: 'declined', label: 'Declined' },
      ],
    },
  },
  { key: 'agency', name: 'Agency', type: 'text' },
  { key: 'close_date', name: 'Deadline', type: 'date' },
  { key: 'award_ceiling', name: 'Award ceiling', type: 'number' },
];

function textCell(value) {
  return {
    rich_text: [{
      type: 'rich_text',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: String(value ?? '') }] }],
    }],
  };
}

function fieldsFor(columns, opp) {
  const val = (key, wrap) => ({ column_id: columns[key], ...wrap });
  return [
    val('title', textCell(opp.title ?? opp.opp_id)),
    val('stage', { select: [opp.stage ?? 'suggested'] }),
    val('agency', textCell(opp.agency ?? '')),
    ...(opp.close_date ? [val('close_date', { date: [String(opp.close_date).slice(0, 10)] })] : []),
    ...(opp.award_ceiling ? [val('award_ceiling', { number: [Number(opp.award_ceiling)] })] : []),
  ].filter((f) => f.column_id);
}

export async function ensurePipelineList(client, teamId) {
  const org = await db.getOrg(teamId);
  if (org?.pipeline_list_id && org?.pipeline_list_columns) {
    return { listId: org.pipeline_list_id, columns: org.pipeline_list_columns };
  }
  const created = await client.apiCall('slackLists.create', {
    name: 'Grant Pipeline',
    schema: COLUMN_DEFS,
  });
  const listId = created.list_id;
  const columns = Object.fromEntries((created.list_metadata?.schema ?? []).map((c) => [c.key, c.id]));
  await db.setPipelineList(teamId, listId, columns);
  return { listId, columns };
}

/** Best-effort: create-or-update a Slack List row mirroring one pipeline opportunity. */
export async function syncOpportunityToList(client, teamId, opp) {
  try {
    const { listId, columns } = await ensurePipelineList(client, teamId);
    const fields = fieldsFor(columns, opp);
    if (opp.list_item_id) {
      await client.apiCall('slackLists.items.update', {
        list_id: listId,
        cells: fields.map((f) => ({ row_id: opp.list_item_id, column_id: f.column_id, ...omitColumnId(f) })),
      });
      return opp.list_item_id;
    }
    const created = await client.apiCall('slackLists.items.create', { list_id: listId, initial_fields: fields });
    const itemId = created.item?.id;
    if (itemId) await db.setOpportunityListItem(teamId, opp.opp_id, itemId);
    return itemId;
  } catch (e) {
    console.warn('[lists] pipeline sync skipped:', e?.data?.error ?? e?.message);
    return null;
  }
}

function omitColumnId({ column_id, ...rest }) {
  return rest;
}
