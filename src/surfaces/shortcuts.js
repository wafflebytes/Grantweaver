import { db } from '../services/db.js';
import { runAgentTurn } from '../agent/loop.js';
import { saveEvidenceFromMessage } from './reactions.js';

/** Fallback streamer for contexts with no sayStream (modal-triggered DMs —
 * Bolt only injects sayStream into message handlers). Accumulates text, posts once at the end.
 * No streaming texture, but the turn still completes and replies. */
function makePostMessageStreamer({ client, channel }) {
  let buf = '';
  return {
    append: async ({ markdown_text }) => { buf += markdown_text; },
    task: async () => {},
    stop: async ({ blocks } = {}) => {
      await client.chat.postMessage({ channel, text: buf || 'Done 🧶', ...(blocks ? { blocks } : {}) });
    },
  };
}

export function registerShortcuts(app) {
  app.shortcut('gw_shortcut_evidence', async ({ shortcut, ack, client }) => {
    await ack();
    const { channel, message, user, team } = shortcut;
    try {
      const { tagBlocks } = await saveEvidenceFromMessage(client, {
        teamId: team.id, channel: channel.id, ts: message.ts, userId: user.id,
      });
      await client.chat.postEphemeral({ channel: channel.id, user: user.id, text: 'Saved as evidence 🧶', blocks: tagBlocks });
    } catch (e) {
      console.error('[gw_shortcut_evidence]', e?.message ?? e);
    }
  });

  app.shortcut('gw_shortcut_find', async ({ shortcut, ack, client }) => {
    await ack();
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: {
        type: 'modal', callback_id: 'gw_shortcut_find_submit',
        private_metadata: JSON.stringify({ userId: shortcut.user.id, teamId: shortcut.team.id }),
        title: { type: 'plain_text', text: 'Find grants like this' },
        submit: { type: 'plain_text', text: 'Search' }, close: { type: 'plain_text', text: 'Cancel' },
        blocks: [{
          type: 'input', block_id: 'brief',
          label: { type: 'plain_text', text: 'What should I look for?' },
          element: { type: 'plain_text_input', action_id: 'value', multiline: true,
            initial_value: (shortcut.message?.text ?? '').slice(0, 2900) },
        }],
      },
    });
  });

  app.view('gw_shortcut_find_submit', async ({ ack, view, client }) => {
    await ack();
    const { userId, teamId } = JSON.parse(view.private_metadata || '{}');
    const brief = view.state.values.brief.value.value;
    try {
      const dm = await client.conversations.open({ users: userId });
      const channel = dm.channel.id;
      await runAgentTurn({
        client, surface: 'dm', teamId, userId, channelId: channel,
        threadTs: undefined, contextChannelId: undefined, actionToken: undefined,
        messageTs: undefined, botUserId: undefined,
        userText: `Find grants matching this brief: ${brief}`,
        makeStreamer: () => makePostMessageStreamer({ client, channel }),
      });
    } catch (e) {
      console.error('[gw_shortcut_find_submit]', e?.message ?? e);
    }
  });

  app.shortcut('gw_shortcut_due', async ({ shortcut, ack, client }) => {
    await ack();
    const opps = await db.listOpportunities(shortcut.team.id);
    const dated = opps
      .filter((o) => o.close_date && !['awarded', 'declined'].includes(o.stage))
      .sort((a, b) => new Date(a.close_date) - new Date(b.close_date))
      .slice(0, 10);
    const lines = dated.map((o) => {
      const days = Math.ceil((new Date(o.close_date) - Date.now()) / 86400000);
      return `• *${o.title}* — due ${o.close_date} (${days} days) · _${o.stage}_`;
    });
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: {
        type: 'modal', callback_id: 'gw_shortcut_due_view',
        title: { type: 'plain_text', text: "What's due soon?" },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_Nothing due — your pipeline is quiet._' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Open my Home tab for the full board.' }] },
        ],
      },
    });
  });
}
