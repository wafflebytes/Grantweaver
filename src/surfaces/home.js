import { db } from '../services/db.js';
import { orgLinkUrl } from '../services/weblink.js';

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
    await db.moveOpportunity(body.team.id, oppId, stage);
    await publishHome(client, body.team.id, body.user.id);
  });
}

export async function publishHome(client, teamId, userId) {
  if (!teamId) teamId = (await client.auth.test()).team_id;
  const [org, opps, evid, meter] = await Promise.all([
    db.getOrg(teamId), db.listOpportunities(teamId), db.listEvidence(teamId, 5), db.impactMeter(teamId),
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
    ]},
    { type: 'section', text: { type: 'mrkdwn',
      text: `*This quarter:* ${meter.surfaced} opportunities surfaced · $${meter.applied.toLocaleString()} applied for · ${meter.evidence} evidence items woven · est. *${meter.hoursSaved} hrs saved*` } },
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: '_Hours-saved math: 2h per draft + 30m per evidence item + 15m per match. Honest heuristic, no magic._' }] },
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
    ...(evid.length
      ? evid.map((e) => ({ type: 'section', text: { type: 'mrkdwn',
          text: `*${e.tag}* · <#${e.channel_id}> · ${new Date(e.saved_at).toLocaleDateString('en-US')}${e.permalink ? ` · <${e.permalink}|view>` : ''}` } }))
      : [{ type: 'section', text: { type: 'mrkdwn',
          text: `_No evidence yet — react :${org?.evidence_emoji ?? 'thread'}: on any impactful message, or ask me to search the workspace._` } }]),
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: 'Grantweaver never stores your messages — evidence items are permalinks, re-read live from Slack when used. · <https://grantweaver.app/support|Support> · <https://grantweaver.app/privacy|Privacy>' }] },
  ];

  await client.views.publish({ user_id: userId, view: { type: 'home', blocks } });
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
