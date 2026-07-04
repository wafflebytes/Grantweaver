// Phase 2 card grammar: primary button (style:
// primary) + up to 2 secondaries + one overflow for the tail. Every card
// with provenance ends with a context line. Pure functions → block arrays,
// same append-only discipline as blocks.js (which stays frozen for legacy
// Phase-1 renders).

export function money(n) { return n ? `$${Number(n).toLocaleString()}` : '—'; }
// DB rows carry close_date as a JS Date object (pg's DATE type); fresh
// grants.gov search results carry it as a plain "MM/DD/YYYY" string.
// Interpolating a Date directly renders its ugly toString() ("Sat May 24
// 2029 18:30:00 GMT+0000 (...)") in a card — normalize display everywhere.
export function fmtDate(v) {
  if (!v) return null;
  // pg DATE columns come back as local-midnight Dates — toISOString() shows
  // the previous day in any UTC+ timezone; use local components instead.
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v);
}
function daysUntil(dateStr) {
  return dateStr ? Math.ceil((new Date(dateStr) - Date.now()) / 86400000) : null;
}
function truncate(s = '', n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function stars(score = 0.5) {
  const n = Math.max(1, Math.min(5, Math.round(score * 5)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function eligibilityBadgeLine(fit) {
  if (!fit?.eligibility_verdict || fit.eligibility_verdict === 'unknown') return null;
  return fit.eligibility_verdict === 'eligible'
    ? `✅ Eligible — ${fit.eligibility_reason ?? ''}`
    : `⚠️ Likely not eligible — ${fit.eligibility_reason ?? ''}`;
}

function fitContextLine(o, fit) {
  if (fit?.fit_score != null) return `Fit ${fit.fit_score}/100 — ${fit.fit_rationale ?? ''}`;
  // Phase-1 fallback: match_score stars when no batched fit assessment yet.
  if (o.match_score != null) return `Match: ${stars(o.match_score)}${o.match_reason ? ` — ${o.match_reason}` : ''}`;
  return null;
}

// ── Grant match ────────────────────────────────────────────────────────
export function grantCardV2(o, { fit } = {}) {
  const days = daysUntil(o.close_date);
  const badge = eligibilityBadgeLine(fit);
  const fitLine = fitContextLine(o, fit);
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `*${o.title}*\n${o.agency ?? ''}\n*Ceiling:* ${money(o.award_ceiling)} · *Closes:* ${fmtDate(o.close_date) ?? 'rolling'}${days != null ? ` (${days} days)` : ''}` } },
    ...(badge ? [{ type: 'section', text: { type: 'mrkdwn', text: badge } }] : []),
    ...(fitLine ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: fitLine }] }] : []),
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', action_id: 'gw:grant:add', value: JSON.stringify({ o: String(o.opp_id) }),
          text: { type: 'plain_text', text: '➕ Add to pipeline' },
          accessibility_label: `Add ${o.title} to the grant pipeline` },
        { type: 'button', action_id: 'gw:grant:details', value: JSON.stringify({ o: String(o.opp_id) }),
          text: { type: 'plain_text', text: 'Full details' },
          accessibility_label: `Show full details for ${o.title}` },
        {
          type: 'overflow', action_id: 'gw:grant:overflow',
          options: [
            { text: { type: 'plain_text', text: 'Why this match?' }, value: JSON.stringify({ o: String(o.opp_id), v: 'gw:grant:why' }) },
            { text: { type: 'plain_text', text: 'Watch' }, value: JSON.stringify({ o: String(o.opp_id), v: 'gw:grant:watch' }) },
            { text: { type: 'plain_text', text: 'Not relevant' }, value: JSON.stringify({ o: String(o.opp_id), v: 'gw:grant:not_relevant' }) },
            { text: { type: 'plain_text', text: 'Share to channel' }, value: JSON.stringify({ o: String(o.opp_id), v: 'gw:grant:share' }) },
            ...(o.url ? [{ text: { type: 'plain_text', text: 'View on Grants.gov' }, value: JSON.stringify({ o: String(o.opp_id), v: 'gw:grant:external' }), url: o.url }] : []),
          ],
        },
      ],
    },
    { type: 'divider' },
  ];
}

