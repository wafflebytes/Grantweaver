// Grant pipeline as a Slack List — the sortable, judge-visible table
// complement to the Home tab board. Canvas keeps the *drafts* job
// (documents); this List is the *pipeline* job (rows + columns).
//
// Probe-confirmed live: NOT
// plan-gated on this sandbox; `items.list` returns fully typed cell values,
// so two-way sync (reconcileListEdits) is real, not a write-only fallback.
import { db } from './db.js';
import { refreshOverviewAndRequirements } from './canvas.js';

const STAGES = ['suggested', 'reviewing', 'drafting', 'submitted', 'awarded', 'declined'];
const STAGE_COLORS = { suggested: 'gray', reviewing: 'blue', drafting: 'yellow', submitted: 'orange', awarded: 'green', declined: 'red' };

const COLUMN_DEFS = [
  { key: 'title', name: 'Opportunity', type: 'text', is_primary_column: true },
  {
    key: 'stage', name: 'Stage', type: 'select',
    options: { choices: STAGES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1), color: STAGE_COLORS[s] })) },
  },
  { key: 'agency', name: 'Agency', type: 'text' },
  { key: 'close_date', name: 'Deadline', type: 'date' },
  { key: 'award_ceiling', name: 'Award ceiling', type: 'number' },
  { key: 'owner', name: 'Owner', type: 'user' },
  { key: 'fit', name: 'Fit', type: 'number' },
  { key: 'checklist', name: 'Checklist %', type: 'number' },
  { key: 'draft', name: 'Draft', type: 'link' },
];

// db.js's pg driver returns DATE columns as JS Date objects, not strings —
// `String(date)` produces "Sat May 24 2029 18:30:00 GMT+0000 (...)" garbage
// instead of an ISO date, which Slack's `date` cell type silently rejected
// (`internal_error`) rather than throwing something legible. Handle both.
function isoDate(v) {
  if (!v) return null;
  // pg hands DATE columns back as a JS Date at LOCAL midnight —
  // toISOString() shifts that to the previous day in any UTC+ timezone,
  // which made every reconcile see a phantom deadline diff and log a fake
  // "Deadline changed" activity row forever. Use local components for Dates
  // and the literal YYYY-MM-DD prefix for strings.
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function textCell(value) {
  return {
    rich_text: [{
      type: 'rich_text',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: String(value ?? '') }] }],
    }],
  };
}

function checklistPct(opp) {
  const items = opp.checklist ?? [];
  if (!items.length) return null;
  return Math.round((items.filter((c) => c.done).length / items.length) * 100);
}

function fieldsFor(columns, opp, canvasUrl) {
  const val = (key, wrap) => ({ column_id: columns[key], ...wrap });
  const pct = checklistPct(opp);
  return [
    val('title', textCell(opp.title ?? opp.opp_id)),
    val('stage', { select: [opp.stage ?? 'suggested'] }),
    // Slack's rich_text cells reject an empty string outright
    // (`must be more than 0 characters`) — omit rather than send blank text.
    ...(opp.agency ? [val('agency', textCell(opp.agency))] : []),
    ...(isoDate(opp.close_date) ? [val('close_date', { date: [isoDate(opp.close_date)] })] : []),
    ...(opp.award_ceiling ? [val('award_ceiling', { number: [Number(opp.award_ceiling)] })] : []),
    ...(opp.owner_user_id && columns.owner ? [val('owner', { user: [opp.owner_user_id] })] : []),
    ...(opp.fit_score != null && columns.fit ? [val('fit', { number: [opp.fit_score] })] : []),
    ...(pct != null && columns.checklist ? [val('checklist', { number: [pct] })] : []),
    ...(canvasUrl && columns.draft ? [val('draft', { link: [{ original_url: canvasUrl, display_as_url: false }] })] : []),
  ].filter((f) => f.column_id);
}

export async function ensurePipelineList(client, teamId) {
  const org = await db.getOrg(teamId);
  const missingKeys = COLUMN_DEFS.map((c) => c.key).filter((k) => !org?.pipeline_list_columns?.[k]);
  if (org?.pipeline_list_id && org?.pipeline_list_columns && !missingKeys.length) {
    return { listId: org.pipeline_list_id, columns: org.pipeline_list_columns };
  }
  if (org?.pipeline_list_id && missingKeys.length) {
    // Phase-1 lists predate the new columns. There is no live API to ADD a
    // column to an existing list (no live API for it)
    // — recreate. This is the one legitimate case where a new list_id is
    // expected; every opp resyncs its row on the next touch.
    console.warn('[lists] recreating pipeline list to add columns:', missingKeys);
  }
  const created = await client.apiCall('slackLists.create', {
    name: 'Grant Pipeline',
    schema: COLUMN_DEFS,
  });
  const listId = created.list_id;
  const columns = Object.fromEntries((created.list_metadata?.schema ?? []).map((c) => [c.key, c.id]));
  await db.setPipelineList(teamId, listId, columns);
  // Live-reported bug: a List created via the API is private to its
  // creator (the bot) by default, same as a fresh canvas — canvas.js
  // already grants channel access after creation, but this never did,
  // so every other team member hit "you don't have access" opening the
  // Home tab's link. Share write access to the org's post channel(s)
  // (#grants by default) so the whole team the pipeline is FOR can use it.
  // org.post_channels stores bare NAMES ("grants"), not IDs — resolve
  // before calling access.set, which needs real channel_ids.
  const postNames = org?.post_channels ?? [];
  if (postNames.length) {
    const { channels = [] } = await client.conversations.list({ types: 'public_channel', limit: 200 }).catch(() => ({}));
    const channelIds = postNames.map((n) => channels.find((c) => c.name === n)?.id).filter(Boolean);
    if (channelIds.length) {
      await client.apiCall('slackLists.access.set', {
        list_id: listId, access_level: 'write', channel_ids: channelIds,
      }).catch((e) => console.warn('[lists:access]', e?.data?.error ?? e.message));
    }
  }
  return { listId, columns };
}

