// Proactivity: evidence harvesting guard-chain + update requests +
// gw:deadline:snooze/gw:update:status handlers. Watch-drops and deadline
// nudges are wired from scheduler.js, which calls the exported sweep
// functions here.
import { db } from '../services/db.js';
import { updateRequestCard, staleReviewingCard } from './cards.js';
import { classifyHarvest } from '../prompts/classifiers.js';

const EVIDENCE_INTENT = /\b(\d+%|\d+ (kids|students|youth|families|participants|attendees)|increased|improved|graduated|completed|enrolled|served|thank you|thanks so much|so grateful|testimonial)\b/i;

function looksEvidenceShaped(text) {
  return EVIDENCE_INTENT.test(text);
}

/** Guard chain: every drop branch is independently testable. Returns a reason string or null (proceed). */
export function harvestDropReason({ subtype, botId, channelId, watchedChannels, recentHarvestCount, text }) {
  if (subtype || botId) return 'subtype_or_bot';
  if (!watchedChannels?.includes(channelId)) return 'not_watched';
  if (recentHarvestCount >= 2) return 'throttled';
  if (!looksEvidenceShaped(text ?? '')) return 'not_evidence_shaped';
  if ((text ?? '').length < 80) return 'too_short';
  if (!(/\d/.test(text ?? '') || /["“”]/.test(text ?? ''))) return 'no_number_or_quote';
  return null;
}

async function runHarvestOn(client, teamId, message, { bypassThrottle = false } = {}) {
  const org = await db.getOrg(teamId);
  const recentHarvestCount = bypassThrottle ? 0
    : await db.countSignalsSince(teamId, 'harvest_posted', message.channel, 24);
  const reason = harvestDropReason({
    subtype: message.subtype, botId: message.bot_id, channelId: message.channel,
    watchedChannels: org?.watched_channels ?? [], recentHarvestCount, text: message.text,
  });
  if (reason && !bypassThrottle) return { dropped: reason };
  if (reason === 'subtype_or_bot') return { dropped: reason }; // never bypass this one

  const pipeline = await db.listOpportunities(teamId);
  let is_evidence = true, tag = 'story', opp_id_hint = null;
  if (process.env.HARVEST_LLM !== 'false') {
    const result = await classifyHarvest(message.text, pipeline);
    if (result) ({ is_evidence, tag, opp_id_hint } = result);
    else ({ is_evidence, tag } = { is_evidence: true, tag: guessTag(message.text) }); // classifier down → heuristic pass
  } else {
    tag = guessTag(message.text);
  }
  if (!is_evidence) return { dropped: 'classifier_no' };

  const opp = opp_id_hint ? pipeline.find((o) => o.opp_id === String(opp_id_hint)) : null;
  await client.chat.postMessage({
    channel: message.channel, thread_ts: message.ts,
    text: `🧶 This looks like ${tag} evidence${opp ? ` for your ${opp.title} draft` : ''} — want me to save it?`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn',
        text: `🧶 This looks like *${tag}* evidence${opp ? ` for your *${opp.title}* draft` : ''} — want me to save it?` } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', action_id: 'evidence_save',
          value: JSON.stringify({ c: message.channel, ts: message.ts, tag, link: '' }),
          text: { type: 'plain_text', text: '💾 Save' } },
        { type: 'button', action_id: 'gw:harvest:dismiss',
          value: JSON.stringify({ c: message.channel, ts: message.ts }),
          text: { type: 'plain_text', text: 'No thanks' } },
      ] },
    ],
  });
  await db.addSignal(teamId, { kind: 'harvest_posted', subject: message.channel });
  return { dropped: null, tag, opp_id_hint };
}

function guessTag(text) {
  if (/\d+%|\d+ (kids|students|youth|families)/i.test(text)) return 'metric';
  if (/["“”]/.test(text)) return 'testimonial';
  return 'story';
}

export function registerProactive(app) {
  app.event('message', async ({ event, client, context }) => {
    if (event.channel_type !== 'channel' && event.channel_type !== 'group') return;
    const teamId = event.team ?? context.teamId;
    if (!teamId) return;
    try {
      await runHarvestOn(client, teamId, event);
    } catch (e) {
      console.warn('[proactive:harvest]', e?.message ?? e);
    }
  });

  app.action('gw:harvest:dismiss', async ({ ack, action, body, client }) => {
    await ack();
    const { c, ts } = JSON.parse(action.value);
    await db.addSignal(body.team.id, { kind: 'harvest_dismissed', subject: `${c}:${ts}` });
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: ts,
      text: "Got it — won't ask about that one again. 🧶" });
  });

  app.action('gw:deadline:snooze', async ({ ack, action, body, client }) => {
    await ack();
    const { o, days } = JSON.parse(action.value);
    await db.addSignal(body.team.id, { kind: 'nudge_posted', subject: `deadline:${o}`, detail: String(days) });
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: body.message?.ts,
      text: `Snoozed ${days} days 🧶` });
  });

  app.action('gw:update:status', async ({ ack, action, body, client }) => {
    await ack();
    const { o, v } = JSON.parse(action.value);
    const teamId = body.team.id;
    await db.touchActivity(teamId, o);
    await db.addSignal(teamId, { kind: 'update_request', subject: o, detail: v });
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    if (v === 'on_track') {
      await db.logActivity(teamId, o, { actor: body.user.id, kind: 'note', summary: 'Reported on track via update request' });
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: body.message?.ts,
        text: `🧶 Noted — ${opp?.title ?? o} is on track.` });
    } else {
      await db.logActivity(teamId, o, { actor: body.user.id, kind: 'note', summary: 'Reported stuck via update request' });
      await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message?.ts,
        text: `Need a hand with *${opp?.title ?? o}*? Ask me to draft it, or open a revision thread on the current draft. 🧶` });
    }
  });
}

