import { db } from '../services/db.js';
import { runIntent, markCardRunning } from '../agent/intents.js';
import { syncEvidenceToList } from '../services/lists.js';

async function detectFileMessage(client, channel, ts) {
  try {
    const { messages = [] } = await client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
    return Boolean(messages[0]?.files?.length);
  } catch {
    return false;
  }
}

/** Shared by the 🧵 reaction flow and the "Save as evidence" message shortcut. */
export async function saveEvidenceFromMessage(client, { teamId, channel, ts, userId }) {
  const [{ permalink }, isFile, channelInfo] = await Promise.all([
    client.chat.getPermalink({ channel, message_ts: ts }).catch(() => ({ permalink: '' })),
    detectFileMessage(client, channel, ts),
    client.conversations.info({ channel }).catch(() => null),
  ]);
  const { listItemId } = await db.saveEvidence(teamId, { channel_id: channel, message_ts: ts, permalink, tag: 'story', is_file: isFile, saved_by: userId });
  syncEvidenceToList(client, teamId, {
    channel_id: channel, message_ts: ts, permalink, tag: 'story', is_file: isFile,
    channel_name: channelInfo?.channel?.name, list_item_id: listItemId,
  }).catch(() => {});
  return {
    permalink,
    tagBlocks: [
      { type: 'section', text: { type: 'mrkdwn', text: 'Saved as evidence 🧶 — tag it:' } },
      { type: 'actions', elements: [
        ...['metric', 'story', 'testimonial'].map((t) => ({
          type: 'button', action_id: `evidence_tag:${t}`,
          value: JSON.stringify({ channel, ts, tag: t }),
          text: { type: 'plain_text', text: t },
          accessibility_label: `Tag this evidence as ${t}`,
        })),
        { type: 'button', action_id: 'evidence_undo', style: 'danger',
          value: JSON.stringify({ channel, ts }),
          text: { type: 'plain_text', text: 'Undo' },
          accessibility_label: 'Remove this evidence pointer' },
      ]},
    ],
  };
}

export function registerReactions(app) {
  app.event('reaction_added', async ({ event, client, context }) => {
    try {
      const teamId = context.teamId;

      // ✅-reaction confirm: a ✅ on a pending confirm card is
      // the same claim path as clicking its button. Checked BEFORE the
      // evidence-emoji logic below since it targets a different item kind.
      if (event.reaction === 'white_check_mark' && event.item?.type === 'message') {
        const intent = await db.getIntentByMessage(event.item.channel, event.item.ts);
        if (intent && intent.status === 'pending') {
          const row = await db.claimIntent(intent.id);
          if (row) {
            await markCardRunning(client, row);
            await runIntent(client, row);
          }
          return;
        }
      }

      const org = await db.getOrg(teamId);
      if (!org || event.reaction !== (org.evidence_emoji ?? 'thread')) return;
      if (event.item?.type !== 'message') return;

      const { tagBlocks } = await saveEvidenceFromMessage(client, {
        teamId, channel: event.item.channel, ts: event.item.ts, userId: event.user,
      });

      await client.chat.postEphemeral({
        channel: event.item.channel, user: event.user,
        text: 'Saved as evidence 🧶 (permalink only — no content copied).',
        blocks: tagBlocks,
      });
    } catch (e) { console.error('[reaction_added]', e?.message ?? e); }
  });

  app.action(/^evidence_tag:/, async ({ ack, action, body, client }) => {
    await ack();
    const { channel, ts, tag } = JSON.parse(action.value);
    const teamId = body.team.id;
    const { listItemId } = await db.saveEvidence(teamId, { channel_id: channel, message_ts: ts, tag, saved_by: body.user.id });
    // Live gap found in review: a retag never touched the List row, so its
    // Type column silently went stale the moment someone re-tagged.
    const channelInfo = await client.conversations.info({ channel }).catch(() => null);
    syncEvidenceToList(client, teamId, {
      channel_id: channel, message_ts: ts, tag, channel_name: channelInfo?.channel?.name, list_item_id: listItemId,
    }).catch(() => {});
  });

  app.action('evidence_undo', async ({ ack, action, body, client }) => {
    await ack();
    const { channel, ts } = JSON.parse(action.value);
    const teamId = body.team.id;
    // Fetch BEFORE deleting — the List row's id only lives on this DB row.
    const ptr = await db.getEvidencePointer(teamId, channel, ts);
    await db.pool.query(
      'DELETE FROM evidence_pointers WHERE team_id=$1 AND channel_id=$2 AND message_ts=$3',
      [teamId, channel, ts]);
    if (ptr?.list_item_id) {
      const org = await db.getOrg(teamId);
      if (org?.evidence_list_id) {
        await client.apiCall('slackLists.items.delete', { list_id: org.evidence_list_id, id: ptr.list_item_id })
          .catch((e) => console.warn('[lists:evidence:undo]', e?.data?.error ?? e.message));
      }
    }
  });
}
