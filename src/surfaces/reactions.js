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

// File-sourced evidence has no channel/ts (see db.saveEvidence's comment) —
// mirror the same synthesis here so the tag/undo buttons' values reference
// the SAME row db.saveEvidence actually wrote, not the raw empty strings.
function pointerKey(channel_id, message_ts, permalink) {
  if (!channel_id && !message_ts && permalink) return { channel_id: 'file', message_ts: permalink };
  return { channel_id, message_ts };
}

/**
 * Single save+sync+tag-UI path for all three entry points: the 🧵 reaction,
 * the message shortcut, and the evidence-suggestion card's "Save as
 * evidence" button (channel-only message evidence AND file evidence both
 * route through here now — previously the button path skipped List sync
 * entirely, live-reported as "why didn't it make the evidence list").
 */
export async function persistEvidencePointer(client, teamId, { channel_id, message_ts, permalink, tag = 'story', is_file = false, saved_by }) {
  const channelInfo = channel_id ? await client.conversations.info({ channel: channel_id }).catch(() => null) : null;
  const { listItemId } = await db.saveEvidence(teamId, { channel_id, message_ts, permalink, tag, is_file, saved_by });
  const key = pointerKey(channel_id, message_ts, permalink);
  syncEvidenceToList(client, teamId, {
    ...key, permalink, tag, is_file, channel_name: channelInfo?.channel?.name, list_item_id: listItemId,
  }).catch(() => {});
  return {
    permalink,
    tagBlocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `Saved as evidence 🧶 — tagged _${tag}_.` } },
      { type: 'actions', elements: [
        { type: 'button', action_id: 'evidence_tag_open',
          value: JSON.stringify({ ...key, tag }),
          text: { type: 'plain_text', text: '🏷️ Change tag' },
          accessibility_label: 'Change this evidence pointer\'s tag' },
        { type: 'button', action_id: 'evidence_undo', style: 'danger',
          value: JSON.stringify(key),
          text: { type: 'plain_text', text: 'Undo' },
          accessibility_label: 'Remove this evidence pointer' },
      ]},
    ],
  };
}

/** Shared by the 🧵 reaction flow and the "Save as evidence" message shortcut. */
export async function saveEvidenceFromMessage(client, { teamId, channel, ts, userId }) {
  const [{ permalink }, isFile] = await Promise.all([
    client.chat.getPermalink({ channel, message_ts: ts }).catch(() => ({ permalink: '' })),
    detectFileMessage(client, channel, ts),
  ]);
  return persistEvidencePointer(client, teamId, {
    channel_id: channel, message_ts: ts, permalink, tag: 'story', is_file: isFile, saved_by: userId,
  });
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

  // Standardized to a modal (per the same "everything inline is cluttering
  // the chat" ask that moved Share-to-channel to a modal) — one "Change
  // tag" button instead of three separate metric/story/testimonial buttons
  // crowding the message.
  app.action('evidence_tag_open', async ({ ack, action, body, client }) => {
    await ack();
    const { channel_id, message_ts, tag } = JSON.parse(action.value);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal', callback_id: 'gw_evidence_tag_submit',
        private_metadata: JSON.stringify({ channel_id, message_ts }),
        title: { type: 'plain_text', text: 'Tag evidence' },
        submit: { type: 'plain_text', text: 'Save' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [{
          type: 'input', block_id: 'tag',
          label: { type: 'plain_text', text: 'Type' },
          element: {
            type: 'static_select', action_id: 'val',
            initial_option: { text: { type: 'plain_text', text: tag[0].toUpperCase() + tag.slice(1) }, value: tag },
            options: ['metric', 'story', 'testimonial'].map((t) => ({
              text: { type: 'plain_text', text: t[0].toUpperCase() + t.slice(1) }, value: t,
            })),
          },
        }],
      },
    }).catch((e) => console.warn('[evidence_tag_open]', e?.data?.error ?? e.message));
  });

  app.view('gw_evidence_tag_submit', async ({ ack, view, body, client }) => {
    await ack();
    const { channel_id, message_ts } = JSON.parse(view.private_metadata || '{}');
    const tag = view.state.values.tag.val.selected_option.value;
    const teamId = body.team.id;
    // Live gap found in review: a retag never touched the List row, so its
    // Type column silently went stale the moment someone re-tagged.
    const { listItemId } = await db.saveEvidence(teamId, { channel_id, message_ts, tag, saved_by: body.user.id });
    const channelInfo = channel_id !== 'file' ? await client.conversations.info({ channel: channel_id }).catch(() => null) : null;
    syncEvidenceToList(client, teamId, {
      channel_id, message_ts, tag, channel_name: channelInfo?.channel?.name, list_item_id: listItemId,
    }).catch(() => {});
    await client.chat.postEphemeral({
      channel: channel_id !== 'file' ? channel_id : body.user.id, user: body.user.id,
      text: `Tagged as _${tag}_. 🧶`,
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