/** Daily 9:30 cron + /grantweaver simulate update-request. */
export async function runUpdateRequestSweep(client, teamId = null, { bypassThrottle = false, dmOverride = null } = {}) {
  const orgs = teamId ? [await db.getOrg(teamId)].filter(Boolean) : await db.allOrgs();
  for (const org of orgs) {
    const opps = (await db.listOpportunities(org.team_id))
      .filter((o) => o.stage === 'drafting' && o.owner_user_id
        && (Date.now() - new Date(o.last_activity_at).getTime()) > 4 * 86400000);
    const candidates = bypassThrottle && !teamId ? [] : opps; // simulate picks explicitly below
    for (const o of (bypassThrottle ? [] : candidates)) {
      const recent = await db.countSignalsSince(org.team_id, 'update_request', o.opp_id, 5 * 24);
      if (recent > 0) continue;
      await client.chat.postMessage({ channel: o.owner_user_id, text: `Update on ${o.title}?`, blocks: updateRequestCard(o) }).catch(() => {});
      await db.addSignal(org.team_id, { kind: 'update_request', subject: o.opp_id, detail: 'nudge_sent' });
    }
  }
  if (bypassThrottle) {
    // simulate: pick the oldest drafting opp regardless of timers, DM the caller (not the owner).
    const org = teamId ? await db.getOrg(teamId) : (await db.allOrgs())[0];
    if (!org) return { picked: null };
    const opps = (await db.listOpportunities(org.team_id))
      .filter((o) => o.stage === 'drafting')
      .sort((a, b) => new Date(a.last_activity_at) - new Date(b.last_activity_at));
    const opp = opps[0];
    if (opp && dmOverride) {
      await client.chat.postMessage({ channel: dmOverride, text: `Update on ${opp.title}?`, blocks: updateRequestCard(opp) });
      return { picked: opp.opp_id };
    }
    return { picked: opp?.opp_id ?? null };
  }
}

/** Nudges on opportunities OUTSIDE 'drafting' that have gone quiet — update
 * requests only cover drafting, leaving 'suggested'/'reviewing' opps that
 * nobody ever acted on invisible to any proactive touchpoint. Posts to the
 * org's post channel (where it surfaced) rather than an owner DM, since
 * these are often unassigned. */
export async function runReviewingStaleSweep(client, teamId = null, { bypassThrottle = false, channelOverride = null } = {}) {
  const orgs = teamId ? [await db.getOrg(teamId)].filter(Boolean) : await db.allOrgs();
  const STALE_DAYS = 10;
  const results = [];
  for (const org of orgs) {
    const channel = channelOverride ?? org.post_channels?.[0] ?? org.digest_channel;
    if (!channel) continue;
    const stale = (await db.listOpportunities(org.team_id))
      .filter((o) => ['suggested', 'reviewing'].includes(o.stage))
      .map((o) => ({ o, daysStale: Math.floor((Date.now() - new Date(o.last_activity_at ?? o.created_at).getTime()) / 86400000) }))
      .filter(({ daysStale }) => daysStale >= STALE_DAYS);
    for (const { o, daysStale } of stale) {
      if (!bypassThrottle) {
        const recent = await db.countSignalsSince(org.team_id, 'reviewing_stale', o.opp_id, 7 * 24);
        if (recent > 0) continue;
      }
      await client.chat.postMessage({ channel, text: `${o.title} has gone quiet`, blocks: staleReviewingCard(o, daysStale) }).catch(() => {});
      await db.addSignal(org.team_id, { kind: 'reviewing_stale', subject: o.opp_id, detail: 'nudge_sent' });
      results.push(o.opp_id);
      if (bypassThrottle) break; // simulate: one nudge is enough to prove the path
    }
    if (bypassThrottle) break;
  }
  return { nudged: results };
}

/** /grantweaver simulate harvest — runs the pipeline against the most recent watched-channel message, bypassing throttle+heuristics. */
export async function runHarvestSimulate(client, teamId) {
  const org = await db.getOrg(teamId);
  const channel = org?.watched_channels?.[0];
  if (!channel) return { ok: false, reason: 'no_watched_channels' };
  const { messages = [] } = await client.conversations.history({ channel, limit: 1 });
  const m = messages[0];
  if (!m) return { ok: false, reason: 'no_messages' };
  const result = await runHarvestOn(client, teamId, { ...m, channel }, { bypassThrottle: true });
  return { ok: !result.dropped, ...result };
}