export function forecastCard(o, { fit } = {}) {
  const fitLine = fitContextLine(o, fit);
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `*${o.title}*\n${o.agency ?? ''}\n🔮 *Forecast — expected to post ${fmtDate(o.close_date) ?? 'soon'}.* Not open yet.` } },
    ...(fitLine ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: fitLine }] }] : []),
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', action_id: 'gw:grant:watch', value: JSON.stringify({ o: String(o.opp_id) }),
          text: { type: 'plain_text', text: '🔮 Watch' },
          accessibility_label: `Watch ${o.title} for when it opens` },
        { type: 'button', action_id: 'gw:grant:details', value: JSON.stringify({ o: String(o.opp_id) }),
          text: { type: 'plain_text', text: 'Full details' },
          accessibility_label: `Show full details for ${o.title}` },
        {
          type: 'overflow', action_id: 'gw:grant:overflow',
          options: [
            { text: { type: 'plain_text', text: 'Remind me when posted' }, value: JSON.stringify({ o: String(o.opp_id), v: 'gw:grant:watch' }) },
            { text: { type: 'plain_text', text: 'Not relevant' }, value: JSON.stringify({ o: String(o.opp_id), v: 'gw:grant:not_relevant' }) },
          ],
        },
      ],
    },
    { type: 'divider' },
  ];
}

