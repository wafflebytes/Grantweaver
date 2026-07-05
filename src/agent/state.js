const FORBIDDEN = new Set(['text', 'snippet', 'content', 'message', 'file_content', 'raw']);

export function stateKey(ctx) {
  return { teamId: ctx.teamId, channelId: ctx.channelId, threadTs: ctx.surface === 'dm' ? '' : (ctx.threadTs ?? ctx.messageTs ?? '') };
}

export function sanitizeStatePatch(patch = {}) {
  const clean = JSON.parse(JSON.stringify(patch ?? {}));
  scrub(clean);
  if (clean.summary && clean.summary.length > 1500) clean.summary = `${clean.summary.slice(0, 1497)}...`;
  return clean;
}

export function summarizeForState({ previous = '', userText = '', finalText = '', toolNames = [], artifacts = [], sources = [] }) {
  const bits = [];
  if (previous) bits.push(previous);
  if (userText) bits.push(`User asked: ${safeSentence(userText)}`);
  if (toolNames.length) bits.push(`Tools used: ${[...new Set(toolNames)].join(', ')}`);
  if (artifacts.length) bits.push(`Artifacts: ${artifacts.map((a) => a.summary || a.type).filter(Boolean).slice(-3).join('; ')}`);
  if (sources.length) bits.push(`Source pointers: ${sources.length}`);
  if (finalText) bits.push(`Grantweaver replied with ${safeSentence(finalText).slice(0, 160)}`);
  return bits.join(' | ').slice(-1500);
}

export function deriveStatePatch({ ctx, previousState, finalText = '', toolNames = [], toolResults = [] }) {
  const artifacts = [];
  const sources = [];
  const decisions = [];
  for (const r of toolResults.filter(Boolean)) {
    if (r.evidenceListUrl) artifacts.push({ type: 'list', id: r.evidenceListUrl, url: r.evidenceListUrl, summary: 'Updated Evidence Locker list' });
    if (r.watch?.id) artifacts.push({ type: 'watch', id: String(r.watch.id), summary: `Created ${r.watch.kind} watch` });
    if (r.queued) artifacts.push({ type: 'message', id: 'confirmation', summary: 'Posted confirmation card' });
    for (const ev of r.results ?? r.pointers ?? []) {
      if (ev.permalink) sources.push({ channel_id: ev.channel_id ?? '', message_ts: ev.message_ts ?? '', permalink: ev.permalink, label: ev.tag ?? ev.tag_hint ?? 'evidence pointer' });
    }
    if (r.stage && r.opp_id) decisions.push({ at: new Date().toISOString(), by: ctx.userId ?? 'agent', summary: `Moved opportunity ${r.opp_id} to ${r.stage}` });
    if (r.added) decisions.push({ at: new Date().toISOString(), by: ctx.userId ?? 'agent', summary: `Added opportunity to pipeline: ${r.added}` });
  }
  const goal = inferGoal(ctx.userText, previousState?.goal);
  return sanitizeStatePatch({
    surface: ctx.surface,
    user_id: ctx.userId,
    goal,
    constraints: { evidence_policy: 'cite_permalinks', ...(ctx.contextChannelId ? { channel_scope: [ctx.contextChannelId] } : {}) },
    decisions,
    artifacts,
    sources,
    summary: summarizeForState({ previous: previousState?.summary, userText: ctx.userText, finalText, toolNames, artifacts, sources }),
    last_user_message_ts: ctx.messageTs ?? null,
  });
}

export function renderStateForPrompt(state) {
  if (!state) return '';
  const decisions = (state.decisions ?? []).slice(-3).map((d) => `- ${d.summary}`).join('\n');
  const artifacts = (state.artifacts ?? []).slice(-3).map((a) => `- ${a.type}:${a.id} ${a.summary ?? ''}`).join('\n');
  const sources = (state.sources ?? []).slice(-5).map((s) => `- ${s.label ?? 'source'} ${s.permalink ?? ''}`).join('\n');
  return `\n## Current conversation state (privacy-safe metadata)\nGoal: ${state.goal ?? 'unknown'}\nSummary: ${state.summary ?? 'none'}\nConstraints: ${JSON.stringify(state.constraints ?? {})}\nRecent decisions:\n${decisions || '- none'}\nArtifacts:\n${artifacts || '- none'}\nSource pointers only (re-read live before citing):\n${sources || '- none'}\n`;
}

function scrub(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value.forEach(scrub);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) delete value[key];
    else scrub(value[key]);
  }
}

function safeSentence(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function inferGoal(text, fallback) {
  const t = String(text ?? '').toLowerCase();
  if (/\bdraft|loi|proposal|application|report\b/.test(t)) return 'Draft or revise grant materials';
  if (/\bevidence|impact|metric|testimonial|story|outcome\b/.test(t)) return 'Find and manage impact evidence';
  if (/\bgrant|funding|opportunit|deadline\b/.test(t)) return 'Find and manage grant opportunities';
  if (/\bwatch|alert|notify\b/.test(t)) return 'Monitor grant opportunities';
  return fallback ?? null;
}

