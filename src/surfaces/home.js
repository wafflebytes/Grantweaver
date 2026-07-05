import { db } from '../services/db.js';
import { orgLinkUrl } from '../services/weblink.js';
import { listLink, syncOpportunityToList } from '../services/lists.js';

const STAGES = [
  ['suggested', '🌱 Suggested'], ['reviewing', '🔍 Reviewing'], ['drafting', '✍️ Drafting'],
  ['submitted', '📮 Submitted'], ['awarded', '🏆 Awarded'], ['declined', '🗂 Declined'],
];

// Slack's own recommended way to hand a user off from a Home tab (which
// cannot itself switch a client to the DM/messages tab) into a real
// conversation with the app — the same app_redirect link the marketing
// site's "Open in Slack" button already uses.
const APP_ID = 'A0BESSN1JP8';
const ASK_URL = `https://slack.com/app_redirect?app=${APP_ID}`;

export function registerHome(app) {
  app.event('app_home_opened', async ({ event, client, context }) => {
    if (event.tab !== 'home') return;
    await publishHome(client, context.teamId, event.user);
  });

  app.action('home_refresh', async ({ ack, body, client }) => {
    await ack();
    await publishHome(client, body.team.id, body.user.id);
  });

  app.action(/^stage_move:/, async ({ ack, body, action, client }) => {
    await ack();
    const [oppId, stage] = action.selected_option.value.split('|');
    const teamId = body.team.id;
    const before = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(oppId));
    await db.moveOpportunity(teamId, oppId, stage);
    await db.logActivity(teamId, oppId, { actor: body.user.id, kind: 'stage_move', summary: `Home stage → ${stage}`, metadata: { previous_stage: before?.stage, new_stage: stage } });
    // Live gap found in review: this was the one stage-move surface that
    // never synced the List row — every other path (chat, modal, buttons)
    // already did.
    const moved = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(oppId));
    if (moved) syncOpportunityToList(client, teamId, moved).catch(() => {});
    await publishHome(client, teamId, body.user.id);
  });
}

export async function publishHome(client, teamId, userId) {
  if (!teamId) teamId = (await client.auth.test()).team_id;
  const [org, opps, evid, meter, intents, runs, audits] = await Promise.all([
    db.getOrg(teamId), db.listOpportunities(teamId), db.listEvidence(teamId, 5), db.impactMeter(teamId),
    db.listPendingIntents(teamId, 5).catch(() => []),
    db.listAgentRuns(teamId, 5).catch(() => []),
    db.listAuditEvents(teamId, 5).catch(() => []),
  ]);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `🧶 Grantweaver — ${org?.org_name ?? 'Set up your org'}` } },
    { type: 'actions', elements: [
      { type: 'button', action_id: 'home_refresh', text: { type: 'plain_text', text: '🔄 Refresh' },
        accessibility_label: 'Refresh this dashboard' },
      { type: 'button', action_id: 'open_setup', text: { type: 'plain_text', text: '⚙️ Settings' },
        accessibility_label: 'Open organization settings' },
      // Both used to fire a background action (one dead — no handler was
      // ever registered for open_assistant_hint; the other DM'd a link
      // instead of opening it) when Slack buttons support `url` directly.
      // A Home tab can't switch the client to the DM pane itself, so
      // app_redirect is the real mechanism, not a workaround.
      { type: 'button', url: ASK_URL, style: 'primary',
        text: { type: 'plain_text', text: '💬 Ask Grantweaver' },
        accessibility_label: 'Open the Grantweaver agent panel' },
      { type: 'button', url: orgLinkUrl(teamId), text: { type: 'plain_text', text: '📄 Evidence index' },
        accessibility_label: 'Open the web evidence index' },
      ...(org?.pipeline_list_id ? [{ type: 'button', url: await listLink(client, teamId, org.pipeline_list_id),
        text: { type: 'plain_text', text: '📋 Pipeline list' },
        accessibility_label: 'Open the pipeline Slack List' }] : []),
      ...(org?.evidence_list_id ? [{ type: 'button', url: await listLink(client, teamId, org.evidence_list_id),
        text: { type: 'plain_text', text: '📌 Evidence list' },
        accessibility_label: 'Open the evidence locker Slack List' }] : []),
    ]},
    { type: 'section', text: { type: 'mrkdwn',
      text: `*This quarter:* ${meter.surfaced} opportunities surfaced · $${meter.applied.toLocaleString()} applied for · ${meter.evidence} evidence items woven · est. *${meter.hoursSaved} hrs saved*` } },
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: '_Hours-saved math: 2h per draft + 30m per evidence item + 15m per match. Honest heuristic, no magic._' }] },
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: 'Workflow status' } },
    ...workflowBlocks(intents, runs, audits),
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '⏰ Upcoming deadlines' } },
    ...deadlineBlocks(opps),
    { type: 'divider' },
    ...(opps.length
      ? STAGES.flatMap(([key, label]) => stageBlocks(key, label, opps))
      : [{ type: 'section', text: { type: 'mrkdwn',
          text: '_Your pipeline is empty. Open my agent panel and try *“Find new grants that fit our mission.”*_' } }]),
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '🧶 Recent evidence' } },
    // File-backed evidence has no real channel — db.saveEvidence synthesizes
    // channel_id='file' for those rows so the unique constraint doesn't
    // collapse distinct files into one row. Slack can't resolve <#file> to a
    // real channel and renders it as a generic "#private-channel"
    // placeholder — show a file badge instead of a fake channel mention.
    ...(evid.length
      ? evid.map((e) => ({ type: 'section', text: { type: 'mrkdwn',
          text: `*${e.tag}* · ${e.channel_id && e.channel_id !== 'file' ? `<#${e.channel_id}>` : '📎 file'} · ${new Date(e.saved_at).toLocaleDateString('en-US')}${e.permalink ? ` · <${e.permalink}|view>` : ''}` } }))
      : [{ type: 'section', text: { type: 'mrkdwn',
          text: `_No evidence yet — react :${org?.evidence_emoji ?? 'thread'}: on any impactful message, or ask me to search the workspace._` } }]),
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: 'Grantweaver never stores your messages — evidence items are permalinks, re-read live from Slack when used. · <https://grantweaver.app/support|Support> · <https://grantweaver.app/privacy|Privacy>' }] },
  ];

  await client.views.publish({ user_id: userId, view: { type: 'home', blocks } });
}