/** Best-effort: create-or-update a Slack List row mirroring one pipeline opportunity. */
export async function syncOpportunityToList(client, teamId, opp, canvasUrl) {
  try {
    const { listId, columns } = await ensurePipelineList(client, teamId);
    const link = canvasUrl ?? (opp.canvas_id ? await canvasLinkFor(client, opp.canvas_id) : undefined);
    const fields = fieldsFor(columns, opp, link);
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

async function canvasLinkFor(client, canvasId) {
  try {
    const { team } = await client.team.info();
    const host = team.enterprise_domain ? `${team.enterprise_domain}.enterprise.slack.com` : `${team.domain}.slack.com`;
    return `https://${host}/docs/${team.id}/${canvasId}`;
  } catch {
    return undefined;
  }
}

// The pipeline List gets created and kept in sync via slackLists.* API
// calls, but that API never puts a link to it anywhere a human would see
// it — live-reported: the List is real and populated (confirmed via
// slackLists.items.list) but effectively invisible in the actual client,
// since nothing ever shared it to a channel or linked it from the Home tab.
export async function listLink(client, teamId, listId) {
  try {
    const { team } = await client.team.info();
    const host = team.enterprise_domain ? `${team.enterprise_domain}.enterprise.slack.com` : `${team.domain}.slack.com`;
    return `https://${host}/lists/${teamId}/${listId}`;
  } catch {
    return undefined;
  }
}

function omitColumnId({ column_id, ...rest }) {
  return rest;
}

/** Extracts a typed cell's plain value from items.list's response shape. */
function cellValue(item, columnId) {
  const field = item.fields?.find((f) => f.column_id === columnId);
  if (!field) return undefined;
  if (field.select) return field.select[0];
  if (field.user) return field.user[0];
  if (field.date) return field.date[0];
  if (field.number != null) return field.number[0];
  if (field.link) return field.link[0]?.originalUrl;
  if (field.text != null) return field.text;
  return field.value;
}

/**
 * Read-back half of two-way sync (probe-confirmed viable).
 * Pulls fields the HUMAN can edit in the List UI (stage, owner, close date)
 * into DB truth; DB-owned fields (fit/checklist%/draft link) are pushed the
 * other direction by syncOpportunityToList, never read back here.
 * Best-effort throughout — a Lists outage must never break a turn.
 */
const reconciling = new Set();
export async function reconcileListEdits(client, teamId) {
  if (reconciling.has(teamId)) return; // dedupe concurrent triggers
  reconciling.add(teamId);
  try {
    const org = await db.getOrg(teamId);
    if (!org?.pipeline_list_id) return;
    const { items = [] } = await client.apiCall('slackLists.items.list', { list_id: org.pipeline_list_id });
    const columns = org.pipeline_list_columns;
    const opps = await db.listOpportunities(teamId);
    for (const row of items) {
      const opp = opps.find((o) => o.list_item_id === row.id);
      if (!opp) continue; // humans may add rows; the agent adopts them only when asked
      const listStage = cellValue(row, columns.stage);
      const listOwner = cellValue(row, columns.owner);
      const listClose = cellValue(row, columns.close_date);
      let touched = false;
      if (listStage && listStage !== opp.stage) {
        await db.moveOpportunity(teamId, opp.opp_id, listStage);
        await db.logActivity(teamId, opp.opp_id, { actor: 'system', kind: 'list_edit', summary: `Stage changed to ${listStage} in the List` });
        touched = true;
      }
      if (listOwner && listOwner !== opp.owner_user_id) {
        await db.setOwner(teamId, opp.opp_id, listOwner);
        await db.logActivity(teamId, opp.opp_id, { actor: 'system', kind: 'list_edit', summary: `Owner changed to <@${listOwner}> in the List` });
        touched = true;
      }
      if (touched) refreshOverviewAndRequirements(client, teamId, { ...opp, owner_user_id: listOwner ?? opp.owner_user_id }).catch(() => {});
      if (listClose && listClose !== isoDate(opp.close_date)) {
        await db.pool.query('UPDATE opportunities SET close_date=$3 WHERE team_id=$1 AND opp_id=$2', [teamId, opp.opp_id, listClose]);
        await db.logActivity(teamId, opp.opp_id, { actor: 'system', kind: 'list_edit', summary: `Deadline changed to ${listClose} in the List` });
      }
    }
    // DB→List push for fields the DB owns (fit/checklist%/draft link) so a
    // human viewing the List sees current numbers even if they never touched it.
    for (const opp of opps) {
      if (opp.list_item_id) await syncOpportunityToList(client, teamId, opp).catch(() => {});
    }
  } catch (e) {
    console.warn('[lists] reconcile skipped:', e?.data?.error ?? e?.message);
  } finally {
    reconciling.delete(teamId);
  }
}
