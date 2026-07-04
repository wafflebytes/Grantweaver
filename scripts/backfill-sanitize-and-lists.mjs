// One-off: two backfills for orgs that had data before this session's fixes:
// 1. Existing opportunity titles/agencies with literal &nbsp; entities from
//    before addOpportunityFull's sanitizeText() fix, re-cleaned in place and
//    re-synced to the Pipeline List.
// 2. Evidence pointers saved before the Evidence Locker List existed, given
//    a first-time List sync (creates the list on first call if missing).
import { WebClient } from '@slack/web-api';
import { db } from '../src/services/db.js';
import { syncOpportunityToList, syncEvidenceToList } from '../src/services/lists.js';
import { sanitizeText } from '../src/agent/tools.js';

const client = new WebClient(process.env.SLACK_BOT_TOKEN, { timeout: 45_000 });

const { rows: orgs } = await db.pool.query('SELECT team_id FROM orgs');
for (const { team_id: teamId } of orgs) {
  const opps = await db.listOpportunities(teamId);
  for (const o of opps) {
    const cleanTitle = sanitizeText(o.title);
    const cleanAgency = sanitizeText(o.agency);
    if (cleanTitle !== o.title || cleanAgency !== o.agency) {
      console.log(`[sanitize] ${teamId}/${o.opp_id}: "${o.title}" -> "${cleanTitle}"`);
      await db.pool.query(
        'UPDATE opportunities SET title=$3, agency=$4 WHERE team_id=$1 AND opp_id=$2',
        [teamId, o.opp_id, cleanTitle, cleanAgency]);
      o.title = cleanTitle;
      o.agency = cleanAgency;
    }
    await syncOpportunityToList(client, teamId, o).catch((e) =>
      console.error(`[sanitize] list sync failed ${teamId}/${o.opp_id}:`, e?.data?.error ?? e.message));
  }

  const pointers = await db.listEvidence(teamId, 500);
  for (const p of pointers) {
    const channelInfo = await client.conversations.info({ channel: p.channel_id }).catch(() => null);
    await syncEvidenceToList(client, teamId, {
      channel_id: p.channel_id, message_ts: p.message_ts, permalink: p.permalink,
      tag: p.tag, is_file: p.is_file, channel_name: channelInfo?.channel?.name, list_item_id: p.list_item_id,
    }).catch((e) => console.error(`[backfill] evidence sync failed ${teamId} ${p.channel_id}/${p.message_ts}:`, e?.data?.error ?? e.message));
  }
  console.log(`[backfill] ${teamId}: ${opps.length} opp(s), ${pointers.length} evidence pointer(s) synced`);
}
console.log('[backfill] done');
process.exit(0);