function workflowBlocks(intents, runs, audits) {
  const blocks = [];
  const failed = runs.filter((r) => ['failure', 'partial', 'blocked'].includes(r.status)).slice(0, 3);
  const recent = runs.filter((r) => r.status === 'success').slice(0, 3);
  if (intents.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Pending confirmations*\n${intents.map((i) => `• ${i.kind} · ${i.status} · #${i.id}`).join('\n')}` } });
  }
  if (failed.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Needs attention*\n${failed.map((r) => `• ${r.surface} · ${r.status} · ${r.error_type ?? 'check logs'}`).join('\n')}` } });
  }
  if (recent.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Recent completions*\n${recent.map((r) => `• ${r.surface} · ${(r.tools_called ?? []).join(', ') || 'reply'} · ${r.total_latency_ms ?? '—'}ms`).join('\n')}` } });
  }
  const warnings = audits.filter((a) => ['runaway_warning', 'blocked', 'failure'].includes(a.event_type)).slice(0, 2);
  if (warnings.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Warnings: ${warnings.map((a) => a.event_type).join(', ')}` }] });
  }
  return blocks.length ? blocks : [{ type: 'section', text: { type: 'mrkdwn', text: '_No running or failed workflows._' } }];
}

function deadlineBlocks(opps) {
  const dated = opps
    .filter((o) => o.close_date && !['awarded', 'declined'].includes(o.stage))
    .sort((a, b) => new Date(a.close_date) - new Date(b.close_date))
    .slice(0, 5);
  if (!dated.length) return [{ type: 'section', text: { type: 'mrkdwn',
    text: '_Nothing due — ask me to *find grants* to fill the pipeline._' } }];
  return dated.map((o) => {
    const days = Math.ceil((new Date(o.close_date) - Date.now()) / 86400000);
    const badge = days < 7 ? `🔴 ${days} days` : days < 21 ? `🟡 ${days} days` : `🟢 ${days} days`;
    return { type: 'section', text: { type: 'mrkdwn',
      text: `${badge} · *${o.title}* — due ${o.close_date instanceof Date ? o.close_date.toISOString().slice(0,10) : o.close_date} · _${o.stage}_` } };
  });
}

function stageBlocks(key, label, opps) {
  const rows = opps.filter((o) => o.stage === key);
  if (!rows.length) return [];
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${label}* (${rows.length})` } },
    ...rows.map((o) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: `• *${o.title}* · ${o.agency ?? ''}${o.canvas_id ? ' · 📄 draft' : ''}` },
      accessory: {
        type: 'static_select',
        action_id: `stage_move:${o.opp_id}`,
        placeholder: { type: 'plain_text', text: 'Move…' },
        options: STAGES.map(([k, l]) => ({ text: { type: 'plain_text', text: l }, value: `${o.opp_id}|${k}` })),
      },
    })),
  ];
}
