import { db } from '../services/db.js';
import { grantsGov } from '../mcp/grantsgov-client.js';

export function registerActions(app) {
  app.action('pipeline_add', async ({ ack, action, body, client }) => {
    await ack();
    try {
      const details = await grantsGov.fetchOpportunity(action.value);
      await db.addOpportunity(body.team.id, {
        opp_id: action.value, opp_number: details.opp_number, title: details.title,
        agency: details.agency, close_date: details.close_date,
        award_ceiling: details.award_ceiling,
        url: `https://grants.gov/search-results-detail/${action.value}`,
        added_by: body.user.id,
      });
      await client.chat.postEphemeral({
        channel: body.channel.id, user: body.user.id, thread_ts: body.message?.thread_ts,
        text: `➕ Added *${details.title}* to your pipeline (Reviewing). See it on my Home tab.`,
      });
    } catch (e) {
      console.error('[pipeline_add]', e?.message ?? e);
      await client.chat.postEphemeral({
        channel: body.channel.id, user: body.user.id, thread_ts: body.message?.thread_ts,
        text: "I couldn't add that just now (Grants.gov hiccup). Try again in a minute. 🧶",
      });
    }
  });

  app.action('evidence_save', async ({ ack, action, body, client }) => {
    await ack();
    const { c, ts, tag, link } = JSON.parse(action.value);
    await db.saveEvidence(body.team.id, {
      channel_id: c, message_ts: ts, permalink: link ?? '', tag: tag ?? 'story', saved_by: body.user.id,
    });
    await client.chat.postEphemeral({
      channel: body.channel.id, user: body.user.id, thread_ts: body.message?.thread_ts,
      text: "💾 Evidence pointer saved — I'll re-read it live whenever we draft.",
    });
  });

  app.action('opp_details', async ({ ack, action, body, client }) => {
    await ack();
    const d = await grantsGov.fetchOpportunity(action.value);
    await client.chat.postMessage({
      channel: body.channel.id, thread_ts: body.message?.thread_ts,
      text: `Details: ${d.title}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn',
        text: `*${d.title}*\n*Agency:* ${d.agency ?? '—'} · *Ceiling:* $${Number(d.award_ceiling ?? 0).toLocaleString()} · *Closes:* ${d.close_date ?? '—'}\n\n*Eligibility:* ${(d.eligibility ?? '—').slice(0, 500)}\n\n${(d.synopsis ?? '').slice(0, 900)}` } }],
    });
  });

  app.action('open_assistant_hint', async ({ ack, body, client }) => {
    await ack();
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Open me from the ✨ agent icon in the top nav (or Apps → Grantweaver → Chat) and try: "Find new grants that fit our mission."',
    });
  });
}
