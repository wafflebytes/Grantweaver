import { db } from '../services/db.js';
import { grantsGov } from '../mcp/grantsgov-client.js';
import { syncOpportunityToList } from '../services/lists.js';
import { runIntent, markCardRunning, markCardCancelled } from '../agent/intents.js';
import { confirmCard, shareCard } from './cards.js';
import '../services/exportpack.js'; // side effect: registers the export_pack/answers intent executors

// docs/22 §4.2: every channel follow-up threads under the triggering message
// — this exact line is the fix for "view more should land in the same
// thread." Applies to legacy handlers too.
const replyTarget = (body) => body.message?.thread_ts ?? body.message?.ts;
const val = (action) => JSON.parse(action.value || '{}');
const NOT_RELEVANT_REASONS = ['Wrong focus area', 'Award too large for us', 'Award too small', "We're not eligible", 'Other (tell me)'];

async function canvasLink(client, canvasId) {
  const { team } = await client.team.info();
  const host = team.enterprise_domain ? `${team.enterprise_domain}.enterprise.slack.com` : `${team.domain}.slack.com`;
  return `https://${host}/docs/${team.id}/${canvasId}`;
}

async function openNotRelevantModal(client, { trigger_id, o, channel, thread_ts }) {
  await client.views.open({
    trigger_id,
    view: {
      type: 'modal', callback_id: 'gw_not_relevant_submit',
      private_metadata: JSON.stringify({ o, channel, thread_ts }),
      title: { type: 'plain_text', text: 'Good to know' },
      submit: { type: 'plain_text', text: 'Save' }, close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'reason', label: { type: 'plain_text', text: "Why isn't this one right?" },
          element: { type: 'radio_buttons', action_id: 'value',
            options: NOT_RELEVANT_REASONS.map((r) => ({ text: { type: 'plain_text', text: r }, value: r })) } },
        { type: 'input', block_id: 'other_text', optional: true,
          label: { type: 'plain_text', text: 'If "Other", say more (optional)' },
          element: { type: 'plain_text_input', action_id: 'value' } },
      ],
    },
  });
}

