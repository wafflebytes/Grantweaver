// One-off: the Evidence Locker List feature only creates+syncs a List entry
// on new evidence saves (ensureEvidenceList is called lazily from
// syncEvidenceToList). Orgs with evidence saved BEFORE this feature shipped
// have real evidence_pointers rows but no evidence_list_id and no synced
// List rows. Run once per environment after deploying the feature.
import { WebClient } from '@slack/web-api';
import { db } from '../src/services/db.js';
import { syncEvidenceToList } from '../src/services/lists.js';

const client = new WebClient(process.env.SLACK_BOT_TOKEN, { timeout: 45_000 });

const { rows: orgs } = await db.pool.query('SELECT team_id FROM orgs');
for (const { team_id: teamId } of orgs) {
  const pointers = await db.listEvidence(teamId, 500);
  if (!pointers.length) continue;
  console.log(`[backfill] ${teamId}: ${pointers.length} evidence pointer(s)`);
  for (const p of pointers) {
    const channelInfo = await client.conversations.info({ channel: p.channel_id }).catch(() => null);
    await syncEvidenceToList(client, teamId, {
      channel_id: p.channel_id,
      message_ts: p.message_ts,
      permalink: p.permalink,
      tag: p.tag,
      is_file: p.is_file,
      channel_name: channelInfo?.channel?.name,
      list_item_id: p.list_item_id,
    }).catch((e) => console.error(`[backfill] ${teamId} ${p.channel_id}/${p.message_ts}:`, e?.data?.error ?? e.message));
  }
}
console.log('[backfill] done');
process.exit(0);
