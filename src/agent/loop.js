import { buildToolbelt, TOOL_SCHEMAS } from './tools.js';
import { SYSTEM_PROMPT, renderOrgContext } from '../prompts/system.js';
import { buildFeedbackBlocks } from '../surfaces/blocks.js';
import { db } from '../services/db.js';
import { fetchRecentHistory } from './memory.js';
import { getLlm, withRetry, MODEL, MAX_TOKENS } from './llm.js';

export { completeOnce } from './llm.js';

// Task-timeline labels per tool — texture for streamed turns.
const TASK_LABELS = {
  search_workspace: 'Searching your workspace',
  search_grants: 'Checking Grants.gov',
  get_opportunity_details: 'Reading the full notice',
  pipeline: 'Updating your pipeline',
  create_draft_canvas: 'Writing the draft',
  watch: 'Setting up the watch',
  rescan_workspace: 'Rebuilding your evidence index',
};

const MAX_TURNS = 8;
const STRENGTH_RANK = { star: 0, solid: 1, weak: 2 };

// TOOL_SCHEMAS stay in our internal {name, description, input_schema} shape;
// adapt once here to the OpenAI function-tool wire format.
const OPENAI_TOOLS = TOOL_SCHEMAS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// The `action_token` behind Slack RTS has a ~45-135s TTL that starts ticking
// the moment the Slack message event fires. The model's own FIRST completion
// call competes for that same budget before it ever decides to call
// search_workspace — evidence-first tool ordering alone isn't enough to beat
// it (live-confirmed twice). So for evidence-shaped turns we fire
// search_workspace ourselves, synchronously, before the first LLM call, while
// the token is guaranteed freshest — then hand the model pre-fetched results
// instead of making it spend its first turn deciding to ask for them.
const EVIDENCE_INTENT = /\b(evidence|impact|attendance|gpa|grade|metric|story|stories|testimonial|workspace|mentee|mentees|outcome|outcomes|survey|beneficiar|program update|draft|loi|letter of intent|proposal|report|funder|grant report|cite|citation)\b/i;

export function looksEvidenceShaped(text) {
  return EVIDENCE_INTENT.test(text ?? '');
}

