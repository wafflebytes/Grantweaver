import { db } from '../services/db.js';
import { grantsGov } from '../mcp/grantsgov-client.js';
import { syncOpportunityToList } from '../services/lists.js';
import { runIntent, markCardRunning, markCardCancelled } from '../agent/intents.js';
import { addOpportunityFull } from '../agent/tools.js';
import { refreshOverviewAndRequirements } from '../services/canvas.js';
import { confirmCard, shareCard, money, fmtDate } from './cards.js';
import { buildFeedbackBlocks } from './blocks.js';
import '../services/exportpack.js'; // side effect: registers the export_pack/answers intent executors
import { openRevisionThread } from '../agent/revise.js'; // also registers the 'revise' intent executor as a side effect

// Every channel follow-up threads under the triggering message
// — this exact line is the fix for "view more should land in the same
// thread." Applies to legacy handlers too.
const replyTarget = (body) => body.message?.thread_ts ?? body.message?.ts;
const val = (action) => JSON.parse(action.value || '{}');

// Live-reported UX gap: clicking Add-to-pipeline/Watch gave feedback only
// as a NEW message in the thread, leaving the clicked button sitting there
// looking un-acted-on. Edit the original card in place instead — the
// button that was clicked relabels itself (e.g. "✅ Added") and stops being
// primary-styled, so the card itself carries the state instead of the user
// having to scroll down for confirmation. Only works on messages the bot
// itself posted (chat.update requires the posting identity); silently
// no-ops otherwise rather than erroring the whole action.
async function markButtonDone(client, body, actionId, newLabel) {
  if (!body.message?.blocks) return;
  const blocks = body.message.blocks.map((b) => {
    if (b.type !== 'actions') return b;
    return {
      ...b,
      elements: b.elements.map((el) => (el.action_id === actionId
        ? { ...el, text: { ...el.text, text: newLabel }, style: undefined }
        : el)),
    };
  });
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, blocks, text: body.message.text }).catch(() => {});
}
const NOT_RELEVANT_REASONS = ['Wrong focus area', 'Award too large for us', 'Award too small', "We're not eligible", 'Other (tell me)'];
const ADD_STAGES = [
  { value: 'reviewing', label: 'Reviewing — still deciding whether to pursue this' },
  { value: 'drafting', label: "Drafting — we're writing the proposal now" },
  { value: 'submitted', label: 'Submitted — already sent, just logging it' },
];

