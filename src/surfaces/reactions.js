import { db } from '../services/db.js';

export function registerReactions(app) {
  app.event('reaction_added', async ({ event, client, context }) => {
    try {
      const teamId = context.teamId;
      const org = await db.getOrg(teamId);
      if (!org || event.reaction !== (org.evidence_emoji ?? 'thread')) return;
      if (event.item?.type !== 'message') return;

      const { channel, ts } = event.item;
      const { permalink } = await client.chat.getPermalink({ channel, message_ts: ts })
        .catch(() => ({ permalink: '' }));

      await db.saveEvidence(teamId, {
        channel_id: channel, message_ts: ts, permalink, tag: 'story', saved_by: event.user,
      });

      await client.chat.postEphemeral({
        channel, user: event.user,
        text: 'Saved as evidence 🧶 (permalink only — no content copied).',
        blocks: [
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
      });
    } catch (e) { console.error('[reaction_added]', e?.message ?? e); }
  });

  app.action(/^evidence_tag:/, async ({ ack, action, body }) => {
    await ack();
    const { channel, ts, tag } = JSON.parse(action.value);
    await db.saveEvidence(body.team.id, { channel_id: channel, message_ts: ts, tag, saved_by: body.user.id });
  });

  app.action('evidence_undo', async ({ ack, action, body }) => {
    await ack();
    const { channel, ts } = JSON.parse(action.value);
    await db.pool.query(
      'DELETE FROM evidence_pointers WHERE team_id=$1 AND channel_id=$2 AND message_ts=$3',
      [body.team.id, channel, ts]);
  });
}
