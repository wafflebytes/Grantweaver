import { WebClient } from '@slack/web-api';
import { db } from '../src/services/db.js';

const seedBot = new WebClient(process.env.SEED_BOT_TOKEN, { timeout: 45_000 });
const gwBot = new WebClient(process.env.SLACK_BOT_TOKEN, { timeout: 45_000 });

const CHANNEL_NAMES = ['general', 'program-updates', 'mentor-stories', 'volunteers', 'events', 'grants', 'board', 'budget-finance'];

async function archiveChannels() {
  // Renamed, not archived: Slack won't let seed-riverbend.mjs reuse a name
  // held by an archived channel, so renaming out of the way then archiving
  // keeps the original clean names free for the reseed.
  const { channels } = await seedBot.conversations.list({ types: 'public_channel', limit: 200 });
  for (const name of CHANNEL_NAMES) {
    const ch = channels.find((c) => c.name === name && !c.is_archived);
    if (!ch) { console.log(`skip ${name}: not found or already archived`); continue; }
    try {
      await seedBot.conversations.rename({ channel: ch.id, name: `${name}-old-jul4` });
      await seedBot.conversations.archive({ channel: ch.id });
      console.log(`renamed+archived #${name} -> #${name}-old-jul4 (${ch.id})`);
    } catch (e) {
      console.warn(`FAILED archive #${name}:`, e?.data?.error ?? e.message);
    }
  }
}

async function deleteLists(teamId) {
  const org = await db.getOrg(teamId);
  for (const [label, listId] of [['pipeline', org.pipeline_list_id], ['evidence', org.evidence_list_id]]) {
    if (!listId) continue;
    try {
      await gwBot.apiCall('slackLists.delete', { list_id: listId });
      console.log(`deleted ${label} list ${listId}`);
    } catch (e) {
      console.warn(`FAILED delete ${label} list:`, e?.data?.error ?? e.message);
    }
  }
}

async function wipeDb(teamId) {
  await db.pool.query('DELETE FROM opp_activity WHERE team_id=$1', [teamId]);
  await db.pool.query('DELETE FROM opportunities WHERE team_id=$1', [teamId]);
  await db.pool.query('DELETE FROM evidence_pointers WHERE team_id=$1', [teamId]);
  await db.pool.query('DELETE FROM evidence_index WHERE team_id=$1', [teamId]);
  await db.pool.query('DELETE FROM watches WHERE team_id=$1', [teamId]);
  await db.pool.query('DELETE FROM pending_intents WHERE team_id=$1', [teamId]);
  await db.pool.query('DELETE FROM signals WHERE team_id=$1', [teamId]);
  await db.pool.query('DELETE FROM feedback WHERE team_id=$1', [teamId]);
  await db.pool.query(
    `UPDATE orgs SET pipeline_list_id=NULL, pipeline_list_columns=NULL, evidence_list_id=NULL,
       evidence_list_columns=NULL, onboarding_state=NULL, index_built_at=NULL,
       eligibility_facts=NULL, greeted_users='{}', memories_channel=NULL, watched_channels='{}', post_channels='{}'
     WHERE team_id=$1`, [teamId]);
  console.log('DB wiped for', teamId);
}

// chat.delete only works for the token that actually posted the message.
// #general's persona messages were posted under several distinct bot
// identities (one per persona's username override) — SEED_BOT_TOKEN only
// owns its own. Try both known tokens; anything else can't be deleted via API.
let skippedForeign = 0;
async function deleteIfBot(channelId, m) {
  if (!(m.bot_id || m.subtype === 'bot_message')) return false;
  for (const client of [gwBot, seedBot]) {
    try {
      await client.chat.delete({ channel: channelId, ts: m.ts });
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    } catch (e) {
      if (e?.data?.error !== 'cant_delete_message') { await new Promise((r) => setTimeout(r, 500)); }
    }
  }
  skippedForeign++;
  return false;
}

async function cleanChannel(channelId) {
  return cleanDms(null, channelId);
}

async function cleanDms(teamId, dmChannelId) {
  const channel = { id: dmChannelId };
  let cursor;
  let deleted = 0;
  const threadParents = [];
  do {
    const res = await gwBot.conversations.history({ channel: channel.id, cursor, limit: 200 });
    for (const m of res.messages) {
      if (m.reply_count > 0) threadParents.push(m.ts);
      if (await deleteIfBot(channel.id, m)) deleted++;
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  for (const parentTs of threadParents) {
    let replyCursor;
    do {
      const res = await gwBot.conversations.replies({ channel: channel.id, ts: parentTs, cursor: replyCursor, limit: 200 })
        .catch(() => ({ messages: [] }));
      for (const m of res.messages) {
        if (m.ts === parentTs) continue; // already handled above
        if (await deleteIfBot(channel.id, m)) deleted++;
      }
      replyCursor = res.response_metadata?.next_cursor;
    } while (replyCursor);
  }

  console.log(`deleted ${deleted} bot messages (incl. thread replies) in ${dmChannelId}; ${skippedForeign} skipped (posted by a bot identity I have no token for)`);
}

const step = process.argv[2];
const teamId = 'T0BESJ1MU7Q';

if (step === 'archive') await archiveChannels();
else if (step === 'lists') await deleteLists(teamId);
else if (step === 'db') await wipeDb(teamId);
else if (step === 'dm') await cleanDms(teamId, process.argv[3]);
else if (step === 'channel') await cleanChannel(process.argv[3]);
else console.log('usage: node clean-slate.mjs <archive|lists|db|dm [userId]>');

process.exit(0);
