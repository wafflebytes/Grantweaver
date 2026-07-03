// Deterministic intent executors (docs/22 §4.3): run AFTER a pending_intents
// row is claimed, OUTSIDE the model's tool loop — no further LLM tool-calling,
// just the specific slow job the confirm card promised. Each kind's executor
// is added by the workstream that owns it; P1.2 wires the mechanism + 'draft'.
// 'revise' is P2.2, 'rescan' is P4.1; 'export_pack'/'answers' are wired by
// P1.3 (exportpack.js imports this module to register them, avoiding a
// circular import from here).
import { db } from '../services/db.js';
import { createDraftCanvas } from '../services/canvas.js';
import { syncOpportunityToList } from '../services/lists.js';
import { draftCard } from '../surfaces/cards.js';
import { grantsGov } from '../mcp/grantsgov-client.js';
import { searchWorkspace, detectSearchMode, expandKeywordQuery } from './rts.js';
import { SYSTEM_PROMPT, renderOrgContext } from '../prompts/system.js';
import { completeOnce } from './llm.js';

const executors = new Map();

export function registerIntentExecutor(kind, fn) {
  executors.set(kind, fn);
}

// Class-A guard (docs/03 §3b, docs/22 §1): pending_intents.params is a
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

registerIntentExecutor('draft', async (client, intent) => {
  const teamId = intent.team_id;
  const { opp_id, notes } = intent.params;
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
  if (!markdown) {
    const post = (t) => client.chat.postMessage({ channel: intent.channel_id, thread_ts: intent.message_ts, text: t });
    const [org, pipeline, opp, oppDetails] = await Promise.all([
      db.getOrg(teamId),
      db.listOpportunities(teamId),
      db.listOpportunities(teamId).then((rows) => rows.find((o) => o.opp_id === String(opp_id))),
      grantsGov.fetchOpportunity(opp_id).catch(() => null),
    ]);
    title = `Letter of Intent — ${opp?.title ?? oppDetails?.title ?? opp_id}`;
    await post('_Searching your workspace for evidence…_');
    const query = notes || `${opp?.title ?? ''} outcomes evidence testimonial`.trim();
    const mode = await detectSearchMode(client, teamId);
    const results = await searchWorkspace(client, {
      query: mode === 'keyword' ? expandKeywordQuery(query) : query, contentTypes: 'messages',
    }).catch(() => []);
    await post('_Drafting…_');
    const system = SYSTEM_PROMPT + renderOrgContext({ org, pipeline, evidenceCount: results.length, contextChannelId: undefined });
    const userMsg = [
      `Draft the Letter of Intent for this opportunity now — you already have everything you need, do not ask questions.`,
      `OPPORTUNITY: ${JSON.stringify(oppDetails ?? opp ?? { opp_id })}`,
      `WORKSPACE EVIDENCE FOUND (cite permalinks exactly as given): ${JSON.stringify(results.slice(0, 8))}`,
      notes ? `EXTRA INSTRUCTIONS: ${notes}` : '',
      'Output ONLY the markdown document, following the Letter of Intent skeleton in your instructions. No preamble.',
    ].filter(Boolean).join('\n\n');
    markdown = await completeOnce([
      { role: 'system', content: system },
      { role: 'user', content: userMsg },
    ], { maxTokens: 3000 });
  }

  const { canvasId, canvasUrl } = await createDraftCanvas(client, {
    title, markdown, channelId: intent.channel_id, userId: intent.requested_by,
  });
  const citations = (markdown.match(/\]\(https?:\/\/[^)]*archives[^)]*\)/g) ?? []).length;
  let opp = null;
  if (opp_id) {
    await db.attachCanvas(teamId, opp_id, canvasId);
    await db.logActivity(teamId, opp_id, { actor: intent.requested_by, kind: 'draft', summary: `Draft created: ${title}` });
    opp = (await db.listOpportunities(teamId)).find((o) => o.opp_id === String(opp_id));
    if (opp) syncOpportunityToList(client, teamId, opp).catch(() => {});
  }
  const checklist = opp?.checklist ?? [];
  const done = checklist.filter((c) => c.done).length;
  await client.chat.postMessage({
    channel: intent.channel_id, thread_ts: intent.message_ts,
    text: `📄 Draft ready: ${title}`,
    blocks: draftCard({ opp: opp ?? { opp_id, title }, canvasUrl, citations, checklistDone: done, checklistTotal: checklist.length }),
  });
});
