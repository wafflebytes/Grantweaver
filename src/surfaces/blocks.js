export function buildFeedbackBlocks() {
  return [{
    type: 'context_actions',
    elements: [{
      type: 'feedback_buttons',
      action_id: 'feedback',
      positive_button: {
        text: { type: 'plain_text', text: 'Good response' },
        accessibility_label: 'Submit positive feedback on this response',
        value: 'good-feedback',
      },
      negative_button: {
        text: { type: 'plain_text', text: 'Bad response' },
        accessibility_label: 'Submit negative feedback on this response',
        value: 'bad-feedback',
      },
    }],
  }];
}

export function grantCard(o) {
  const days = o.close_date ? Math.ceil((new Date(o.close_date) - Date.now()) / 86400000) : null;
  const ceiling = o.award_ceiling ? `$${Number(o.award_ceiling).toLocaleString()}` : '—';
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `*${o.title}*\n${o.agency ?? ''}\n*Ceiling:* ${ceiling} · *Closes:* ${o.close_date ?? 'rolling'}${days != null ? ` (${days} days)` : ''}${o.synopsis ? `\n_${String(o.synopsis).slice(0, 200)}…_` : ''}` } },
    ...(o.match_reason ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `Match: ${stars(o.match_score)} — ${o.match_reason}` }] }] : []),
    { type: 'actions', elements: [
      { type: 'button', style: 'primary', action_id: 'pipeline_add', value: String(o.opp_id),
        text: { type: 'plain_text', text: '➕ Add to pipeline' },
        accessibility_label: `Add ${o.title} to the grant pipeline` },
      { type: 'button', action_id: 'opp_details', value: String(o.opp_id),
        text: { type: 'plain_text', text: 'Full details' },
        accessibility_label: `Show full details for ${o.title}` },
      ...(o.url ? [{ type: 'button', url: o.url,
        text: { type: 'plain_text', text: 'View on Grants.gov' },
        accessibility_label: 'Open this opportunity on Grants.gov' }] : []),
    ]},
    { type: 'divider' },
  ];
}

export function evidenceCard(ev) {
  // ev comes fresh from RTS THIS TURN — rendered, never persisted.
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `🧶 *Evidence — ${ev.tag}* · <#${ev.channel_id}> · ${ev.date}\n> ${truncate(ev.snippet, 280)}\n— ${ev.author}${ev.permalink ? ` · <${ev.permalink}|View message>` : ''}` } },
    { type: 'actions', elements: [
      { type: 'button', style: 'primary', action_id: 'evidence_save',
        value: JSON.stringify({ c: ev.channel_id, ts: ev.message_ts, tag: ev.tag, link: ev.permalink }),
        text: { type: 'plain_text', text: '💾 Save as evidence' },
        accessibility_label: 'Save a pointer to this message in the evidence locker' },
    ]},
  ];
}

export function draftReadyBlocks({ title, canvasUrl, citations }) {
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: `📄 *Draft ready:* <${canvasUrl}|${title}>\n_${citations} cited workspace source${citations === 1 ? '' : 's'} · AI-assisted — please review every fact before submission._` } },
  ];
}

export function helpBlocks() {
  return [
    { type: 'section', text: { type: 'mrkdwn',
      text: '*🧶 Grantweaver* — turn your conversations into funding.\n• Open my *agent panel* (✨ icon, top nav → Grantweaver) and try:\n   – _Find new grants that fit our mission_\n   – _What impact evidence do we have?_\n   – _Draft an LOI for our top opportunity_\n• `/grantweaver setup` — org profile & digest channel\n• `/grantweaver digest` — post this week\'s digest now\n• `/grantweaver clear` — clear my messages from this DM (run it in your DM with me)\n• React with :thread: on any impactful message to save it as evidence' } },
    { type: 'context', elements: [{ type: 'mrkdwn',
      text: '<https://grantweaver.app/support|Support> · <https://grantweaver.app/privacy|Privacy> · I never store your messages — pointers only.' }] },
  ];
}

function stars(score = 0.5) {
  const n = Math.max(1, Math.min(5, Math.round(score * 5)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}
function truncate(s = '', n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
