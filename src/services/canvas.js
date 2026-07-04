import { db } from './db.js';

// Every opportunity canvas carries EXACTLY these H2 sections, in this order,
// forever — the whole document is regenerated in place by rewriteCanvas, so
// the headings are a rendering contract, not lookup targets.
const SECTION_HEADINGS = ['Overview', 'Requirements', 'Draft', 'Evidence', 'Activity'];

function money(n) { return n ? `$${Number(n).toLocaleString()}` : '—'; }
// Same Date-vs-string inconsistency as cards.js — DB rows carry close_date
// as a JS Date; interpolating it directly renders its ugly toString().
function fmtDate(v) {
  if (!v) return null;
  // pg DATE columns come back as local-midnight Dates — toISOString() shows
  // the previous day in any UTC+ timezone; use local components instead.
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v);
}

function overviewMarkdown(opp) {
  const fit = opp.fit_score != null ? `\nFit: ${opp.fit_score}/100 — ${opp.fit_rationale ?? ''}` : '';
  return [
    `**Agency:** ${opp.agency ?? '—'}`,
    `**Number:** ${opp.opp_number ?? opp.opp_id ?? '—'}`,
    `**Closes:** ${fmtDate(opp.close_date) ?? 'rolling'}  ·  **Ceiling:** ${money(opp.award_ceiling)}`,
    `**Owner:** ${opp.owner_user_id ? `<@${opp.owner_user_id}>` : 'unassigned'}`,
    fit,
  ].filter(Boolean).join('\n');
}

function requirementsMarkdown(checklist) {
  if (!checklist?.length) return '_(pending — I\'ll fill this in once I\'ve reviewed the opportunity)_';
  return checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.label}${c.detail ? ` — ${c.detail}` : ''}`).join('\n');
}

function activityMarkdown(rows) {
  if (!rows?.length) return '_(nothing yet)_';
  return rows.map((r) => `- ${r.at instanceof Date ? r.at.toISOString().slice(0, 10) : String(r.at).slice(0, 10)} — ${r.summary}`).join('\n');
}

function skeletonMarkdown(opp) {
  return [
    '## Overview', overviewMarkdown(opp),
    '## Requirements', requirementsMarkdown(opp.checklist),
    '## Draft', '_Not started — ask me to draft when ready._',
    '## Evidence', '_(none cited yet)_',
    '## Activity', '_(nothing yet)_',
  ].join('\n\n');
}

/** Creates the opp's canvas once; every later call returns the SAME canvas — never a second one per opp. */
export async function ensureOppCanvas(client, teamId, opp) {
  if (opp.canvas_id) {
    const canvasUrl = await rebuildCanvasUrl(client, opp.canvas_id);
    return { canvasId: opp.canvas_id, canvasUrl };
  }
  const { canvasId, canvasUrl } = await createCanvas(client, {
    title: opp.title, markdown: skeletonMarkdown(opp), channelId: opp.channelId, userId: opp.userId,
  });
  await db.setCanvasId(teamId, opp.opp_id, canvasId);
  await db.logActivity(teamId, opp.opp_id, { actor: 'agent', kind: 'note', summary: 'Canvas created' });
  return { canvasId, canvasUrl };
}

// Last Draft-section markdown WE wrote, per (team, opp). Same content-at-rest
// rule as the intent draft stash: a draft quotes Slack content verbatim by
// design, so this lives in-process ONLY, never the DB. After a restart it's
// empty — rewriteCanvas then refuses to touch a canvas whose draft it can't
// reproduce, rather than ever clobbering the team's document.
const lastDraftByOpp = new Map();
export function rememberDraft(teamId, oppId, markdown) {
  lastDraftByOpp.set(`${teamId}:${oppId}`, markdown);
}
export function recallDraft(teamId, oppId) {
  return lastDraftByOpp.get(`${teamId}:${oppId}`) ?? null;
}

function evidenceMarkdown(draftMd) {
  const citations = [...String(draftMd ?? '').matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]*archives[^)]*)\)/g)];
  return citations.length ? citations.map((m) => `- [${m[1]}](${m[2]})`).join('\n') : '_(none cited yet)_';
}

function fullMarkdown(opp, { draftMd, activityRows }) {
  return [
    '## Overview', overviewMarkdown(opp),
    '## Requirements', requirementsMarkdown(opp.checklist),
    '## Draft', draftMd ?? '_Not started — ask me to draft when ready._',
    '## Evidence', evidenceMarkdown(draftMd),
    '## Activity', activityMarkdown(activityRows),
  ].join('\n\n');
}

/**
 * Regenerate the ENTIRE canvas from DB truth + the in-process draft copy, in
 * one canvases.edit whole-document replace. Section-targeted editing is a
 * dead end (live-confirmed): sections.lookup matches only the heading BLOCK,
 * a replace on it destroys the heading and orphans the old body paragraphs
 * below as duplicates, and there is no way to enumerate or read body blocks.
 * Branch B makes full regeneration safe — every section is derivable from the
 * DB except Draft, which we hold in-process (rememberDraft) from the moment
 * we write it. The one guarded case: a draft exists on the canvas but this
 * process never wrote it (restart) — then we SKIP rather than clobber it.
 */
export async function rewriteCanvas(client, teamId, opp, { draftMd } = {}) {
  if (!opp?.canvas_id) return false;
  const draft = draftMd ?? recallDraft(teamId, opp.opp_id);
  if (!draft && opp.canvas_written_at) {
    console.warn(`[canvas] skip rewrite of ${opp.canvas_id} — draft exists but no in-process copy (restart?)`);
    return false;
  }
  const activityRows = await db.listActivity(teamId, opp.opp_id, 10).catch(() => []);
  await client.apiCall('canvases.edit', {
    canvas_id: opp.canvas_id,
    changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown: sanitizeCanvasMarkdown(fullMarkdown(opp, { draftMd: draft, activityRows })) } }],
  });
  if (draftMd) rememberDraft(teamId, opp.opp_id, draftMd);
  return true;
}

/**
 * Branch B means Overview/Requirements are agent-owned and safe to
 * regenerate from DB truth any time (unlike Draft, which only changes via
 * the revision flow) — call this after anything that changes owner/fit/
 * checklist/stage on an opp that already has a canvas.
 */
export async function refreshOverviewAndRequirements(client, teamId, opp) {
  return rewriteCanvas(client, teamId, opp);
}

/** Refresh the Activity section from the DB's own trail (our own wording, never Slack content). */
export async function appendActivity(client, canvasId, teamId, oppId) {
  const opp = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(oppId));
  return rewriteCanvas(client, teamId, opp);
}

/**
 * BRANCH B (live-confirmed):
 * there is no live path to read a canvas's document body back — files.info
 * carries only metadata/title, assistant.search.context needs a fresh
 * per-turn action_token unavailable to background jobs, canvases.export
 * doesn't exist. We therefore never attempt to reconcile human edits to the
 * Draft section automatically; Draft only changes via the human-approved
 * revision-thread flow. This function stays as the seam a future read API
 * would plug into.
 */
export async function readCanvas() {
  return null;
}

async function rebuildCanvasUrl(client, canvasId) {
  const { team } = await client.team.info();
  const host = team.enterprise_domain ? `${team.enterprise_domain}.enterprise.slack.com` : `${team.domain}.slack.com`;
  return `https://${host}/docs/${team.id}/${canvasId}`;
}