export function registerActions(app) {
  // in-process pending-pick maps for select-driven follow-ups (ephemeral
  // messages have no stable ts we can key intents off, so the (channel,user)
  // pair scopes a single outstanding pick — a reload just needs a re-click)
  const pendingShare = new Map();
  const pendingOwner = new Map();

  async function doExportMd({ o, teamId, channel, thread_ts, requestedBy }) {
    const intent = await db.createIntent(teamId, { kind: 'export_pack', params: { opp_id: o }, requested_by: requestedBy, channel_id: channel });
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    const posted = await app.client.chat.postMessage({
      channel, thread_ts, text: 'Ready to build your export pack',
      blocks: confirmCard(intent, { summary: `A working markdown pack for *${opp?.title ?? o}* — the opportunity, requirements, current draft, and live-re-read evidence.`, etaSeconds: 20 }),
    });
    await db.setIntentMessage(intent.id, posted.ts);
  }

  async function doExportAnswers({ o, teamId, channel, thread_ts, requestedBy }) {
    const intent = await db.createIntent(teamId, { kind: 'answers', params: { opp_id: o }, requested_by: requestedBy, channel_id: channel });
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    const posted = await app.client.chat.postMessage({
      channel, thread_ts, text: 'Ready to build copy-ready answers',
      blocks: confirmCard(intent, { summary: `Copy-ready application answers for *${opp?.title ?? o}*, built from the checklist and current draft.`, etaSeconds: 25 }),
    });
    await db.setIntentMessage(intent.id, posted.ts);
  }

  async function openSharePicker(client, { o, channel, user, thread_ts }) {
    await client.chat.postEphemeral({
      channel, user, thread_ts, text: 'Share to which channel?',
      blocks: [{ type: 'actions', elements: [{ type: 'conversations_select', action_id: 'gw:pipe:share:pick',
        placeholder: { type: 'plain_text', text: 'Pick a channel' }, filter: { include: ['public'] } }] }],
    });
    pendingShare.set(`${channel}:${user}`, { o, thread_ts });
  }

  // ── Legacy Phase-1 ids — kept working, thread_ts fix applied ─────────
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
        channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
        text: `➕ Added *${details.title}* to your pipeline (Reviewing). See it on my Home tab.`,
      });
    } catch (e) {
      console.error('[pipeline_add]', e?.message ?? e);
      await client.chat.postEphemeral({
        channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
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
      channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
      text: "💾 Evidence pointer saved — I'll re-read it live whenever we draft.",
    });
  });

  app.action('opp_details', async ({ ack, action, body, client }) => {
    await ack();
    const d = await grantsGov.fetchOpportunity(action.value);
    await client.chat.postMessage({
      channel: body.channel.id, thread_ts: replyTarget(body),
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

  // ── gw:grant:* ─────────────────────────────────────────────────────
  app.action('gw:grant:add', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const teamId = body.team.id, thread_ts = replyTarget(body);
    try {
      const d = await grantsGov.fetchOpportunity(o);
      await db.addOpportunity(teamId, {
        opp_id: o, opp_number: d.opp_number, title: d.title, agency: d.agency,
        close_date: d.close_date, award_ceiling: d.award_ceiling,
        url: `https://grants.gov/search-results-detail/${o}`, added_by: body.user.id,
      });
      syncOpportunityToList(client, teamId, { opp_id: o, ...d, stage: 'reviewing' }).catch(() => {});
      await client.chat.postMessage({
        channel: body.channel.id, thread_ts,
        text: `➕ Added *${d.title}* to your pipeline (Reviewing). See it on my Home tab.`,
      });
    } catch (e) {
      console.error('[gw:grant:add]', e?.message ?? e);
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts,
        text: "I couldn't add that just now (Grants.gov hiccup). Try again in a minute. 🧶" });
    }
  });

  app.action('gw:grant:details', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const d = await grantsGov.fetchOpportunity(o);
    await client.chat.postMessage({
      channel: body.channel.id, thread_ts: replyTarget(body),
      text: `Details: ${d.title}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn',
        text: `*${d.title}*\n*Agency:* ${d.agency ?? '—'} · *Ceiling:* $${Number(d.award_ceiling ?? 0).toLocaleString()} · *Closes:* ${d.close_date ?? '—'}\n\n*Eligibility:* ${(d.eligibility ?? '—').slice(0, 500)}\n\n${(d.synopsis ?? '').slice(0, 900)}` } }],
    });
  });

  // All of grantCardV2's tail actions (Why/Watch/Not relevant/Share) live in
  // one overflow menu (docs/23 §2.1) — one action_id, dispatched by the
  // option's embedded `v`. "View on Grants.gov" opens via the option's own
  // `url` and never reaches here.
  app.action('gw:grant:overflow', async ({ ack, action, body, client }) => {
    await ack();
    const { o, v } = JSON.parse(action.selected_option.value);
    const teamId = body.team.id, thread_ts = replyTarget(body);
    if (v === 'gw:grant:why') {
      const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
      await client.chat.postMessage({ channel: body.channel.id, thread_ts,
        text: opp?.fit_rationale || opp?.match_reason
          ? `*Why this match:* ${opp.fit_rationale ?? opp.match_reason}`
          : "I haven't scored this one in detail yet — add it to the pipeline and ask me again." });
    } else if (v === 'gw:grant:watch') {
      await db.addWatch(teamId, { kind: 'opp', params: { opp_id: o }, created_by: body.user.id });
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts,
        text: "🔮 Watching this one — I'll flag it if it opens or new similar matches appear." });
    } else if (v === 'gw:grant:not_relevant') {
      await openNotRelevantModal(client, { trigger_id: body.trigger_id, o, channel: body.channel.id, thread_ts });
    } else if (v === 'gw:grant:share') {
      await openSharePicker(client, { o, channel: body.channel.id, user: body.user.id, thread_ts });
    }
  });

  app.view('gw_not_relevant_submit', async ({ ack, body, view, client }) => {
    await ack();
    const { o, channel, thread_ts } = JSON.parse(view.private_metadata || '{}');
    const reason = view.state.values.reason.value.selected_option?.value ?? 'Other (tell me)';
    const otherText = view.state.values.other_text?.value?.value;
    await db.addSignal(body.team.id, { kind: 'not_relevant', subject: o, detail: otherText ? `${reason}: ${otherText}` : reason });
    await client.chat.postEphemeral({ channel, user: body.user.id, thread_ts,
      text: "Noted — I'll steer away from grants like this. I learn from every one of these." });
  });

  app.action('gw:grant:share:pick', async ({ ack, action, body, client }) => {
    await ack();
    const key = `${body.channel.id}:${body.user.id}`;
    const pending = pendingShare.get(key);
    pendingShare.delete(key);
    if (!pending) return;
    const target = action.selected_conversation;
    const d = await grantsGov.fetchOpportunity(pending.o);
    await client.chat.postMessage({
      channel: target, text: `Shared: ${d.title}`,
      blocks: shareCard({ title: d.title, agency: d.agency, url: `https://grants.gov/search-results-detail/${pending.o}`, sharedBy: body.user.id }),
    }).catch((e) => console.warn('[gw:grant:share]', e?.data?.error ?? e.message));
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: pending.thread_ts,
      text: `Shared to <#${target}>. 🧶` });
  });

  // ── gw:pipe:* ──────────────────────────────────────────────────────
  app.action('gw:pipe:draft', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const teamId = body.team.id, thread_ts = replyTarget(body);
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    const intent = await db.createIntent(teamId, { kind: 'draft', params: { opp_id: o }, requested_by: body.user.id, channel_id: body.channel.id });
    const posted = await client.chat.postMessage({
      channel: body.channel.id, thread_ts, text: 'Ready to draft',
      blocks: confirmCard(intent, { summary: `LOI for *${opp?.title ?? o}* — I'll gather fresh evidence and write it into the opportunity's canvas.`, etaSeconds: 40 }),
    });
    await db.setIntentMessage(intent.id, posted.ts);
  });

  app.action('gw:pipe:stage', async ({ ack, action, body, client }) => {
    await ack();
    const { o, stage } = JSON.parse(action.selected_option.value);
    const teamId = body.team.id;
    await db.moveOpportunity(teamId, o, stage);
    await db.logActivity(teamId, o, { actor: body.user.id, kind: 'stage_move', summary: `Stage → ${stage} (moved by <@${body.user.id}>)` });
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    if (opp) syncOpportunityToList(client, teamId, opp).catch(() => {});
    await client.chat.postMessage({ channel: body.channel.id, thread_ts: replyTarget(body),
      text: `Moved *${opp?.title ?? o}* → _${stage}_.` });
  });

  app.action('gw:pipe:owner', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const thread_ts = replyTarget(body);
    await client.chat.postEphemeral({
      channel: body.channel.id, user: body.user.id, thread_ts,
      text: 'Assign to whom?',
      blocks: [{ type: 'actions', elements: [{ type: 'users_select', action_id: 'gw:pipe:owner:pick',
        placeholder: { type: 'plain_text', text: 'Pick a teammate' } }] }],
    });
    pendingOwner.set(`${body.channel.id}:${body.user.id}`, { o, thread_ts });
  });

  app.action('gw:pipe:owner:pick', async ({ ack, action, body, client }) => {
    await ack();
    const key = `${body.channel.id}:${body.user.id}`;
    const pending = pendingOwner.get(key);
    pendingOwner.delete(key);
    if (!pending) return;
    const teamId = body.team.id;
    const newOwner = action.selected_user;
    await db.setOwner(teamId, pending.o, newOwner);
    await db.logActivity(teamId, pending.o, { actor: body.user.id, kind: 'owner', summary: `Assigned to <@${newOwner}> by <@${body.user.id}>` });
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(pending.o));
    await client.chat.postMessage({ channel: body.channel.id, thread_ts: pending.thread_ts,
      text: `Assigned *${opp?.title ?? pending.o}* to <@${newOwner}>.` });
    await client.chat.postMessage({
      channel: newOwner,
      text: `You're now the owner of *${opp?.title ?? pending.o}*${opp?.close_date ? ` (closes ${opp.close_date})` : ''} — assigned by <@${body.user.id}>. I'll nudge you if it goes quiet, and you can always ask me where it stands.`,
    }).catch(() => {});
  });

  app.action('gw:pipe:canvas', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const opp = (await db.listOpportunities(body.team.id)).find((x) => x.opp_id === String(o));
    if (!opp?.canvas_id) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
        text: "No draft exists yet — ask me to draft it and I'll create the canvas." });
      return;
    }
    await client.chat.postMessage({ channel: body.channel.id, thread_ts: replyTarget(body),
      text: `📄 Canvas for *${opp.title}*: ${await canvasLink(client, opp.canvas_id)}` });
  });

  app.action('gw:pipe:activity', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const rows = await db.listActivity(body.team.id, o, 10);
    await client.chat.postMessage({
      channel: body.channel.id, thread_ts: replyTarget(body),
      text: rows.length
        ? rows.map((r) => `• ${new Date(r.at).toLocaleDateString('en-US')} — ${r.summary}`).join('\n')
        : '_No activity logged yet._',
    });
  });

  app.action('gw:pipe:export', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    await client.chat.postEphemeral({
      channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
      text: 'Export what?',
      blocks: [{ type: 'actions', elements: [
        { type: 'button', action_id: 'gw:export:md', value: JSON.stringify({ o }),
          text: { type: 'plain_text', text: '📦 .md pack' }, accessibility_label: 'Export a working markdown pack' },
        { type: 'button', action_id: 'gw:export:answers', value: JSON.stringify({ o }),
          text: { type: 'plain_text', text: '📋 Copy-ready answers' }, accessibility_label: 'Export copy-ready application answers' },
        { type: 'button', action_id: 'gw:export:share', value: JSON.stringify({ o }),
          text: { type: 'plain_text', text: '📣 Share to channel' }, accessibility_label: 'Share this opportunity to a channel' },
      ] }],
    });
  });

  app.action('gw:pipe:remove', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const teamId = body.team.id;
    await db.moveOpportunity(teamId, o, 'declined');
    await db.logActivity(teamId, o, { actor: body.user.id, kind: 'stage_move', summary: `Removed (declined) by <@${body.user.id}>` });
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
      text: 'Removed from the active pipeline (kept as declined, never deleted).' });
  });

  // ── gw:draft:* ─────────────────────────────────────────────────────
  app.action('gw:draft:revise', async ({ ack, action, body, client }) => {
    await ack();
    await client.chat.postMessage({
      channel: body.channel.id, thread_ts: replyTarget(body),
      text: "What should change? Tell me here — everyone in this thread can pile on requests. When you're done, hit *Apply changes* and I'll confirm the scope before I touch the draft.",
    });
  });

  async function markReadyOrWarn({ o, teamId, channel, thread_ts, actor }) {
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    const unchecked = (opp?.checklist ?? []).filter((c) => !c.done);
    if (unchecked.length) {
      await app.client.chat.postMessage({ channel, thread_ts,
        text: `Still open before this is ready:\n${unchecked.map((c) => `• ${c.label}`).join('\n')}` });
      return;
    }
    await db.moveOpportunity(teamId, o, 'submitted');
    await db.logActivity(teamId, o, { actor, kind: 'stage_move', summary: 'Marked ready → submitted' });
    await app.client.chat.postMessage({ channel, thread_ts, text: `🎉 Marked *${opp?.title ?? o}* as submitted. Nice work.` });
  }

  app.action('gw:draft:ready', async ({ ack, action, body }) => {
    await ack();
    const { o } = val(action);
    await markReadyOrWarn({ o, teamId: body.team.id, channel: body.channel.id, thread_ts: replyTarget(body), actor: body.user.id });
  });

  // draftCard's overflow: Mark ready · Export .md pack · Copy-ready answers · Share to channel
  app.action('gw:draft:overflow', async ({ ack, action, body, client }) => {
    await ack();
    const { o, v } = JSON.parse(action.selected_option.value);
    const teamId = body.team.id, channel = body.channel.id, thread_ts = replyTarget(body), requestedBy = body.user.id;
    if (v === 'gw:draft:ready') await markReadyOrWarn({ o, teamId, channel, thread_ts, actor: requestedBy });
    else if (v === 'gw:export:md') await doExportMd({ o, teamId, channel, thread_ts, requestedBy });
    else if (v === 'gw:export:answers') await doExportAnswers({ o, teamId, channel, thread_ts, requestedBy });
    else if (v === 'gw:export:share') await openSharePicker(client, { o, channel, user: requestedBy, thread_ts });
  });

  // ── gw:ev:* ────────────────────────────────────────────────────────
  app.action('gw:ev:save', async ({ ack, action, body, client }) => {
    await ack();
    const { c, ts, tag, link } = JSON.parse(action.value);
    await db.saveEvidence(body.team.id, { channel_id: c, message_ts: ts, permalink: link ?? '', tag: tag ?? 'story', saved_by: body.user.id });
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
      text: "💾 Evidence pointer saved — I'll re-read it live whenever we draft." });
  });

  app.action('gw:ev:link', async ({ ack, action, body, client }) => {
    await ack();
    const { c, ts, o } = JSON.parse(action.selected_option.value);
    await db.linkEvidenceToOpp(body.team.id, c, ts, o);
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
      text: '🔗 Linked to that opportunity.' });
  });

  app.action('gw:ev:overflow', async ({ ack, action, body, client }) => {
    await ack();
    const { c, ts, v, s } = JSON.parse(action.selected_option.value);
    if (s) {
      await db.setEvidenceStrength(body.team.id, c, ts, s);
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
        text: `Marked as *${s}* evidence.` });
    } else if (v === 'remove') {
      await db.pool.query('DELETE FROM evidence_pointers WHERE team_id=$1 AND channel_id=$2 AND message_ts=$3', [body.team.id, c, ts]);
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body), text: 'Removed.' });
    } else if (v === 'retag') {
      await client.chat.postEphemeral({
        channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
        text: 'Retag as:',
        blocks: [{ type: 'actions', elements: ['metric', 'story', 'testimonial', 'other'].map((t) => ({
          type: 'button', action_id: `evidence_tag:${t}`, value: JSON.stringify({ channel: c, ts, tag: t }),
          text: { type: 'plain_text', text: t }, accessibility_label: `Tag this evidence as ${t}`,
        })) }],
      });
    }
  });

  // ── gw:intent:* (confirm-before-generate, docs/23 §5) ────────────────
  app.action('gw:intent:confirm', async ({ ack, action, body, client }) => {
    await ack();
    const { i } = val(action);
    const row = await db.claimIntent(i);
    if (!row) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
        text: 'Already on it — progress is streaming above.' });
      return;
    }
    await markCardRunning(client, row);
    await runIntent(client, row);
  });

  app.action('gw:intent:scope', async ({ ack, action, body, client }) => {
    await ack();
    await client.chat.postEphemeral({
      channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
      text: "Reply here with what to change (which evidence to use, sections to emphasize) and ask me again — I'll re-line-up the card with the new scope.",
    });
  });

  app.action('gw:intent:cancel', async ({ ack, action, body, client }) => {
    await ack();
    const { i } = val(action);
    const intent = await db.getIntentByMessage(body.channel.id, body.message?.ts);
    await db.finishIntent(i, 'cancelled');
    if (intent) await markCardCancelled(client, intent);
  });

  // ── gw:export:* (docs/23 §7 — entry points from the pipe:export menu) ─
  app.action('gw:export:md', async ({ ack, action, body }) => {
    await ack();
    const { o } = val(action);
    await doExportMd({ o, teamId: body.team.id, channel: body.channel.id, thread_ts: replyTarget(body), requestedBy: body.user.id });
  });

  app.action('gw:export:answers', async ({ ack, action, body }) => {
    await ack();
    const { o } = val(action);
    await doExportAnswers({ o, teamId: body.team.id, channel: body.channel.id, thread_ts: replyTarget(body), requestedBy: body.user.id });
  });

  app.action('gw:export:share', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    await openSharePicker(client, { o, channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body) });
  });

  app.action('gw:pipe:share:pick', async ({ ack, action, body, client }) => {
    await ack();
    const key = `${body.channel.id}:${body.user.id}`;
    const pending = pendingShare.get(key);
    pendingShare.delete(key);
    if (!pending) return;
    const teamId = body.team.id;
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(pending.o));
    const target = action.selected_conversation;
    await client.chat.postMessage({
      channel: target, text: `Shared: ${opp?.title ?? pending.o}`,
      blocks: shareCard({ title: opp?.title ?? pending.o, agency: opp?.agency, canvasUrl: opp?.canvas_id ? await canvasLink(client, opp.canvas_id) : opp?.url, sharedBy: body.user.id }),
    }).catch((e) => console.warn('[gw:pipe:share]', e?.data?.error ?? e.message));
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: pending.thread_ts, text: `Shared to <#${target}>. 🧶` });
  });
}