// Live-reported ask: clicking "Add to pipeline" always silently landed the
// grant in Reviewing with no way to say "actually we're already drafting
// this." A modal is worth the extra click here since the answer changes
// what happens next (drafting auto-fires the draft-proposal confirm card).
async function openAddStageModal(client, { trigger_id, o, channel, thread_ts }) {
  await client.views.open({
    trigger_id,
    view: {
      type: 'modal', callback_id: 'gw_add_stage_submit',
      private_metadata: JSON.stringify({ o, channel, thread_ts }),
      title: { type: 'plain_text', text: 'Add to pipeline' },
      submit: { type: 'plain_text', text: 'Add' }, close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'input', block_id: 'stage', label: { type: 'plain_text', text: 'Where does this stand?' },
          element: { type: 'radio_buttons', action_id: 'value', initial_option:
            { text: { type: 'plain_text', text: ADD_STAGES[0].label }, value: ADD_STAGES[0].value },
            options: ADD_STAGES.map((s) => ({ text: { type: 'plain_text', text: s.label }, value: s.value })) } },
      ],
    },
  });
}

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

  // Live-reported UX complaint: this used to post an ephemeral chat message
  // with an inline channel picker, which reads as "the bot is talking in the
  // channel" rather than a deliberate share action. A modal keeps the choice
  // off-record until the user actually confirms it.
  async function openSharePicker(client, { trigger_id, o, channel, thread_ts }) {
    await client.views.open({
      trigger_id,
      view: {
        type: 'modal', callback_id: 'gw_share_pick_submit',
        private_metadata: JSON.stringify({ o, channel, thread_ts }),
        title: { type: 'plain_text', text: 'Share to channel' },
        submit: { type: 'plain_text', text: 'Share' }, close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          { type: 'input', block_id: 'target', label: { type: 'plain_text', text: 'Which channel?' },
            element: { type: 'conversations_select', action_id: 'value', filter: { include: ['public'] } } },
        ],
      },
    });
  }

  // ── Legacy Phase-1 ids — kept working, thread_ts fix applied ─────────
  app.action('pipeline_add', async ({ ack, action, body, client }) => {
    await ack();
    try {
      const details = await grantsGov.fetchOpportunity(action.value);
      // Was calling db.addOpportunity directly — bypassed canvas creation,
      // checklist/fit scoring, AND the List sync entirely (a live-reported
      // sync-audit gap: this legacy button, still live on old cards, left
      // an opportunity with none of the setup every other add path gives).
      await addOpportunityFull(client, body.team.id, {
        opp_id: action.value, opp_number: details.opp_number, title: details.title,
        agency: details.agency, close_date: details.close_date,
        award_ceiling: details.award_ceiling,
        url: `https://grants.gov/search-results-detail/${action.value}`,
        added_by: body.user.id, channelId: body.channel.id,
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
    await openAddStageModal(client, { trigger_id: body.trigger_id, o, channel: body.channel.id, thread_ts: replyTarget(body) });
  });

  app.view('gw_add_stage_submit', async ({ ack, body, view, client }) => {
    await ack();
    const { o, channel, thread_ts } = JSON.parse(view.private_metadata || '{}');
    const stage = view.state.values.stage.value.selected_option?.value ?? 'reviewing';
    const teamId = body.team.id;
    try {
      const d = await grantsGov.fetchOpportunity(o);
      await addOpportunityFull(client, teamId, {
        opp_id: o, opp_number: d.opp_number, title: d.title, agency: d.agency,
        close_date: d.close_date, award_ceiling: d.award_ceiling,
        url: `https://grants.gov/search-results-detail/${o}`, added_by: body.user.id,
        channelId: channel,
      });
      if (stage !== 'reviewing') {
        await db.moveOpportunity(teamId, o, stage);
        // addOpportunityFull already synced the List row once, at the default
        // Reviewing stage — re-sync now the stage actually changed, or the
        // List keeps showing Reviewing until something else touches this row.
        const moved = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
        if (moved) syncOpportunityToList(client, teamId, moved).catch(() => {});
      }
      const stageLabel = stage[0].toUpperCase() + stage.slice(1);
      await client.chat.postMessage({
        channel, thread_ts,
        text: `➕ Added *${d.title}* to your pipeline (${stageLabel}) — canvas created, checklist + fit filling in. See it on my Home tab.`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `➕ Added *${d.title}* to your pipeline (${stageLabel}) — canvas created, checklist + fit filling in. See it on my Home tab.` } }, ...buildFeedbackBlocks()],
      });
      // Closes the loop: moving straight to Drafting shouldn't require a
      // separate ask — fire the same confirm-before-generate card the
      // pipeline's "Draft proposal" button uses, right away.
      if (stage === 'drafting') {
        const intent = await db.createIntent(teamId, { kind: 'draft', params: { opp_id: o }, requested_by: body.user.id, channel_id: channel });
        const posted = await client.chat.postMessage({
          channel, thread_ts, text: 'Ready to draft',
          blocks: confirmCard(intent, { summary: `LOI for *${d.title}* — I'll gather fresh evidence and write it into the opportunity's canvas.`, etaSeconds: 40 }),
        });
        await db.setIntentMessage(intent.id, posted.ts);
      }
    } catch (e) {
      console.error('[gw:grant:add]', e?.message ?? e);
      await client.chat.postMessage({ channel, thread_ts,
        text: "I couldn't add that just now (Grants.gov hiccup). Try again in a minute. 🧶" });
    }
  });

  app.action('gw:grant:details', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const channel = body.channel.id, thread_ts = replyTarget(body);
    // Live-reported bug: this had NO error handling — a Grants.gov hiccup
    // threw after ack() and the user just saw nothing happen, which reads
    // as "sometimes unreliable, only shows half the info" when it's really
    // an unhandled failure some of the time. Also missing the actual
    // Grants.gov link and truncating synopsis/eligibility far below
    // Slack's 3000-char section limit for no reason.
    let d;
    try { d = await grantsGov.fetchOpportunity(o); }
    catch (e) {
      console.error('[gw:grant:details]', e?.message ?? e);
      await client.chat.postMessage({ channel, thread_ts,
        text: "Couldn't pull full details just now (Grants.gov hiccup) — try again in a minute. 🧶" });
      return;
    }
    await client.chat.postMessage({
      channel, thread_ts,
      text: `Details: ${d.title}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn',
        text: `*${d.title}*\n*Agency:* ${d.agency ?? '—'} · *Ceiling:* ${money(d.award_ceiling)} · *Closes:* ${fmtDate(d.close_date) ?? '—'}\n\n*Eligibility:* ${(d.eligibility || '—').slice(0, 1200)}\n\n${(d.synopsis || 'No synopsis provided.').slice(0, 2200)}` } },
        ...(d.url ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `<${d.url}|View on Grants.gov>` }] }] : []),
      ],
    });
  });

  // All of grantCardV2's tail actions (Why/Watch/Not relevant/Share) live in
  // one overflow menu — one action_id, dispatched by the
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
      await openSharePicker(client, { trigger_id: body.trigger_id, o, channel: body.channel.id, thread_ts });
    }
  });

  // forecastCard's primary button emits gw:grant:watch directly (the same
  // logical action also reachable via gw:grant:overflow's Watch option).
  app.action('gw:grant:watch', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    await db.addWatch(body.team.id, { kind: 'opp', params: { opp_id: o }, created_by: body.user.id });
    await markButtonDone(client, body, 'gw:grant:watch', '🔮 Watching');
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
      text: "🔮 Watching this one — I'll flag it if it opens or new similar matches appear." });
  });

  // URL buttons (open canvas / open shared link) — Slack opens the URL
  // client-side; these acks just stop Bolt logging an unhandled-action error.
  app.action('gw:draft:open', async ({ ack }) => { await ack(); });
  app.action('gw:share:open', async ({ ack }) => { await ack(); });

  app.view('gw_not_relevant_submit', async ({ ack, body, view, client }) => {
    await ack();
    const { o, channel, thread_ts } = JSON.parse(view.private_metadata || '{}');
    const reason = view.state.values.reason.value.selected_option?.value ?? 'Other (tell me)';
    const otherText = view.state.values.other_text?.value?.value;
    await db.addSignal(body.team.id, { kind: 'not_relevant', subject: o, detail: otherText ? `${reason}: ${otherText}` : reason });
    await client.chat.postEphemeral({ channel, user: body.user.id, thread_ts,
      text: "Noted — I'll steer away from grants like this. I learn from every one of these." });
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
    const teamId = body.team.id, channel = body.channel.id, thread_ts = replyTarget(body);
    const before = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    await db.moveOpportunity(teamId, o, stage);
    await db.logActivity(teamId, o, { actor: body.user.id, kind: 'stage_move', summary: `Stage → ${stage} (moved by <@${body.user.id}>)` });
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    if (opp) syncOpportunityToList(client, teamId, opp).catch(() => {});
    await client.chat.postMessage({
      channel, thread_ts, text: `Moved *${opp?.title ?? o}* → _${stage}_.`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `Moved *${opp?.title ?? o}* → _${stage}_.` } }, ...buildFeedbackBlocks()],
    });
    // Same auto-draft as the add-to-pipeline modal — moving INTO drafting
    // (not already there) fires the draft confirm card right away.
    if (stage === 'drafting' && before?.stage !== 'drafting') {
      const intent = await db.createIntent(teamId, { kind: 'draft', params: { opp_id: o }, requested_by: body.user.id, channel_id: channel });
      const posted = await client.chat.postMessage({
        channel, thread_ts, text: 'Ready to draft',
        blocks: confirmCard(intent, { summary: `LOI for *${opp?.title ?? o}* — I'll gather fresh evidence and write it into the opportunity's canvas.`, etaSeconds: 40 }),
      });
      await db.setIntentMessage(intent.id, posted.ts);
    }
  });

  async function askOwnerPick(client, { o, channel, user, thread_ts }) {
    await client.chat.postEphemeral({
      channel, user, thread_ts,
      text: 'Assign to whom?',
      blocks: [{ type: 'actions', elements: [{ type: 'users_select', action_id: 'gw:pipe:owner:pick',
        placeholder: { type: 'plain_text', text: 'Pick a teammate' } }] }],
    });
    pendingOwner.set(`${channel}:${user}`, { o, thread_ts });
  }

  app.action('gw:pipe:owner', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    await askOwnerPick(client, { o, channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body) });
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
    if (opp) {
      syncOpportunityToList(client, teamId, opp).catch(() => {});
      refreshOverviewAndRequirements(client, teamId, opp).catch(() => {});
    }
    await client.chat.postMessage({ channel: body.channel.id, thread_ts: pending.thread_ts,
      text: `Assigned *${opp?.title ?? pending.o}* to <@${newOwner}>.` });
    await client.chat.postMessage({
      channel: newOwner,
      text: `You're now the owner of *${opp?.title ?? pending.o}*${opp?.close_date ? ` (closes ${opp.close_date})` : ''} — assigned by <@${body.user.id}>. I'll nudge you if it goes quiet, and you can always ask me where it stands.`,
    }).catch(() => {});
  });

  async function postCanvasLink(client, { o, teamId, channel, user, thread_ts }) {
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    if (!opp?.canvas_id) {
      await client.chat.postEphemeral({ channel, user, thread_ts,
        text: "No draft exists yet — ask me to draft it and I'll create the canvas." });
      return;
    }
    await client.chat.postMessage({ channel, thread_ts,
      text: `📄 Canvas for *${opp.title}*: ${await canvasLink(client, opp.canvas_id)}` });
  }

  async function postActivity(client, { o, teamId, channel, thread_ts }) {
    const rows = await db.listActivity(teamId, o, 10);
    await client.chat.postMessage({
      channel, thread_ts,
      text: rows.length
        ? rows.map((r) => `• ${new Date(r.at).toLocaleDateString('en-US')} — ${r.summary}`).join('\n')
        : '_No activity logged yet._',
    });
  }

  async function openExportMenu(client, { o, channel, user, thread_ts }) {
    await client.chat.postEphemeral({
      channel, user, thread_ts,
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
  }

  async function removeOpp(client, { o, teamId, channel, user, thread_ts }) {
    await db.moveOpportunity(teamId, o, 'declined');
    await db.logActivity(teamId, o, { actor: user, kind: 'stage_move', summary: `Removed (declined) by <@${user}>` });
    const declined = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    if (declined) syncOpportunityToList(client, teamId, declined).catch(() => {});
    await client.chat.postEphemeral({ channel, user, thread_ts,
      text: 'Removed from the active pipeline (kept as declined, never deleted).' });
  }

  app.action('gw:pipe:canvas', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    await postCanvasLink(client, { o, teamId: body.team.id, channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body) });
  });

  app.action('gw:pipe:activity', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    await postActivity(client, { o, teamId: body.team.id, channel: body.channel.id, thread_ts: replyTarget(body) });
  });

  app.action('gw:pipe:export', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    await openExportMenu(client, { o, channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body) });
  });

  app.action('gw:pipe:remove', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    await removeOpp(client, { o, teamId: body.team.id, channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body) });
  });

  // pipelineCard's tail actions live in one overflow menu — one action_id,
  // dispatched by the option's embedded `v` (same pattern as gw:grant:overflow).
  app.action('gw:pipe:overflow', async ({ ack, action, body, client }) => {
    await ack();
    const { o, v } = JSON.parse(action.selected_option.value);
    const common = { o, teamId: body.team.id, channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body) };
    if (v === 'gw:pipe:owner') await askOwnerPick(client, { o, channel: common.channel, user: common.user, thread_ts: common.thread_ts });
    else if (v === 'gw:pipe:canvas') await postCanvasLink(client, common);
    else if (v === 'gw:pipe:export') await openExportMenu(client, common);
    else if (v === 'gw:pipe:activity') await postActivity(client, common);
    else if (v === 'gw:pipe:remove') await removeOpp(client, common);
  });

  // ── gw:draft:* ─────────────────────────────────────────────────────
  app.action('gw:draft:revise', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const teamId = body.team.id;
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    if (!opp?.canvas_id) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
        text: "There's no draft yet — ask me to draft it first." });
      return;
    }
    await openRevisionThread(client, { teamId, channel: body.channel.id, thread_ts: replyTarget(body), opp });
  });

  app.action('gw:draft:revise:apply', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    const teamId = body.team.id, thread_ts = replyTarget(body), channel = body.channel.id;
    const opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    const intent = await db.createIntent(teamId, {
      kind: 'revise',
      params: { opp_id: o, thread_channel: channel, thread_ts },
      requested_by: body.user.id, channel_id: channel,
    });
    const posted = await client.chat.postMessage({
      channel, thread_ts, text: 'Ready to weave in the changes',
      blocks: confirmCard(intent, { summary: `I'll re-read this thread's requests and revise *${opp?.title ?? o}*'s Draft section in place.`, etaSeconds: 25 }),
    });
    await db.setIntentMessage(intent.id, posted.ts);
  });

  app.action('gw:draft:revise:nevermind', async ({ ack, action, body, client }) => {
    await ack();
    const { o } = val(action);
    await client.chat.postMessage({ channel: body.channel.id, thread_ts: replyTarget(body),
      text: `No changes applied to *${o}*'s draft. Ping me again whenever.` });
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
    // Closes the loop everywhere the pipeline shows up: the List row and the
    // canvas's own overview section, not just the DB the Home tab/org page
    // already read live.
    const moved = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    if (moved) {
      await syncOpportunityToList(app.client, teamId, moved).catch(() => {});
      await refreshOverviewAndRequirements(app.client, teamId, moved).catch(() => {});
    }
    await app.client.chat.postMessage({
      channel, thread_ts, text: `🎉 Marked *${opp?.title ?? o}* as submitted. Nice work.`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `🎉 Marked *${opp?.title ?? o}* as submitted. Nice work.` } }, ...buildFeedbackBlocks()],
    });
  }

  app.action('gw:draft:ready', async ({ ack, action, body }) => {
    await ack();
    const { o } = val(action);
    await markReadyOrWarn({ o, teamId: body.team.id, channel: body.channel.id, thread_ts: replyTarget(body), actor: body.user.id });
  });

  app.action('gw:draft:submit', async ({ ack, action, body }) => {
    await ack();
    const { o } = val(action);
    await markReadyOrWarn({ o, teamId: body.team.id, channel: body.channel.id, thread_ts: replyTarget(body), actor: body.user.id });
  });

  // draftCard's overflow: Export .md pack · Copy-ready answers · Share to channel
  app.action('gw:draft:overflow', async ({ ack, action, body, client }) => {
    await ack();
    const { o, v } = JSON.parse(action.selected_option.value);
    const teamId = body.team.id, channel = body.channel.id, thread_ts = replyTarget(body), requestedBy = body.user.id;
    if (v === 'gw:export:md') await doExportMd({ o, teamId, channel, thread_ts, requestedBy });
    else if (v === 'gw:export:answers') await doExportAnswers({ o, teamId, channel, thread_ts, requestedBy });
    else if (v === 'gw:export:share') await openSharePicker(client, { trigger_id: body.trigger_id, o, channel, thread_ts });
  });

  // ── gw:ev:* ────────────────────────────────────────────────────────
  app.action('gw:ev:save', async ({ ack, action, body, client }) => {
    await ack();
    const { c, ts, tag, link, f } = JSON.parse(action.value);
    await db.saveEvidence(body.team.id, { channel_id: c, message_ts: ts, permalink: link ?? '', tag: tag ?? 'story', is_file: Boolean(f), saved_by: body.user.id });
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

  // ── gw:intent:* (confirm-before-generate) ────────────────────────────
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

  const DRAFT_SECTIONS = ['Statement of Need', 'Our Program', 'Evidence of Impact', 'Funding Request', 'About Org'];

  app.action('gw:intent:scope', async ({ ack, action, body, client }) => {
    await ack();
    const { i } = val(action);
    const intent = await db.getIntent(i);
    if (!intent || intent.status !== 'pending') {
      await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, thread_ts: replyTarget(body),
        text: 'That one already ran (or expired) — ask me again and a fresh card will appear.' });
      return;
    }
    const locker = await db.listEvidence(body.team.id, 20);
    const evidenceOptions = locker.map((p) => ({
      text: { type: 'plain_text', text: `${p.tag ?? 'story'} · <#${p.channel_id}> · ${String(p.message_ts).split('.')[0]}`.slice(0, 75) },
      value: JSON.stringify({ c: p.channel_id, ts: p.message_ts }),
    }));
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal', callback_id: 'gw_intent_scope_submit',
        private_metadata: JSON.stringify({ i, channel: intent.channel_id, message_ts: intent.message_ts }),
        title: { type: 'plain_text', text: 'Change scope' },
        submit: { type: 'plain_text', text: 'Update' }, close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          ...(evidenceOptions.length ? [{
            type: 'input', block_id: 'evidence', optional: true,
            label: { type: 'plain_text', text: 'Pin specific evidence (from your locker)' },
            element: { type: 'multi_static_select', action_id: 'value',
              placeholder: { type: 'plain_text', text: 'Pick evidence to use' }, options: evidenceOptions },
          }] : []),
          { type: 'input', block_id: 'sections', optional: true,
            label: { type: 'plain_text', text: 'Emphasize sections' },
            element: { type: 'checkboxes', action_id: 'value',
              options: DRAFT_SECTIONS.map((s) => ({ text: { type: 'plain_text', text: s }, value: s })) } },
          { type: 'input', block_id: 'notes', optional: true,
            label: { type: 'plain_text', text: 'Anything else I should know?' },
            element: { type: 'plain_text_input', action_id: 'value', multiline: true,
              placeholder: { type: 'plain_text', text: 'e.g. lead with the attendance numbers; keep it under one page' } } },
        ],
      },
    });
  });

  app.view('gw_intent_scope_submit', async ({ ack, body, view, client }) => {
    await ack();
    const { i, channel, message_ts } = JSON.parse(view.private_metadata || '{}');
    const picked = view.state.values.evidence?.value?.selected_options ?? [];
    const evidence = picked.map((o) => JSON.parse(o.value));
    const sections = (view.state.values.sections?.value?.selected_options ?? []).map((o) => o.value);
    const notes = view.state.values.notes?.value?.value || undefined;
    const patch = {};
    if (evidence.length) patch.evidence = evidence;
    if (sections.length) patch.sections = sections;
    if (notes) patch.notes = notes;
    const intent = await db.mergeIntentParams(i, patch);
    if (!intent) return; // claimed/cancelled while the modal was open — the card already says so
    const bits = [
      evidence.length ? `*${evidence.length}* pinned evidence item${evidence.length === 1 ? '' : 's'}` : null,
      sections.length ? `emphasis on _${sections.join(', ')}_` : null,
      notes ? 'your extra notes' : null,
    ].filter(Boolean);
    const summary = `Scope updated — I'll use ${bits.join(' + ') || 'the default scope'}. Same plan otherwise.`;
    await client.chat.update({
      channel, ts: message_ts,
      text: 'Ready to weave (scope updated)',
      blocks: confirmCard(intent, { summary, etaSeconds: 40 }),
    }).catch((e) => console.warn('[gw:intent:scope]', e?.data?.error ?? e.message));
  });

  app.action('gw:intent:cancel', async ({ ack, action, body, client }) => {
    await ack();
    const { i } = val(action);
    const intent = await db.getIntentByMessage(body.channel.id, body.message?.ts);
    await db.finishIntent(i, 'cancelled');
    if (intent) await markCardCancelled(client, intent);
  });

  // ── gw:export:* (entry points from the pipe:export menu) ─────────────
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
    await openSharePicker(client, { trigger_id: body.trigger_id, o, channel: body.channel.id, thread_ts: replyTarget(body) });
  });

  // Merges what used to be two near-identical ephemeral-pick handlers
  // (gw:grant:share:pick, gw:pipe:share:pick) now that both routes fall
  // into the same modal — DB lookup first (has canvas/checklist context),
  // falling back to a live Grants.gov fetch so a shared card never reads as
  // just a bare opp_id (a live-reported bug in the old DB-miss path).
  app.view('gw_share_pick_submit', async ({ ack, body, view, client }) => {
    await ack();
    const { o, channel, thread_ts } = JSON.parse(view.private_metadata || '{}');
    const target = view.state.values.target.value.selected_conversation;
    const teamId = body.team.id;
    let opp = (await db.listOpportunities(teamId)).find((x) => x.opp_id === String(o));
    if (!opp?.title) {
      const d = await grantsGov.fetchOpportunity(o).catch(() => null);
      opp = { title: d?.title ?? `Opportunity #${o}`, agency: d?.agency, url: d?.url };
    }
    await client.chat.postMessage({
      channel: target, text: `Shared: ${opp.title}`,
      blocks: shareCard({ title: opp.title, agency: opp.agency, canvasUrl: opp.canvas_id ? await canvasLink(client, opp.canvas_id) : (opp.url ?? `https://grants.gov/search-results-detail/${o}`), sharedBy: body.user.id }),
    }).catch((e) => console.warn('[gw:share]', e?.data?.error ?? e.message));
    await client.chat.postEphemeral({ channel, user: body.user.id, thread_ts, text: `Shared to <#${target}>. 🧶` }).catch(() => {});
  });
}