// ── Pipeline opportunity ──────────────────────────────────────────────
export function pipelineCard(opp) {
  const checklist = opp.checklist ?? [];
  const done = checklist.filter((c) => c.done).length;
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `*${opp.title}* · _${opp.stage}_\nOwner: ${opp.owner_user_id ? `<@${opp.owner_user_id}>` : 'unassigned'} · Closes ${fmtDate(opp.close_date) ?? 'rolling'} · Checklist ${done}/${checklist.length}` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', action_id: opp.canvas_id ? 'gw:pipe:canvas' : 'gw:pipe:draft',
          value: JSON.stringify({ o: String(opp.opp_id) }),
          text: { type: 'plain_text', text: opp.canvas_id ? '📄 Open draft' : '✍️ Draft proposal' },
          accessibility_label: opp.canvas_id ? `Open the draft for ${opp.title}` : `Draft a proposal for ${opp.title}` },
        {
          type: 'static_select', action_id: 'gw:pipe:stage',
          placeholder: { type: 'plain_text', text: 'Move…' },
          options: ['suggested', 'reviewing', 'drafting', 'submitted', 'awarded', 'declined'].map((s) => ({
            text: { type: 'plain_text', text: s }, value: JSON.stringify({ o: String(opp.opp_id), stage: s }),
          })),
        },
        {
          type: 'overflow', action_id: 'gw:pipe:overflow',
          options: [
            { text: { type: 'plain_text', text: 'Assign owner' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:pipe:owner' }) },
            { text: { type: 'plain_text', text: 'Open Canvas' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:pipe:canvas' }) },
            { text: { type: 'plain_text', text: 'Export ⋯' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:pipe:export' }) },
            { text: { type: 'plain_text', text: 'Activity' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:pipe:activity' }) },
            { text: { type: 'plain_text', text: 'Remove' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:pipe:remove' }) },
          ],
        },
      ],
    },
  ];
}

// ── Draft / Canvas ─────────────────────────────────────────────────────
export function draftCard({ opp, canvasUrl, citations = 0, checklistDone = 0, checklistTotal = 0 }) {
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `📄 *${opp.title}* — <${canvasUrl}|open canvas>\n${citations} cited source${citations === 1 ? '' : 's'} · checklist ${checklistDone}/${checklistTotal}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '_AI-assisted — review every fact before submission._' }] },
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', url: canvasUrl, action_id: 'gw:draft:open',
          text: { type: 'plain_text', text: 'Open Canvas' }, accessibility_label: `Open the canvas for ${opp.title}` },
        { type: 'button', action_id: 'gw:draft:submit', value: JSON.stringify({ o: String(opp.opp_id) }),
          text: { type: 'plain_text', text: '✅ Mark as submitted' },
          accessibility_label: `Mark the ${opp.title} draft as submitted` },
        { type: 'button', action_id: 'gw:draft:revise', value: JSON.stringify({ o: String(opp.opp_id) }),
          text: { type: 'plain_text', text: 'Request changes' }, accessibility_label: `Request changes to the ${opp.title} draft` },
        {
          type: 'overflow', action_id: 'gw:draft:overflow',
          options: [
            { text: { type: 'plain_text', text: 'Export .md pack' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:export:md' }) },
            { text: { type: 'plain_text', text: 'Copy-ready answers' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:export:answers' }) },
            { text: { type: 'plain_text', text: 'Share to channel' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:export:share' }) },
          ],
        },
      ],
    },
  ];
}

// ── Evidence item ──────────────────────────────────────────────────────
export function evidenceCardV2(ev, { pipeline = [] } = {}) {
  return [
    { type: 'section', text: { type: 'mrkdwn',
      // File hits from RTS carry no channel_id/date (Slack's search API
      // doesn't attribute a file to a channel the way it does a message) —
      // render "📎 file" instead of an empty <#> tag, which used to print
      // literally as "<#>" with nothing inside it.
      text: `🧶 *Evidence — ${ev.tag}* · ${ev.channel_id ? `<#${ev.channel_id}>` : '📎 file'}${ev.date ? ` · ${ev.date}` : ''}\n> ${truncate(ev.snippet, 280)}\n— ${ev.author}${ev.permalink ? ` · <${ev.permalink}|View message>` : ''}` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', action_id: 'gw:ev:save',
          value: JSON.stringify({ c: ev.channel_id, ts: ev.message_ts, tag: ev.tag, link: ev.permalink, f: ev.kind === 'file' || !ev.channel_id }),
          text: { type: 'plain_text', text: '💾 Save as evidence' },
          accessibility_label: 'Save a pointer to this message in the evidence locker' },
        ...(pipeline.length ? [{
          type: 'static_select', action_id: 'gw:ev:link',
          placeholder: { type: 'plain_text', text: 'Link to opportunity…' },
          options: pipeline.slice(0, 10).map((o) => ({
            text: { type: 'plain_text', text: truncate(o.title, 70) },
            value: JSON.stringify({ c: ev.channel_id, ts: ev.message_ts, o: String(o.opp_id) }),
          })),
        }] : []),
        {
          type: 'overflow', action_id: 'gw:ev:overflow',
          options: [
            { text: { type: 'plain_text', text: 'Retag' }, value: JSON.stringify({ c: ev.channel_id, ts: ev.message_ts, v: 'retag' }) },
            { text: { type: 'plain_text', text: 'Strength: weak' }, value: JSON.stringify({ c: ev.channel_id, ts: ev.message_ts, s: 'weak' }) },
            { text: { type: 'plain_text', text: 'Strength: solid' }, value: JSON.stringify({ c: ev.channel_id, ts: ev.message_ts, s: 'solid' }) },
            { text: { type: 'plain_text', text: 'Strength: star' }, value: JSON.stringify({ c: ev.channel_id, ts: ev.message_ts, s: 'star' }) },
            { text: { type: 'plain_text', text: 'Remove' }, value: JSON.stringify({ c: ev.channel_id, ts: ev.message_ts, v: 'remove' }) },
          ],
        },
      ],
    },
  ];
}

// ── Deadline nudge ───────────────────────────────────────────────────
export function deadlineCard(opp, days) {
  const badge = days < 7 ? '🔴' : days < 21 ? '🟡' : '🟢';
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `${badge} *${opp.title}* is due in *${days} day${days === 1 ? '' : 's'}*. Stage: ${opp.stage}.` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', action_id: 'gw:pipe:draft', value: JSON.stringify({ o: String(opp.opp_id) }),
          text: { type: 'plain_text', text: 'Draft now' }, accessibility_label: `Draft ${opp.title} now` },
        { type: 'button', action_id: 'gw:deadline:snooze', value: JSON.stringify({ o: String(opp.opp_id), days: 3 }),
          text: { type: 'plain_text', text: 'Snooze 3d' }, accessibility_label: `Snooze this reminder for ${opp.title} by 3 days` },
        {
          type: 'overflow', action_id: 'gw:deadline:overflow',
          options: [
            { text: { type: 'plain_text', text: 'Mark submitted' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:pipe:stage', stage: 'submitted' }) },
            { text: { type: 'plain_text', text: 'Reassign' }, value: JSON.stringify({ o: String(opp.opp_id), v: 'gw:pipe:owner' }) },
          ],
        },
      ],
    },
  ];
}

// ── Confirm-before-generate ───────────────────────────────────────────
const KIND_LABELS = { draft: 'Draft LOI', revise: 'Revision', export_pack: 'Export pack', answers: 'Copy-ready answers', rescan: 'Workspace rescan' };

export function confirmCard(intent, { summary, etaSeconds }) {
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `🧶 *Ready to weave: ${KIND_LABELS[intent.kind] ?? intent.kind}*\n${summary}` } },
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: `Takes about ${etaSeconds}s — I'll stream progress right here. Confirm with the button or a ✅ reaction.` } ] },
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', action_id: 'gw:intent:confirm', value: JSON.stringify({ i: intent.id }),
          text: { type: 'plain_text', text: '🧶 Weave it' }, accessibility_label: 'Confirm and start generating' },
        { type: 'button', action_id: 'gw:intent:scope', value: JSON.stringify({ i: intent.id }),
          text: { type: 'plain_text', text: 'Change scope' }, accessibility_label: 'Change what will be used to generate this' },
        { type: 'button', style: 'danger', action_id: 'gw:intent:cancel', value: JSON.stringify({ i: intent.id }),
          text: { type: 'plain_text', text: 'Cancel' }, accessibility_label: 'Cancel this request' },
      ],
    },
  ];
}

// ── Onboarding scan summary ───────────────────────────────────────────
export function scanSummaryCard({ index = [], webUrl } = {}) {
  const byTheme = new Map();
  for (const row of index) {
    if (!byTheme.has(row.theme)) byTheme.set(row.theme, []);
    byTheme.get(row.theme).push(row);
  }
  const themeLines = [...byTheme.entries()].map(([theme, rows]) => {
    const hits = rows.reduce((s, r) => s + (r.hits ?? 0), 0);
    const channels = rows.map((r) => `<#${r.channel_id}>`).join(', ');
    return `• *${theme}* — ${hits} hit${hits === 1 ? '' : 's'} across ${channels}`;
  });
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `Here's your evidence index — what your workspace can already prove to a funder. Look right?\n${themeLines.join('\n') || '_Nothing found yet — no problem, we can adjust which channels I read from._'}` } },
    ...(webUrl ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `<${webUrl}|Open the full evidence index>` }] }] : []),
    {
      type: 'actions',
      elements: [
        { type: 'button', style: 'primary', action_id: 'gw:scan:ok', value: '{}',
          text: { type: 'plain_text', text: 'Looks right' }, accessibility_label: 'Confirm the evidence index looks right' },
        { type: 'button', action_id: 'gw:scan:adjust', value: '{}',
          text: { type: 'plain_text', text: 'Adjust' }, accessibility_label: 'Adjust which channels I scan' },
      ],
    },
  ];
}