export async function runAgentTurn(ctx) {
  const toolbelt = buildToolbelt(ctx);

  // Pre-classification fast path: fire the RTS call FIRST,
  // in parallel with the DB context lookups below — every sequential await
  // ahead of it (org/pipeline/evidence reads, Slack API round-trips) burns
  // into the action_token's ~45-135s TTL before the LLM even sees the turn.
  const wantsEvidence = Boolean(ctx.actionToken && looksEvidenceShaped(ctx.userText));
  const prefetchPromise = wantsEvidence
    ? toolbelt.search_workspace({ query: ctx.userText }).catch((e) => {
        console.warn('[loop] evidence pre-fetch failed, leaving it to the model:', e?.message ?? e);
        return null;
      })
    : Promise.resolve(null);

  // The mention path (surface: 'channel') pre-fetches thread history itself
  // (memory.js's fetchThreadHistory, multi-speaker prefixed) and hands it in
  // via ctx.history — the loop must not know or care which surface it's on.
  // The DM path (surface: 'dm') still fetches its own short window here.
  const historyPromise = ctx.history
    ? Promise.resolve(ctx.history)
    : (ctx.client && ctx.channelId)
      ? fetchRecentHistory(ctx.client, ctx.channelId, ctx.botUserId, ctx.messageTs).catch((e) => {
          console.warn('[loop] recent-history fetch failed, continuing turn-less:', e?.message ?? e);
          return [];
        })
      : Promise.resolve([]);

  const [org, pipeline, evidenceCount, evidenceIndex, prefetch, history] = await Promise.all([
    ctx.teamId ? db.getOrg(ctx.teamId) : null,
    ctx.teamId ? db.listOpportunities(ctx.teamId) : [],
    ctx.teamId ? db.countEvidence(ctx.teamId) : 0,
    ctx.teamId ? db.listIndex(ctx.teamId) : [],
    prefetchPromise,
    historyPromise,
  ]);
  const evidenceThemes = Object.values(
    evidenceIndex.reduce((acc, row) => {
      const cur = acc[row.theme] ?? { theme: row.theme, hits: 0, strength: row.strength };
      cur.hits += row.hits ?? 0;
      if (STRENGTH_RANK[row.strength] < STRENGTH_RANK[cur.strength]) cur.strength = row.strength;
      acc[row.theme] = cur;
      return acc;
    }, {})
  );

  const system = SYSTEM_PROMPT + renderOrgContext({ org, pipeline, evidenceCount, evidenceThemes, contextChannelId: ctx.contextChannelId });
  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: ctx.userText },
  ];

  let streamer;
  const getStreamer = () => (streamer ??= ctx.makeStreamer());

  let toolCalls = 0;
  if (prefetch) {
    toolCalls++;
    // An empty prefetch usually means the user's raw message was a poor
    // search query (drafting instructions, not an evidence question) — in
    // that case the model MUST re-search immediately, before the short-lived
    // search credential expires, not after other tools have burned it.
    const guidance = prefetch.count > 0
      ? 'do NOT call search_workspace again unless these results are clearly insufficient for the question.'
      : 'it found NOTHING — the raw message was probably a poor search query. If you need workspace evidence, call search_workspace with a better-phrased query as your VERY FIRST tool call, right now, before any other tool: the search credential expires within about a minute and a re-search after other tool calls will fail.';
    messages.push({
      role: 'system',
      content: `Workspace evidence was already fetched for you immediately on message receipt, to beat the search credential's short TTL — ${guidance} Pre-fetched results (search_mode: ${prefetch.search_mode}, count: ${prefetch.count}):\n${safeJson(prefetch, 8000)}`,
    });
  }

  try {
    return await runTurnLoop();
  } catch (e) {
    // Live-caught: an LLM call throwing here (timeout, network error) with
    // no catch left an already-started stream open forever — Slack showed
    // "streaming_state: in_progress" with empty text, no message, no error,
    // indefinitely. The caller's own try/catch (mention.js/assistant.js)
    // posts a NEW separate error message, but never closes THIS stream, so
    // both a zombie blank message and a real one would exist side by side.
    // Close it out here with something honest before re-throwing.
    console.error('[loop] turn failed:', e?.message ?? e);
    if (streamer) {
      await getStreamer().append({ markdown_text: "Something snagged mid-turn 🧶 — the model or a tool call didn't come back in time. Try again in a moment." }).catch(() => {});
      await getStreamer().stop({}).catch(() => {});
    }
    throw e;
  }

  async function runTurnLoop() {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response = await withRetry(() =>
      getLlm().chat.completions.create({
        model: MODEL, max_tokens: MAX_TOKENS, temperature: 0.2,
        tools: OPENAI_TOOLS, messages,
      })
    );

    // The model's internal reasoning competes with its answer AND its tool
    // calls for the same max_tokens budget, non-deterministically — a
    // length-truncated completion with no tool_calls can look exactly like a
    // finished answer (e.g. narrating "Queued the draft" without ever emitting
    // the create_draft_canvas call). Detect it and re-run the SAME turn once
    // with real headroom rather than shipping a silently-degraded reply.
    if (response.choices[0].finish_reason === 'length' && !(response.choices[0].message.tool_calls ?? []).length) {
      console.warn('[loop] completion truncated by reasoning budget — retrying turn with headroom');
      response = await withRetry(() =>
        getLlm().chat.completions.create({
          model: MODEL, max_tokens: Math.max(MAX_TOKENS * 2, 14000), temperature: 0.2,
          tools: OPENAI_TOOLS, messages,
        })
      );
    }

    const msg = response.choices[0].message;
    const toolUses = msg.tool_calls ?? [];

    if (toolUses.length === 0) {
      const finalText = (msg.content ?? '').trim()
        || 'Done! Anything else I can weave for you? 🧶';
      for (const chunk of chunkMarkdown(finalText, 400)) {
        await getStreamer().append({ markdown_text: chunk });
      }
      await getStreamer().stop({ blocks: buildFeedbackBlocks() });
      return { title: inferTitle(ctx.userText), toolCalls };
    }

    messages.push(msg);
    for (const tu of toolUses) {
      toolCalls++;
      const label = TASK_LABELS[tu.function.name];
      const taskId = label ? await getStreamer().task(label, 'in_progress').catch(() => null) : null;
      let result;
      try {
        const exec = toolbelt[tu.function.name];
        const input = JSON.parse(tu.function.arguments || '{}');
        result = exec ? await exec(input) : { error: `Unknown tool ${tu.function.name}` };
        if (label) await getStreamer().task(label, 'complete', taskId).catch(() => {});
      } catch (e) {
        console.error(`[tool:${tu.function?.name}]`, e?.message ?? e);
        result = { error: `Tool "${tu.function?.name}" failed: ${e?.message ?? 'unknown error'}. Explain this gracefully to the user and offer a retry or an alternative path.` };
        if (label) await getStreamer().task(label, 'error', taskId).catch(() => {});
      }
      messages.push({
        role: 'tool',
        tool_call_id: tu.id,
        content: safeJson(result, 30000),
      });
    }
  }

  await getStreamer().append({ markdown_text: "That one took more steps than I allow myself 🧶 — here's where I got to. Say *continue* and I'll pick it right up." });
  await getStreamer().stop({ blocks: buildFeedbackBlocks() });
  return { title: inferTitle(ctx.userText), toolCalls };
  }
}

function safeJson(obj, cap) {
  try { const s = JSON.stringify(obj); return s.length > cap ? s.slice(0, cap) + '…(truncated)' : s; }
  catch { return String(obj).slice(0, cap); }
}

export function chunkMarkdown(text, size) {
  const out = []; let buf = '';
  for (const line of text.split('\n')) {
    if (buf && (buf + line).length > size) { out.push(buf); buf = ''; }
    buf += line + '\n';
  }
  if (buf.trim()) out.push(buf);
  return out.length ? out : [text];
}

export function inferTitle(text) {
  const t = (text ?? '').trim().replace(/\s+/g, ' ');
  return t.length > 48 ? `${t.slice(0, 45)}…` : t || 'Grantweaver chat';
}