async function createCanvas(client, { title, markdown, channelId, userId }) {
  const safeMarkdown = sanitizeCanvasMarkdown(markdown);
  const created = await client.apiCall('canvases.create', {
    title,
    document_content: { type: 'markdown', markdown: safeMarkdown },
  });
  const canvasId = created.canvas_id;

  // canvases.access.set's channel_ids only accepts real channels (C…) — under
  // agent_view every conversation is a DM (D…), which the API rejects
  // (invalid_arguments), so grant access to the user directly in that case.
  const isChannel = /^[C]/.test(channelId ?? '');
  await client.apiCall('canvases.access.set', {
    canvas_id: canvasId,
    access_level: 'write',
    ...(isChannel ? { channel_ids: [channelId] } : { user_ids: [userId] }),
  }).catch((e) => console.warn('[canvas:access]', e?.data?.error ?? e.message));

  const canvasUrl = await rebuildCanvasUrl(client, canvasId);
  return { canvasId, canvasUrl };
}

/** Kept for callers that want a one-shot canvas outside the per-opp model (none currently — exported for test parity/back-compat). */
export async function createDraftCanvas(client, { title, markdown, channelId, userId }) {
  return createCanvas(client, { title, markdown, channelId, userId });
}

/** Canvas markdown is stricter than GitHub-flavored — normalize the common gaps. */
export function sanitizeCanvasMarkdown(md) {
  let s = String(md).trim();

  // Live-confirmed (F7): Slack itself renders the canvas's `title` param as
  // the document's own leading H1 when you read the canvas back — so ANY
  // leading H1 the model writes doubles it, even when the wording doesn't
  // match verbatim ("# LOI — X" from Slack, "# Letter of Intent — X" from the
  // model). Strip unconditionally rather than requiring an exact-text match.
  const leadingH1 = s.match(/^#\s+.+?\s*\n+/);
  if (leadingH1) {
    s = s.slice(leadingH1[0].length).trimStart();
  }

  return s
    .replace(/^(#{4,})\s/gm, '### ')      // canvases: max 3 heading levels
    .trim();
}

export { SECTION_HEADINGS, skeletonMarkdown, requirementsMarkdown };