// ── Proactive: update request ─────────────────────────────────────────
export function updateRequestCard(opp) {
  const days = daysUntil(opp.close_date);
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `✍️ *${opp.title}* has been quiet for a while${days != null ? ` (closes in ${days} days)` : ''}. Where are we?` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'gw:update:status', value: JSON.stringify({ o: String(opp.opp_id), v: 'on_track' }),
          text: { type: 'plain_text', text: 'On track' }, accessibility_label: `Report ${opp.title} as on track` },
        { type: 'button', action_id: 'gw:update:status', value: JSON.stringify({ o: String(opp.opp_id), v: 'stuck' }),
          text: { type: 'plain_text', text: 'Stuck — need help' }, accessibility_label: `Report ${opp.title} as stuck` },
        { type: 'button', action_id: 'gw:pipe:draft', value: JSON.stringify({ o: String(opp.opp_id) }),
          text: { type: 'plain_text', text: 'Draft now' }, accessibility_label: `Draft ${opp.title} now` },
      ],
    },
  ];
}

// ── Share (compact — one link button) ─────────────────────────────────
export function shareCard(entity) {
  const link = entity.canvasUrl ?? entity.url;
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `*${entity.title}*${entity.agency ? `\n${entity.agency}` : ''}` } },
    ...(link ? [{ type: 'actions', elements: [
      { type: 'button', url: link, action_id: 'gw:share:open',
        text: { type: 'plain_text', text: 'Open in Grantweaver' }, accessibility_label: `Open ${entity.title}` },
    ] }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Shared by <@${entity.sharedBy}> from Grantweaver` }] },
  ];
}
