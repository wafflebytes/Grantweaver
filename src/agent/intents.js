// Deterministic intent executors: run AFTER a pending_intents
// row is claimed, OUTSIDE the model's tool loop — no further LLM tool-calling,
// just the specific slow job the confirm card promised. Each kind's executor
// registers from the module that owns it: 'draft' lives here;
// 'export_pack'/'answers' register from exportpack.js (it imports this module,
// avoiding a circular import from here); 'revise' and 'rescan' arrive with
// their features.
import { db } from '../services/db.js';
import { ensureOppCanvas, rewriteCanvas } from '../services/canvas.js';
import { syncOpportunityToList } from '../services/lists.js';
import { draftCard } from '../surfaces/cards.js';
import { grantsGov } from '../mcp/grantsgov-client.js';
import { searchWorkspace, detectSearchMode, expandKeywordQuery } from './rts.js';
import { SYSTEM_PROMPT, renderOrgContext } from '../prompts/system.js';
import { completeOnce } from './llm.js';
import { makeThreadStreamer } from './streamer.js';

const executors = new Map();

export function registerIntentExecutor(kind, fn) {
  executors.set(kind, fn);
}

// Content-at-rest guard: pending_intents.params is a
// PERSISTED table column, and a model-drafted document can contain verbatim
// quoted Slack content (citations copy source text exactly, by design). A
// draft generated inside the model's tool call is therefore held HERE,
// in-process only, keyed by intent id — never written to the DB row. If the
// process restarts before confirm, the cache is empty and the draft executor
// falls back to gathering evidence and generating fresh (same code path as a
// button-triggered draft) rather than ever persisting the text.
const draftCache = new Map();
export function stashDraftMarkdown(intentId, { title, markdown }) {
  draftCache.set(intentId, { title, markdown });
}

/** Shared by actions.js (button confirm) and reactions.js (✅-reaction confirm). */
export async function markCardRunning(client, intent) {
  await client.chat.update({
    channel: intent.channel_id, ts: intent.message_ts,
    text: 'Weaving — watch this thread 🧶',
    blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Weaving — watch this thread 🧶' }] }],
  }).catch(() => {});
}

export async function markCardCancelled(client, intent) {
  await client.chat.update({
    channel: intent.channel_id, ts: intent.message_ts,
    text: 'Cancelled — the card above still works whenever you\'re ready.',
    blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: "Cancelled — the card above still works whenever you're ready." }] }],
  }).catch(() => {});
}

/** Runs a claimed intent; never throws — posts an honest apology on failure. */
export async function runIntent(client, intent) {
  const exec = executors.get(intent.kind);
  const post = (text) => client.chat.postMessage({ channel: intent.channel_id, thread_ts: intent.message_ts, text });
  try {
    if (!exec) {
      await post(`I don't have a way to run "${intent.kind}" yet 🧶 — that part of Grantweaver isn't built.`);
      await db.finishIntent(intent.id, 'cancelled');
      return;
    }
    await exec(client, intent);
    await db.finishIntent(intent.id, 'done');
  } catch (e) {
    console.error(`[intent:${intent.kind}]`, e?.message ?? e);
    await post("Something snagged while I was weaving that 🧶 — try confirming again in a moment.").catch(() => {});
    await db.finishIntent(intent.id, 'cancelled');
  }
}

/** Re-read one pinned evidence pointer's exact message live — never from storage. */
async function rereadPinned(client, { c, ts }) {
  try {
    const { messages = [] } = await client.conversations.history({
      channel: c, latest: ts, oldest: ts, inclusive: true, limit: 1,
    });
    const m = messages[0];
    if (!m?.text) return null;
    const { permalink } = await client.chat.getPermalink({ channel: c, message_ts: ts }).catch(() => ({ permalink: '' }));
    return { snippet: m.text, author: m.user ? `<@${m.user}>` : 'teammate', permalink };
  } catch {
    return null;
  }
}

