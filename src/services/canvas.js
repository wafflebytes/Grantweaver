import { db } from './db.js';

// Every opportunity canvas is created with EXACTLY these H2 sections, in this
// order, forever — canvases.sections.lookup finds them by heading text, so
// the headings themselves are a contract the agent may never restructure.
const SECTION_HEADINGS = ['Overview', 'Requirements', 'Draft', 'Evidence', 'Activity'];

function money(n) { return n ? `$${Number(n).toLocaleString()}` : '—'; }

function overviewMarkdown(opp) {
  const fit = opp.fit_score != null ? `\nFit: ${opp.fit_score}/100 — ${opp.fit_rationale ?? ''}` : '';
  return [
    `**Agency:** ${opp.agency ?? '—'}`,
    `**Number:** ${opp.opp_number ?? opp.opp_id ?? '—'}`,
    `**Closes:** ${opp.close_date ?? 'rolling'}  ·  **Ceiling:** ${money(opp.award_ceiling)}`,
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

/** Replace one H2 section's body. Looks the section up by heading text every call (ids aren't cached — cheap, and survives a human reordering nothing since headings are a contract). */
export async function editSection(client, canvasId, heading, markdown) {
  const sectionId = await lookupSection(client, canvasId, heading);
  if (!sectionId) return false;
  await client.apiCall('canvases.edit', {
    canvas_id: canvasId,
    changes: [{ operation: 'replace', section_id: sectionId, document_content: { type: 'markdown', markdown } }],
  });
  return true;
}

/** Batch multiple section replacements into ONE canvases.edit call (rate-budget friendly). */
export async function editSections(client, canvasId, sectionsByHeading) {
  const changes = [];
  for (const [heading, markdown] of Object.entries(sectionsByHeading)) {
    const sectionId = await lookupSection(client, canvasId, heading);
    if (sectionId) changes.push({ operation: 'replace', section_id: sectionId, document_content: { type: 'markdown', markdown } });
  }
  if (!changes.length) return false;
  await client.apiCall('canvases.edit', { canvas_id: canvasId, changes });
  return true;
}

/** No live per-section append method exists — replace the whole Activity section from the DB's own trail (our own wording, never Slack content). */
export async function appendActivity(client, canvasId, teamId, oppId) {
  const rows = await db.listActivity(teamId, oppId, 10);
  return editSection(client, canvasId, 'Activity', activityMarkdown(rows));
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

async function lookupSection(client, canvasId, heading) {
  try {
    const { sections } = await client.apiCall('canvases.sections.lookup', {
      canvas_id: canvasId,
      criteria: { contains_text: heading },
    });
    return sections?.[0]?.id ?? null;
  } catch (e) {
    console.warn('[canvas:lookup]', e?.data?.error ?? e.message);
    return null;
  }
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