registerIntentExecutor('draft', async (client, intent) => {
  const teamId = intent.team_id;
  const { opp_id, notes, evidence: pinned, sections } = intent.params;
  let title, markdown;
  const stashed = draftCache.get(intent.id);
  if (stashed) {
    ({ title, markdown } = stashed);
    draftCache.delete(intent.id); // one-shot — never lingers past its use
  }

  // Button-triggered drafts (pipelineCard's "Draft proposal") — and any
  // tool-call draft whose in-process stash didn't survive a restart —
  // arrive with no markdown yet, so this executor does the full
  // gather-then-generate itself, single completion, outside the tool loop.
  // Progress goes through the SAME task-timeline stream the main agent loop
  // uses (live-reported: this used to fire two separate permanent chat
  // messages — "_Searching…_", "_Drafting…_" — that just piled up in the
  // thread instead of updating in place like every other action).
  let streamer = null;
  if (!markdown) {
    streamer = makeThreadStreamer({ client, channel: intent.channel_id, thread_ts: intent.message_ts, userId: intent.requested_by, teamId });
    const [org, pipeline, opp, oppDetails] = await Promise.all([
      db.getOrg(teamId),
      db.listOpportunities(teamId),
      db.listOpportunities(teamId).then((rows) => rows.find((o) => o.opp_id === String(opp_id))),
      grantsGov.fetchOpportunity(opp_id).catch(() => null),
    ]);
    title = `Letter of Intent — ${opp?.title ?? oppDetails?.title ?? opp_id}`;
    const searchTaskId = await streamer.task('Searching your workspace for evidence');
    // Change-scope pinned evidence: exact pointers the user picked — re-read
    // live by ts, used alongside (and listed ahead of) the fresh search.
    const pinnedEvidence = (await Promise.all((pinned ?? []).map((p) => rereadPinned(client, p)))).filter(Boolean);
    const query = notes || `${opp?.title ?? ''} outcomes evidence testimonial`.trim();
    const mode = await detectSearchMode(client, teamId);
    const results = await searchWorkspace(client, {
      query: mode === 'keyword' ? expandKeywordQuery(query) : query, contentTypes: ['messages', 'files'], teamId,
    }).catch(() => []);
    await streamer.task('Searched your workspace for evidence', 'completed', searchTaskId);
    const draftTaskId = await streamer.task('Writing the draft');
    const system = SYSTEM_PROMPT + renderOrgContext({ org, pipeline, evidenceCount: pinnedEvidence.length + results.length, contextChannelId: undefined });
    const userMsg = [
      `Draft the Letter of Intent for this opportunity now — you already have everything you need, do not ask questions.`,
      `OPPORTUNITY: ${JSON.stringify(oppDetails ?? opp ?? { opp_id })}`,
      pinnedEvidence.length ? `PINNED EVIDENCE (the user chose these — use them, cite permalinks exactly as given): ${JSON.stringify(pinnedEvidence)}` : '',
      `WORKSPACE EVIDENCE FOUND (cite permalinks exactly as given): ${JSON.stringify(results.slice(0, 8))}`,
      sections?.length ? `EMPHASIZE THESE SECTIONS: ${sections.join(', ')}` : '',
      notes ? `EXTRA INSTRUCTIONS: ${notes}` : '',
      'Output ONLY the markdown document, following the Letter of Intent skeleton in your instructions. No preamble.',
    ].filter(Boolean).join('\n\n');
    markdown = await completeOnce([
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ], { maxTokens: 3000 });
    await streamer.task('Wrote the draft', 'completed', draftTaskId);
  }

  const citations = [...markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]*archives[^)]*)\)/g)];
  let opp = opp_id ? (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp_id)) : null;

  // The canvas is per-opportunity and PERSISTENT — ensureOppCanvas creates it
  // once (on first draft or earlier at add-time) and every later draft/revise
  // regenerates the SAME canvas in place, never a new document.
  const { canvasId, canvasUrl } = await ensureOppCanvas(client, teamId, {
    ...(opp ?? { opp_id, title, channelId: intent.channel_id, userId: intent.requested_by }),
    channelId: intent.channel_id, userId: intent.requested_by,
  });

  if (opp_id) {
    await db.attachCanvas(teamId, opp_id, canvasId);
    await db.setCanvasWritten(teamId, opp_id);
    if ((opp?.checklist ?? []).some((c) => c.id === 'narrative')) {
      await db.toggleChecklistItem(teamId, opp_id, 'narrative', true);
    }
    await db.logActivity(teamId, opp_id, { actor: intent.requested_by, kind: 'draft', summary: `Draft written: ${citations.length} citation${citations.length === 1 ? '' : 's'}` });
    opp = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp_id));
    if (opp) {
      await rewriteCanvas(client, teamId, opp, { draftMd: markdown }).catch((e) => console.warn('[intent:draft] canvas rewrite failed:', e?.data?.error ?? e?.message));
      syncOpportunityToList(client, teamId, opp).catch(() => {});
    }
  } else {
    await rewriteCanvas(client, teamId, { opp_id, title, canvas_id: canvasId }, { draftMd: markdown }).catch((e) => console.warn('[intent:draft] canvas rewrite failed:', e?.data?.error ?? e?.message));
  }
  const checklist = opp?.checklist ?? [];
  const done = checklist.filter((c) => c.done).length;
  const finalBlocks = draftCard({ opp: opp ?? { opp_id, title }, canvasUrl, citations: citations.length, checklistDone: done, checklistTotal: checklist.length });
  if (streamer) {
    await streamer.stop({ blocks: finalBlocks });
  } else {
    await client.chat.postMessage({ channel: intent.channel_id, thread_ts: intent.message_ts, text: `📄 Draft ready: ${title}`, blocks: finalBlocks });
  }
});
